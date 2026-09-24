// Builds the rolling 24-hour hourly timeline (spec item C) — NOT daylight-only
// (unlike lib/ripRiskCurve.ts's card curve). Each hour carries all THREE
// sources side by side; resolve.ts's resolveRipNow picks which one governs a
// given instant.

import type { RipHour, RipNow, OfficialModelNow } from "@/lib/ripRisk/types";
import { currentSrfPeriod, levelForModelProb, ripAlertsNow, resolveRipNow } from "@/lib/ripRisk/resolve";
import type { NwsAlert, SrfPeriod } from "@/lib/types";

const HOUR_MS = 3_600_000;

/** One hour of a beach's NOAA rip model series (lib/sources/ripNwps.ts,
 *  scripts/rip_nwps.mjs's published shape). Only `t`/`prob` drive resolution;
 *  the rest are carried through for the UI's model strip + flip-back. */
export interface RipModelHourInput {
  t: string; // ISO, top of hour
  prob: number; // 0-100
  hsFt?: number;
  periodS?: number;
  dirDeg?: number;
}

export interface RipTimelineInput {
  alerts: NwsAlert[];
  srfPeriods?: SrfPeriod[];
  /** NOAA model hours for this beach, plus the model cycle's run time (ISO). */
  modelHours?: RipModelHourInput[];
  modelRun?: string;
  /** Rolling window start (top of hour), ISO UTC. */
  startIso: string;
  hours?: number; // default 24
}

function modelForHour(
  modelHours: RipModelHourInput[] | undefined,
  modelRun: string | undefined,
  tMs: number,
): OfficialModelNow | null {
  if (!modelHours?.length || !modelRun) return null;
  // Model rows are hourly; the value for THIS clock hour is the row whose
  // `t` equals it — no interpolation, just the matching top-of-hour row.
  const row = modelHours.find((h) => Date.parse(h.t) === tMs);
  if (!row || !Number.isFinite(row.prob)) return null;
  return { prob: row.prob, level: levelForModelProb(row.prob), run: modelRun };
}

export function buildRipTimeline(input: RipTimelineInput): RipHour[] {
  const { alerts, srfPeriods, modelHours, modelRun, startIso, hours = 24 } = input;
  const startMs = Math.floor(Date.parse(startIso) / HOUR_MS) * HOUR_MS;
  if (!Number.isFinite(startMs)) return [];

  const out: RipHour[] = [];
  for (let i = 0; i < hours; i++) {
    const tMs = startMs + i * HOUR_MS;
    const officialForecast = currentSrfPeriod(srfPeriods, tMs);
    const ripAlertsAtHour = ripAlertsNow(alerts, tMs);
    const officialAlert =
      ripAlertsAtHour.find((a) => a.status === "inEffect") ??
      ripAlertsAtHour.find((a) => a.status === "scheduled") ??
      null;
    const officialModel = modelForHour(modelHours, modelRun, tMs);
    out.push({ t: new Date(tMs).toISOString(), officialForecast, officialAlert, officialModel });
  }
  return out;
}

/** Resolve every hour of a timeline to a RipNow, using each hour's OWN `t` as
 *  `now` and `t + 1h` as `hourEndMs` — so future hours reflect the
 *  period/alert/model window that will actually apply THEN (with overlap,
 *  not point-in-time, alert marking — see resolveRipNow's `hourEndMs`). */
export function resolveRipTimeline(
  hoursTimeline: RipHour[],
  alerts: NwsAlert[],
  srfPeriods: SrfPeriod[] | undefined,
): RipNow[] {
  return hoursTimeline.map((h) => {
    const now = Date.parse(h.t);
    return resolveRipNow({
      alerts,
      srfPeriods,
      model: h.officialModel,
      now,
      hourEndMs: now + HOUR_MS,
    });
  });
}
