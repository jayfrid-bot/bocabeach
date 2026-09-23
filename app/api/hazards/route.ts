// POST /api/hazards {lat, lon, accuracyM, fixAt, slug, deviceId} — "where you
// stand" hazard read for Beach Mode (phase 1e of docs/LOCATION_FIRST_PLAN.md).
//
// Reuses the SAME evaluators the score and the at-beach alert engine use —
// assessLightning/assessRain (lib/hazards/assess.ts), fed the same way they
// already are: summarizeStrikes off the device's own fix (lib/sources/
// lightning.ts, mirroring lib/alerts/evaluate.ts's lightningSubjects), and
// rainForFix off the beach's radar or the fix's own 0.05° cell (lib/alerts/
// rain.ts). Nothing here re-decides "is it raining" or "is lightning near" —
// this route only asks the one place that already knows, twice: once for the
// fix, once for the beach centroid, and hands the pair back.
//
// Deliberately does NOT call getConditions(slug) — that runs the beach's
// whole ~25-fetch pipeline (plus cams), which on a cache miss can alone blow
// past the Free plan's 50-subrequest cap for a single request. Instead this
// builds the beach pair from the same compact inputs the point pair uses: the
// lightning feed (already fetched once, reused for both anchors) and a direct
// `fetchPrecipRadar` read (one small precomputed-JSON fetch, not the full
// pipeline) fed through the same `rainForFix` radar path the point uses. A
// cold call costs a handful of fetches, not dozens. Both pairs are assessed
// at request time (Date.now()), not any cached conditions clock.
//
// Native-only: Beach Mode itself is app-only, and a fix is a PII-adjacent
// field with no reason to ever leave the app. POST with a JSON body (not query
// params) so the fix's coordinates and the device id never ride in a URL —
// query strings end up in server logs, proxies and browser history far more
// readily than a body does. Rate-limited per device (30/hour) and per IP
// (300/hour, generous for carrier NAT — device id is the real throttling
// signal) — the same KV-backed limiter /api/devices/unlock uses. Never logs
// coordinates.

import { getLocation } from "@/config/locations";
import { badRequest, fail, isDeviceId, readBody } from "@/lib/db/api";
import { getStore } from "@/lib/db/store";
import { requireInstallToken } from "@/lib/db/installTokenAuth";
import { assessLightning, type HazardAssessment } from "@/lib/hazards/assess";
import { summarizeStrikes } from "@/lib/sources/lightning";
import { loadLightningFeed } from "@/lib/alerts/lightningFeed";
import { fetchPrecipRadar } from "@/lib/sources/precipRadar";
import { newRainCache, rainForFix, type RainRead } from "@/lib/alerts/rain";
import { AT_BEACH_MI } from "@/lib/plus/beachMode";
import { ARRIVAL_MAX_FIX_AGE_MS, FIX_MAX_ACCURACY_M, FIX_MAX_FUTURE_SKEW_MS } from "@/lib/location/device";
import { cellKey } from "@/lib/location/cell";
import { isNativeRequest } from "@/lib/nativeRequest";
import { checkRateLimit, clientIp } from "@/lib/plus/rateLimit";
import { distanceToBeachMi } from "@/lib/location/shoreDistance";
import type { PrecipRadarData, Wrapped } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_ATTEMPTS_DEVICE = 30;
const MAX_ATTEMPTS_IP = 300;
const WINDOW_MS = 60 * 60 * 1000;

// A generous CONUS + Alaska + Hawaii box — just enough to reject a garbage or
// non-US fix before it reaches any external call. Not the precise per-beach
// coastal gate (that's `lib/resolve/*`); this route only ever serves a beach
// already in `config/locations.ts`, so the real precision comes from the
// "near the beach" check below.
const US_MIN_LAT = 15;
const US_MAX_LAT = 72;
const US_MIN_LON = -180;
const US_MAX_LON = -65;

function inUsBbox(lat: number, lon: number): boolean {
  return lat >= US_MIN_LAT && lat <= US_MAX_LAT && lon >= US_MIN_LON && lon <= US_MAX_LON;
}

function rateLimited(retryAfterSec: number): Response {
  return Response.json(
    { ok: false, error: "too-many-attempts" },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
  );
}

/**
 * A rain HazardAssessment built from `rainForFix`'s read. The active/latched
 * decision is entirely `assessRain`'s (via `rainForFix`) — this only maps
 * that decision to the same two reason strings `lib/hazards/assess.ts`
 * itself produces, so the copy can never drift from the source of truth.
 */
function rainAssessment(read: RainRead | null, anchor: HazardAssessment["anchor"], nowMs: number): HazardAssessment {
  const active = read?.hazardActive ?? read?.rainingNow ?? false;
  const latched = read?.latched ?? false;
  const reason = active ? (latched ? "Rain in the last 20 minutes" : "Raining right now") : null;
  return {
    kind: "rain",
    anchor: read?.anchor ?? anchor,
    active,
    latched,
    severity: active ? "rain" : "none",
    observedAtIso: active ? new Date(nowMs).toISOString() : null,
    expiresAtIso: null,
    reason,
  };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export async function POST(req: Request): Promise<Response> {
  if (!isNativeRequest(req)) return fail("app-only", 403);

  const body = await readBody(req);
  if (!body) return badRequest();

  const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
  if (!isDeviceId(deviceId)) return badRequest();

  const ip = clientIp(req) ?? "unknown";
  const byIp = await checkRateLimit(`hazards:ip:${ip}`, MAX_ATTEMPTS_IP, WINDOW_MS);
  if (byIp.limited) return rateLimited(byIp.retryAfterSec);
  const byDevice = await checkRateLimit(`hazards:device:${deviceId}`, MAX_ATTEMPTS_DEVICE, WINDOW_MS);
  if (byDevice.limited) return rateLimited(byDevice.retryAfterSec);

  // Install token (Codex review #1) — same requirement/shape as
  // /api/live-activity/register and /end: required once this device has one
  // on file (401 `token-required` when it doesn't yet — the client refreshes
  // /api/devices and retries), a constant-time header check otherwise. Also
  // marks the token used (round-2 #2 followup) — see
  // lib/db/installTokenAuth.ts's doc.
  const store = await getStore();
  const tokenCheck = await requireInstallToken(store, deviceId, req.headers.get("x-install-token"), Date.now());
  if (tokenCheck !== "ok") return fail(tokenCheck, 401);

  const lat = body.lat;
  const lon = body.lon;
  if (!isFiniteNumber(lat) || !isFiniteNumber(lon) || !inUsBbox(lat, lon)) return badRequest();

  // accuracyM / fixAt are REQUIRED (Codex round 2 #2): the client already
  // enforces establishesArrival's gates at dispatch, but a server that only
  // trusts lat/lon lets any caller claim "at the beach" with a stale or
  // fuzzy fix. This route re-runs the SAME gate Beach Mode's arrival check
  // does — fresh, accurate, not future-dated, within the arrival radius —
  // using the shared constants (lib/location/device.ts, lib/plus/beachMode.ts)
  // so the two can never drift apart.
  if (!isFiniteNumber(body.accuracyM)) return fail("inaccurate-fix", 400);
  if (!isFiniteNumber(body.fixAt)) return fail("stale-fix", 400);
  const accuracyM = body.accuracyM;
  const fixAt = body.fixAt;

  const slug = typeof body.slug === "string" ? body.slug : "";
  const loc = getLocation(slug);
  if (!loc) return badRequest();

  const nowMs = Date.now();

  if (fixAt - nowMs > FIX_MAX_FUTURE_SKEW_MS) return fail("future-fix", 400);
  if (nowMs - fixAt > ARRIVAL_MAX_FIX_AGE_MS) return fail("stale-fix", 400);
  if (accuracyM > FIX_MAX_ACCURACY_M) return fail("inaccurate-fix", 400);
  // Same shoreline-aware rule the client's establishesArrival used to arm
  // (lib/location/shoreDistance.ts) — a fix the client calls "at the beach"
  // must never be rejected here as "too far" (config/locations.ts's `shore`
  // covers `loc` directly; getLocation returns the full Location, not the
  // pared-down LocationPublic).
  if (distanceToBeachMi(lat, lon, loc) > AT_BEACH_MI) return fail("too-far", 400);
  const pointAnchor = { kind: "point" as const, lat, lon, cell: cellKey(lat, lon) };
  const beachAnchor = { kind: "beach" as const, slug };

  const feed = await loadLightningFeed().catch(() => null);
  const pointStrikes = feed ? summarizeStrikes(feed, lat, lon, nowMs) : null;
  const beachStrikes = feed ? summarizeStrikes(feed, loc.lat, loc.lon, nowMs) : null;

  const pointLightning = assessLightning({
    status: pointStrikes ? "ok" : "error",
    nearestMi: pointStrikes?.nearestMi,
    nearestMinutesAgo: pointStrikes?.nearestMinutesAgo,
    closeStrikeMinutesAgo: pointStrikes?.closeStrikeMinutesAgo,
    windowMinutes: pointStrikes?.windowMinutes,
    nowMs,
    anchor: pointAnchor,
  });
  const beachLightning = assessLightning({
    status: beachStrikes ? "ok" : "error",
    nearestMi: beachStrikes?.nearestMi,
    nearestMinutesAgo: beachStrikes?.nearestMinutesAgo,
    closeStrikeMinutesAgo: beachStrikes?.closeStrikeMinutesAgo,
    windowMinutes: beachStrikes?.windowMinutes,
    nowMs,
    anchor: beachAnchor,
  });

  // One small precomputed-JSON fetch — NOT the beach's full conditions
  // pipeline. Shared between the point and beach rain reads below, same as
  // when it came from the cached conditions snapshot.
  const beachRadar: Wrapped<PrecipRadarData> | null = await fetchPrecipRadar(loc).catch(() => null);

  const rainCache = newRainCache();
  const pointRainRead = await rainForFix(lat, lon, slug, nowMs, rainCache, beachRadar).catch(() => null);
  const beachRainRead = await rainForFix(loc.lat, loc.lon, slug, nowMs, rainCache, beachRadar).catch(() => null);
  const pointRain = rainAssessment(pointRainRead, pointAnchor, nowMs);
  const beachRain = rainAssessment(beachRainRead, beachAnchor, nowMs);

  return Response.json(
    {
      ok: true,
      anchor: pointAnchor,
      lightning: pointLightning,
      lightningMi: pointStrikes?.nearestMi ?? null,
      rain: pointRain,
      beach: {
        slug,
        lightning: beachLightning,
        lightningMi: beachStrikes?.nearestMi ?? null,
        rain: beachRain,
      },
      fetchedAt: new Date(nowMs).toISOString(),
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
