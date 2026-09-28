// POST /api/history/[slug] — Plus "Last 7 days" for one beach
// (docs/HISTORY_AND_IMAGERY_PLAN.md Part A). Body { deviceId, days?: 7|14|30 },
// header x-install-token. Reads the archive `beach_hourly` has been
// collecting hourly since 2026-09-22 (migrations/0006_history.sql,
// lib/history/archive.ts) and turns it into day-by-day summaries plus a
// handful of records — see lib/history/summary.ts for the pure aggregation.
//
// Gate: the same shape live-activity/register and hazards use, combined —
// app-only (Plus is sold and delivered only inside the phone app), a valid
// deviceId, KV rate limiting (the same lib/plus/rateLimit.ts helper every
// other Plus route throttles with), the install token once a device has one
// on file, and finally `entitled(device, now)` — a free device gets 403
// not-entitled, the exact line app/api/presence/route.ts uses. (presence.ts
// itself skips the native/install-token checks — this route adds them
// because, like hazards/live-activity, it is native-app-only and PII-
// adjacent-free but still worth rate-limiting and binding to a real device.)
//
// Never calls getConditions — this is a pure D1 read + in-memory summarize,
// nowhere near the Free plan's 50-subrequest-per-request cap.

import { getLocation } from "@/config/locations";
import { badRequest, fail, isDeviceId, readBody } from "@/lib/db/api";
import { getStore } from "@/lib/db/store";
import { entitled } from "@/lib/db/types";
import { requireInstallToken } from "@/lib/db/installTokenAuth";
import { isNativeRequest } from "@/lib/nativeRequest";
import { checkRateLimit, clientIp } from "@/lib/plus/rateLimit";
import { localHourParts } from "@/lib/history/archive";
import { shiftLocalDate, summarizeHistory } from "@/lib/history/summary";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_ATTEMPTS_DEVICE = 30;
const MAX_ATTEMPTS_IP = 120;
const WINDOW_MS = 60 * 60 * 1000;

/** The only windows the UI offers (7 / 14 / 30 day chips) — anything else
 *  is a 400, never silently clamped. */
const VALID_DAYS = new Set([7, 14, 30]);
/** Hard cap regardless of what a (trusted, but still bounded) caller asks
 *  for — matches the store method's own documented ≤31-day expectation. */
const MAX_DAYS = 31;

function rateLimited(retryAfterSec: number): Response {
  return Response.json(
    { ok: false, error: "too-many-attempts" },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
  );
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  if (!isNativeRequest(req)) return fail("app-only", 403);

  const { slug } = await params;
  const loc = getLocation(slug);
  if (!loc) return badRequest();

  const body = await readBody(req);
  if (!body || !isDeviceId(body.deviceId)) return badRequest();
  const deviceId = body.deviceId;

  const days = body.days === undefined ? 7 : body.days;
  if (typeof days !== "number" || !VALID_DAYS.has(days)) return badRequest();

  const ip = clientIp(req) ?? "unknown";
  const byIp = await checkRateLimit(`history:ip:${ip}`, MAX_ATTEMPTS_IP, WINDOW_MS);
  if (byIp.limited) return rateLimited(byIp.retryAfterSec);
  const byDevice = await checkRateLimit(`history:device:${deviceId}`, MAX_ATTEMPTS_DEVICE, WINDOW_MS);
  if (byDevice.limited) return rateLimited(byDevice.retryAfterSec);

  try {
    const store = await getStore();
    const now = Date.now();

    // Install token (same requirement/shape as /api/hazards and
    // /api/live-activity/*): required once this device has one on file.
    const tokenCheck = await requireInstallToken(store, deviceId, req.headers.get("x-install-token"), now);
    if (tokenCheck !== "ok") return fail(tokenCheck, 401);

    const device = await store.getDevice(deviceId);
    if (!device || !entitled(device, now)) return fail("not-entitled", 403);

    const { date: todayLocal } = localHourParts(loc.timezone, now);
    const sinceLocalDate = shiftLocalDate(todayLocal, -(Math.min(days, MAX_DAYS) - 1));

    const rows = await store.hourlyHistory(slug, sinceLocalDate);
    const { days: daySummaries, records } = summarizeHistory(rows);

    return Response.json(
      { ok: true, since: sinceLocalDate, days: daySummaries, records },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    console.error("history: read failed", e);
    return fail("store-unavailable", 500);
  }
}
