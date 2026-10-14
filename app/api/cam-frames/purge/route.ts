// POST /api/cam-frames/purge — the daily cleanup for the webcam archive index
// (docs/CAM_ARCHIVE_PLAN.md R5). workers/history-cron calls it once a day, on
// its every-minute tick that lands on 08:17 UTC (there is no second cron
// expression), just before that tick's archive call. It sends the shared
// CRON_SECRET in the same header the other cron routes check
// (app/api/push/run, app/api/history/archive).
//
// It deletes, from D1 only:
//   - `pending` rows older than 1 hour (an ingest that crashed after its claim);
//   - rows older than 365 days by `received_at_utc` (the server clock).
// Work is bounded: at most 10 D1 statements per call (one pending pass plus up
// to 9 batches of 5,000 rows). If the cap stops it with rows left, `more` is
// true and tomorrow's run continues.
//
// The same daily run also tidies two small quality tables (docs/QUALITY_PLAN.md): push-slot rows that
// are `sent` or `unknown` and older than 30 days, and owner-enrollment throttle counters older than
// two days. A failure there is logged and never fails the cam purge.
//
// R2 objects are NOT touched here: the bucket's 367-day lifecycle rule removes
// them two days after their row is gone, so an orphan object is invisible and a
// listed row never points at a missing object.

import { secretEqual } from "@/lib/db/api";
import { getD1 } from "@/lib/db/d1Store";
import { purgeCamFrames } from "@/lib/camFrames/store";
import { purgeEnrollAttempts } from "@/lib/quality/enrollThrottle";
import { purgeOldSlots } from "@/lib/quality/pushSlots";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json({ error: "cam purge not configured (CRON_SECRET unset)" }, { status: 503 });
  }
  if (!secretEqual(req.headers.get("x-cron-secret") ?? "", secret)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = await getD1();
  if (!db) return Response.json({ error: "database unavailable" }, { status: 503 });
  try {
    const nowMs = Date.now();
    const result = await purgeCamFrames(db, nowMs, { maxStatements: 10 });
    let pushSlots = 0;
    let enrollCounters = 0;
    try {
      pushSlots = await purgeOldSlots(db, nowMs);
      enrollCounters = await purgeEnrollAttempts(db, nowMs);
    } catch (e) {
      console.error("quality purge failed", e);
    }
    return Response.json({ ok: true, ...result, pushSlots, enrollCounters });
  } catch {
    return Response.json({ ok: false, error: "purge failed" }, { status: 500 });
  }
}
