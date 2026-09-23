// POST /api/live-activity/register — start a Beach Session Live Activity, or
// rotate/re-upload its push token (docs/LIVE_ACTIVITY_PLAN.md Phase 3, "one
// D1 row per activity"). Body:
//   { deviceId, activityId, slug, pushToken, schemaVersion, appBuild?, apnsEnvironment? }
//
// Native app only (like the trial/unlock routes), rate limited the same way
// as /api/devices/unlock. Requires the device to be entitled AND have an
// ACTIVE armed presence for `slug` right now — the same `listArmed()` gate
// lib/alerts/run.ts uses for the ordinary alert engine, so a Live Activity
// can never register for a beach the device isn't actually armed at.
//
// `expiresAt` is the earliest of: the armed presence's own expiry, start +
// 8h (ActivityKit's own hard ceiling), and the device's entitlement expiry.
//
// One active Live Activity session per device: any OTHER active row for this
// device is ended first (a rotation of the SAME activityId is not "another"
// row — upsertLiveActivity replaces its token atomically instead).
//
// The push token is a bearer capability for this one activity. It must never
// appear in the response body or in a log line — this route never echoes it
// back and never puts the parsed body into a `console.error`.

import { badRequest, fail, isDeviceId, readBody } from "@/lib/db/api";
import { getStore } from "@/lib/db/store";
import { requireInstallToken } from "@/lib/db/installTokenAuth";
import { getLocation } from "@/config/locations";
import { isNativeRequest } from "@/lib/nativeRequest";
import { checkRateLimit, clientIp } from "@/lib/plus/rateLimit";
import { LIVE_ACTIVITY_MAX_SESSION_MS } from "@/lib/liveActivity/server/decide";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_ATTEMPTS = 30;
const WINDOW_MS = 5 * 60 * 1000;

const ACTIVITY_ID_RE = /^[A-Za-z0-9_:.-]{8,128}$/;
/** ActivityKit update tokens are hex-encoded, like APNs device tokens —
 *  generous length bounds (Apple doesn't publish a fixed size). */
const PUSH_TOKEN_RE = /^[0-9a-fA-F]{32,200}$/;

function isActivityId(v: unknown): v is string {
  return typeof v === "string" && ACTIVITY_ID_RE.test(v);
}
function isPushToken(v: unknown): v is string {
  return typeof v === "string" && PUSH_TOKEN_RE.test(v);
}

function tooManyAttempts(retryAfterSec: number): Response {
  return Response.json(
    { ok: false, error: "too-many-attempts" },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
  );
}

export async function POST(req: Request): Promise<Response> {
  // App only: a Live Activity is delivered inside the phone app, same rule
  // as the trial and unlock routes.
  if (!isNativeRequest(req)) return fail("app-only", 403);

  const body = await readBody(req);
  if (!body || !isDeviceId(body.deviceId)) return badRequest();
  if (!isActivityId(body.activityId)) return badRequest();
  if (typeof body.slug !== "string" || !body.slug || !getLocation(body.slug)) return badRequest();
  if (!isPushToken(body.pushToken)) return badRequest();
  if (typeof body.schemaVersion !== "number" || !Number.isFinite(body.schemaVersion)) return badRequest();
  const appBuild = typeof body.appBuild === "string" ? body.appBuild.slice(0, 64) : null;
  const apnsEnvironment =
    body.apnsEnvironment === "sandbox" || body.apnsEnvironment === "production"
      ? body.apnsEnvironment
      : null;
  // The native plugin's own monotonic per-activity counter (Codex review #4)
  // — optional for now (an app build that predates this field omits it, and
  // is accepted unconditionally); when present it must be a non-negative
  // integer.
  const rotation =
    body.rotation === undefined
      ? null
      : typeof body.rotation === "number" && Number.isInteger(body.rotation) && body.rotation >= 0
        ? body.rotation
        : "invalid";
  if (rotation === "invalid") return badRequest();

  const deviceId = body.deviceId;
  const activityId = body.activityId;
  const slug = body.slug;
  const pushToken = body.pushToken;

  const ip = clientIp(req) ?? "unknown";
  const byIp = await checkRateLimit(`liveactivity:register:ip:${ip}`, MAX_ATTEMPTS, WINDOW_MS);
  if (byIp.limited) return tooManyAttempts(byIp.retryAfterSec);
  const byDevice = await checkRateLimit(`liveactivity:register:device:${deviceId}`, MAX_ATTEMPTS, WINDOW_MS);
  if (byDevice.limited) return tooManyAttempts(byDevice.retryAfterSec);

  try {
    const store = await getStore();
    const now = Date.now();

    // Entitled + actively armed at THIS slug, right now — the same gate the
    // alert engine's `store.listArmed(now)` already enforces. Checked BEFORE
    // the install token below so a device that isn't even eligible to start
    // a session gets the more informative "not-armed" rather than a token
    // error that would just send it around a pointless refresh loop.
    const armed = await store.listArmed(now);
    const session = armed.find((a) => a.device.id === deviceId && a.presence.slug === slug);
    if (!session) return fail("not-armed", 403);

    // Install token (Codex review #1): required once this device has one on
    // file. No hash yet → the caller should have gotten one from its most
    // recent POST /api/devices; tell it to refresh and retry rather than
    // silently accepting an unauthenticated register from a device that
    // hasn't been through that path yet. Also marks the token used (round-2
    // #2 followup) — see lib/db/installTokenAuth.ts's doc.
    const tokenCheck = await requireInstallToken(store, deviceId, req.headers.get("x-install-token"), Date.now());
    if (tokenCheck !== "ok") return fail(tokenCheck, 401);

    // Expiry reconciliation (Codex review #3): the bound is measured from the
    // ORIGINAL startedAt, not `now` — a rotation must never push the 8-hour
    // ActivityKit ceiling out from under the real start. `existing` is this
    // device's own rows only (safe to read startedAt off it); a cross-device
    // activityId conflict is caught atomically by `registerLiveActivity`
    // below regardless of what expiresAt this route computed for it.
    const existing = (await store.listLiveActivitiesForDevice(deviceId)).find(
      (r) => r.activityId === activityId,
    );
    const startedAt = existing ? existing.startedAt : now;
    const entitlementUntil = session.device.entitlementUntil;
    const expiresAt = Math.min(
      session.presence.armedUntil,
      startedAt + LIVE_ACTIVITY_MAX_SESSION_MS,
      entitlementUntil ?? Infinity,
    );
    if (!(expiresAt > now)) return fail("not-armed", 403);

    // Atomic supersede-other-active-rows + upsert/rotate THIS one (Codex
    // review #4) — see lib/db/store.ts `registerLiveActivity` for the
    // ownership/rotation contract.
    const result = await store.registerLiveActivity({
      activityId,
      deviceId,
      beachSlug: slug,
      schemaVersion: body.schemaVersion,
      appBuild,
      apnsEnvironment,
      pushToken,
      startedAt: now,
      expiresAt,
      rotation,
    });
    if (result === "device-mismatch") return fail("device-mismatch", 403);
    // Lost a race for a brand-new activityId to another device (Codex
    // round-3 #2) — same client-facing treatment as an outright mismatch.
    if (result === "not-owner") return fail("device-mismatch", 403);
    if (result === "stale-rotation") return fail("stale-rotation", 409);
    // The activity is no longer active — a delayed/duplicate register must
    // never reactivate an ended or superseded session (Codex round-3 #3).
    // The native plugin already treats any non-2xx/ok:false response as
    // "stop uploading for this activity" without needing a distinct code.
    if (result === "ended") return fail("ended", 409);

    // Never echo the token back — only bookkeeping the native side needs.
    return Response.json({
      ok: true,
      activityId: result.activityId,
      startedAt: result.startedAt,
      expiresAt: result.expiresAt,
    });
  } catch (e) {
    console.error("live-activity/register: failed", e);
    return fail("store-unavailable", 500);
  }
}
