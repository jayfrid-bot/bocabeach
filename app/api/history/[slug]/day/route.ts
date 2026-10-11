// POST /api/history/[slug]/day — Plus "go back to any day" for one beach
// (docs/CAM_ARCHIVE_PLAN.md section 3 and R6/R9/R10). Body { deviceId, date:
// "YYYY-MM-DD" }, header x-install-token. Returns that beach-local day's
// archived hours (beach_hourly snapshot rows), their DaySummary and formula
// notice, and one entry per archived cam with the day's saved camera shots,
// each carrying a signed 15-minute link (lib/camFrames/sign.ts) to
// GET /api/cam-frames/img.
//
// Gate: copied from app/api/history/[slug]/route.ts — app-only, a valid
// deviceId, KV rate limiting, the install token once a device has one on file,
// then `entitled(device, now)`: a free device gets 403 not-entitled and is
// never handed a signed link. The date must be a real calendar date (round-
// trip) between the first archived day and today in the BEACH's timezone.
//
// Three D1 statements, all reads, no R2: (1) the archive bounds, (2) the day's
// hourly rows, (3) the day's ready cam_frames rows. (2) and (3) run together
// once (1) has accepted the date.
//
// Frames: only state = 'ready' rows of this beach and local date; only cams the
// manifest still archives (`archive: false` hides a cam at once, R6); the
// credit line comes from each ROW, never today's config. A cam with no shot
// that day is listed with `frames: []`. Response is private, no-store.

import { getLocation } from "@/config/locations";
import { badRequest, fail, isDeviceId, readBody } from "@/lib/db/api";
import { getD1, HOURLY_COLS } from "@/lib/db/d1Store";
import { getStore } from "@/lib/db/store";
import { entitled } from "@/lib/db/types";
import { requireInstallToken } from "@/lib/db/installTokenAuth";
import { isNativeRequest } from "@/lib/nativeRequest";
import { checkRateLimit, clientIp } from "@/lib/plus/rateLimit";
import { localHourParts } from "@/lib/history/archive";
import { shapeCams, shapeHours, type DayFrameRow, type DayViewPayload } from "@/lib/history/dayView";
import { summarizeDay, summarizeVersions } from "@/lib/history/summary";
import type { BeachHourlyRow } from "@/lib/history/types";
import { isCalendarDate, isValidFrameKey } from "@/lib/camFrames/keys";
import { archiveCams } from "@/lib/camFrames/manifest";
import { sign } from "@/lib/camFrames/sign";
import { SCORING_ENGINE_VERSION } from "@/lib/score";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// A device re-fetches on every day it steps to, so the device limit is higher
// than the Last-N-days route's 60/hr; the IP limit matches it.
const MAX_ATTEMPTS_DEVICE = 240;
const MAX_ATTEMPTS_IP = 600;
const WINDOW_MS = 60 * 60 * 1000;

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
  const date = body.date;
  if (typeof date !== "string" || !isCalendarDate(date)) return badRequest();

  const ip = clientIp(req) ?? "unknown";
  const byIp = await checkRateLimit(`history-day:ip:${ip}`, MAX_ATTEMPTS_IP, WINDOW_MS);
  if (byIp.limited) return rateLimited(byIp.retryAfterSec);
  const byDevice = await checkRateLimit(`history-day:device:${deviceId}`, MAX_ATTEMPTS_DEVICE, WINDOW_MS);
  if (byDevice.limited) return rateLimited(byDevice.retryAfterSec);

  try {
    const store = await getStore();
    const now = Date.now();

    const tokenCheck = await requireInstallToken(store, deviceId, req.headers.get("x-install-token"), now);
    if (tokenCheck !== "ok") return fail(tokenCheck, 401);

    const device = await store.getDevice(deviceId);
    if (!device || !entitled(device, now)) return fail("not-entitled", 403);

    const db = await getD1();
    if (!db) return fail("store-unavailable", 503);

    const bounds = await db
      .prepare(
        "SELECT " +
          "(SELECT MIN(local_date) FROM beach_hourly WHERE slug = ?1 AND row_kind = 'snapshot') AS hours_start, " +
          "(SELECT MIN(local_date) FROM cam_frames WHERE slug = ?1 AND state = 'ready') AS frames_start",
      )
      .bind(slug)
      .first<{ hours_start: string | null; frames_start: string | null }>();
    const archiveStart = bounds?.hours_start ?? null;
    const framesStart = bounds?.frames_start ?? null;
    const { date: todayLocal } = localHourParts(loc.timezone, now);
    if (!archiveStart || date < archiveStart || date > todayLocal) return badRequest();

    const [hoursRes, framesRes] = await Promise.all([
      db
        .prepare(
          `SELECT ${HOURLY_COLS.join(", ")} FROM beach_hourly ` +
            "WHERE slug = ?1 AND row_kind = 'snapshot' AND local_date = ?2 ORDER BY hour_utc",
        )
        .bind(slug, date)
        .all<BeachHourlyRow>(),
      db
        .prepare(
          "SELECT cam_id, slot_utc, local_hour, local_minute, r2_key, attribution FROM cam_frames " +
            "WHERE slug = ?1 AND local_date = ?2 AND state = 'ready' ORDER BY cam_id, slot_utc",
        )
        .bind(slug, date)
        .all<DayFrameRow>(),
    ]);
    const rows = hoursRes.results ?? [];
    const frameRows = framesRes.results ?? [];

    // Sign every link up front (one HMAC each). An unset signing key is a
    // deploy mistake: answer 503 rather than hand out unsigned links.
    const manifest = archiveCams().filter((c) => c.slug === slug);
    const urls = new Map<string, string>();
    const archived = new Set(manifest.map((c) => c.camId));
    try {
      for (const r of frameRows) {
        if (!archived.has(r.cam_id) || urls.has(r.r2_key) || !isValidFrameKey(r.r2_key)) continue;
        const { exp, sig } = await sign(r.r2_key);
        urls.set(
          r.r2_key,
          `/api/cam-frames/img?k=${encodeURIComponent(r.r2_key)}&exp=${exp}&sig=${sig}`,
        );
      }
    } catch (e) {
      console.error("history day: signing failed", e);
      return fail("not-configured", 503);
    }

    const summary = summarizeDay(date, rows);
    const payload: DayViewPayload = {
      date,
      timezone: loc.timezone,
      hours: shapeHours(rows),
      summary,
      versions: summarizeVersions([summary], SCORING_ENGINE_VERSION),
      cams: shapeCams(manifest, frameRows, (k) => urls.get(k) ?? null),
      archiveStart,
      framesStart,
    };
    return Response.json({ ok: true, ...payload }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    console.error("history day: read failed", e);
    return fail("store-unavailable", 500);
  }
}
