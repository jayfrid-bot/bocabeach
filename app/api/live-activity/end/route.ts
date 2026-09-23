// POST /api/live-activity/end — body { deviceId, activityId }. The explicit
// Off/dismiss path (docs/LIVE_ACTIVITY_PLAN.md): foreground Off ends the row
// immediately with reason "user". lib/alerts/run.ts's due-end sweep is the
// backstop for a request that never arrives (app killed, offline, etc).
//
// Native app only, rate limited — same shape as /api/live-activity/register.
// Ownership is confirmed via `listLiveActivitiesForDevice` before ending, so
// one device can never end another device's activity by guessing its id.
// The push token never appears in the response or a log line.

import { badRequest, fail, isDeviceId, readBody } from "@/lib/db/api";
import { getStore } from "@/lib/db/store";
import { requireInstallToken } from "@/lib/db/installTokenAuth";
import { isNativeRequest } from "@/lib/nativeRequest";
import { checkRateLimit, clientIp } from "@/lib/plus/rateLimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_ATTEMPTS = 30;
const WINDOW_MS = 5 * 60 * 1000;

const ACTIVITY_ID_RE = /^[A-Za-z0-9_:.-]{8,128}$/;
function isActivityId(v: unknown): v is string {
  return typeof v === "string" && ACTIVITY_ID_RE.test(v);
}

function tooManyAttempts(retryAfterSec: number): Response {
  return Response.json(
    { ok: false, error: "too-many-attempts" },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
  );
}

export async function POST(req: Request): Promise<Response> {
  if (!isNativeRequest(req)) return fail("app-only", 403);

  const body = await readBody(req);
  if (!body || !isDeviceId(body.deviceId)) return badRequest();
  if (!isActivityId(body.activityId)) return badRequest();
  const deviceId = body.deviceId;
  const activityId = body.activityId;

  const ip = clientIp(req) ?? "unknown";
  const byIp = await checkRateLimit(`liveactivity:end:ip:${ip}`, MAX_ATTEMPTS, WINDOW_MS);
  if (byIp.limited) return tooManyAttempts(byIp.retryAfterSec);
  const byDevice = await checkRateLimit(`liveactivity:end:device:${deviceId}`, MAX_ATTEMPTS, WINDOW_MS);
  if (byDevice.limited) return tooManyAttempts(byDevice.retryAfterSec);

  try {
    const store = await getStore();
    const existing = await store.listLiveActivitiesForDevice(deviceId);
    const row = existing.find((a) => a.activityId === activityId);
    if (!row) return fail("not-found", 404);

    // Install token (Codex review #1) — same requirement/ordering as
    // register: checked after we've confirmed this device actually owns an
    // activity worth ending, so a request for someone else's/a nonexistent
    // activityId still 404s rather than leaking "token-required" first. Also
    // marks the token used (round-2 #2 followup) — see
    // lib/db/installTokenAuth.ts's doc.
    const tokenCheck = await requireInstallToken(store, deviceId, req.headers.get("x-install-token"), Date.now());
    if (tokenCheck !== "ok") return fail(tokenCheck, 401);

    // Explicit Off/dismiss — the token is done being useful the moment this
    // lands, so it's cleared now rather than retained for the 72h
    // `purgeLiveActivities` window (Codex review #10).
    await store.markLiveActivityEnded(activityId, "user", Date.now(), { clearToken: true });
    return Response.json({ ok: true, activityId });
  } catch (e) {
    console.error("live-activity/end: failed", e);
    return fail("store-unavailable", 500);
  }
}
