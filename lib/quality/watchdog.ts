// The hourly watchdog: run from the history archiver right after it writes a
// beach's `beach_hourly` row (app/api/history/archive/route.ts). It compares the
// new row to the beach's previous one (lib/quality/jumps.ts), drops every jump
// something real explains, and records the rest as owner alerts
// (lib/quality/alerts.ts). The route wraps this in try/catch: a watchdog failure
// must never fail the archive row.
//
// Cost: one D1 read when nothing jumped. A real alert adds a handful of D1
// statements and, when the push rules allow, one APNs call.

import type { D1Like } from "@/lib/db/d1Store";
import { recordAlert } from "@/lib/quality/alerts";
import { detectJumps, type Detection, type JumpRow } from "@/lib/quality/jumps";
import { previousHourlyRow, type NewAlert } from "@/lib/quality/store";
import type { HourlyAlertPayload } from "@/lib/quality/types";

/** The `beach_hourly` columns the watchdog reads. */
export const JUMP_COLS =
  "slug, hour_utc, local_date, score, wave_ft, surf_ft, wave_source, sand_temp_f, clarity_pct, rain_now, lightning_near, wind_mph, cloud_pct, caps_json, factors_json";

/** The alert an unexplained jump becomes. Pure. */
export function alertFromDetection(prev: JumpRow, cur: JumpRow, d: Detection, nowMs: number): NewAlert {
  const payload: HourlyAlertPayload = {
    localDate: cur.local_date,
    observedAt: cur.hour_utc,
    fromHourUtc: prev.hour_utc,
    from: d.from,
    to: d.to,
    delta: d.delta,
    cause: d.cause,
    published: { value: d.to },
  };
  return {
    slug: cur.slug,
    signal: d.signal,
    kind: "hourly-jump",
    createdAt: new Date(nowMs).toISOString(),
    payload,
    dedupeKey: `hourly:${cur.slug}:${d.signal}:${cur.hour_utc}`,
  };
}

export interface WatchdogResult {
  /** False when there was no earlier row close enough to compare. */
  compared: boolean;
  found: number;
  explained: number;
  alertIds: number[];
  /** Alerts that took a push slot (the drain step sends them). */
  queued: number;
}

export async function runHourlyWatchdog(db: D1Like, cur: JumpRow, nowMs: number): Promise<WatchdogResult> {
  const prev = await previousHourlyRow<JumpRow>(db, JUMP_COLS, cur.slug, cur.hour_utc);
  const out: WatchdogResult = { compared: false, found: 0, explained: 0, alertIds: [], queued: 0 };
  if (!prev) return out;
  const detections = detectJumps(prev, cur);
  out.compared = true;
  out.found = detections.length;
  for (const d of detections) {
    if (d.explained) {
      out.explained += 1;
      continue;
    }
    const r = await recordAlert(db, alertFromDetection(prev, cur, d, nowMs), nowMs);
    if (r.created) out.alertIds.push(r.id);
    if (r.queued) out.queued += 1;
  }
  return out;
}
