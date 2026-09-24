// ---------------------------------------------------------------------------
// lib/ripRisk/ — the temporally-correct rip-current model.
//
// The bug this module originally fixed (2026-09-24): the app tracked a single
// daily NWS word (lib/sources/nws.ts's old parseRipRisk) plus a flat alert
// list with NO onset/effective timestamps, so "is an alert active" was never
// computed against real time — a Rip Current Statement scheduled for 2 AM
// tomorrow read as "in effect" today, and the SRF's TODAY word could push an
// alert that hadn't started.
//
// THREE SOURCES, in priority order, resolved fresh against a passed `now`
// (see resolve.ts's resolveRipNow for the exact freshness/disagreement rules):
//   1. officialAlert    — an actual NWS CAP alert (Rip Current Statement, or a
//      Beach Hazards Statement whose text mentions rip currents). Has a real
//      onset/end interval; status ("scheduled"/"inEffect"/"ended") is ALWAYS
//      computed from onset/end vs `now`, never cached as a boolean. IN EFFECT
//      always resolves to HIGH, regardless of what the SRF word or model say.
//   2. officialModel     — NOAA's NWPS hourly probabilistic rip current model
//      (lib/sources/ripNwps.ts), when fresh (run <= 36h old).
//   3. officialForecast  — the SRF's per-period word (TODAY/TONIGHT/a named
//      day), each with its own label and (when derivable) window.
//
// There is deliberately no fourth "physics estimate" fallback in production:
// an earlier experimental wave/tide/wind estimator was never wired past this
// module's own tests, so it was removed rather than kept as unused surface
// area (lib/ripRiskCurve.ts is a SEPARATE, still-used system that shapes the
// hourly CARD curve for beaches with no model coverage — see RipRiskCard.tsx).
//
// Every consumer (score cap, safety tone/line, the push evaluator, the
// banner, the card) calls the same pure `resolveRipNow` function with a
// passed `now` — never `Date.now()` inline — so they can never disagree.
// ---------------------------------------------------------------------------

import type { NwsAlert, RipRisk, SrfPeriod } from "@/lib/types";

export type AlertStatus = "scheduled" | "inEffect" | "ended";

export interface OfficialAlertNow {
  id: string;
  event: string;
  status: AlertStatus;
  onset: string; // ISO
  end: string; // ISO
}

export interface OfficialForecastNow {
  level: RipRisk;
  periodLabel: string;
  start?: string;
  end?: string;
}

/**
 * One hour of NOAA's hourly probabilistic rip current model (NWPS, Dusek &
 * Seim 2013) — see lib/sources/ripNwps.ts + the `rip-nwps.yml` workflow that
 * publishes it. `prob` is the model's raw 0-100 probability for that hour;
 * `level` is that probability banded per `levelForModelProb`
 * (lib/ripRisk/resolve.ts) — the app's OWN category, distinct from the raw
 * percentage. `run` is the model cycle's ISO start time (e.g.
 * "2026-09-24T00:00:00Z" for the 00z run) — carried on every hour so a stale
 * run is detectable without a second lookup.
 */
export interface OfficialModelNow {
  prob: number;
  level: Exclude<RipRisk, "unknown">;
  run: string; // ISO
}

/** One rolling-24h hour of the timeline (lib/ripRisk/timeline.ts). */
export interface RipHour {
  /** ISO timestamp (UTC), top of the hour. */
  t: string;
  officialForecast: OfficialForecastNow | null;
  officialAlert: OfficialAlertNow | null;
  officialModel: OfficialModelNow | null;
}

export type RipNowSource = "alert" | "model" | "forecast" | "unknown";

export interface RipNow {
  source: RipNowSource;
  level: RipRisk;
  alert: OfficialAlertNow | null;
  /** The nearest FUTURE (not-yet-started) alert, when one exists and none is
   *  currently in effect — lets callers say "begins 2 AM Fri" even though the
   *  resolved `source`/`level` came from the model or forecast instead. */
  upcomingAlert: OfficialAlertNow | null;
  period: OfficialForecastNow | null;
  /** This hour's NOAA model value, when fresh enough to use (see
   *  lib/sources/ripNwps.ts's staleness gate) — populated even when a
   *  different source won resolution, so callers can still show the raw %
   *  alongside a disagreeing SRF word. */
  model: OfficialModelNow | null;
  /** True when the RESOLVED level reads LOWER than the current SRF period's
   *  word — a real disagreement worth flagging in the UI. Callers search the
   *  model's own future hours (lib/sources/ripNwps.ts's
   *  `firstFutureHighHour`) for a "rising to High by…" time, or otherwise
   *  name the disagreement plainly (e.g. "NOAA model Low now · NWS forecast
   *  High"). */
  watch: boolean;
}

/** Only these NWS events (or a Beach Hazards Statement whose text mentions rip
 *  currents) count as a rip officialAlert. "High Surf Advisory" is a SEPARATE
 *  hazard and must never populate officialAlert. */
export function isRipAlertEvent(a: Pick<NwsAlert, "event" | "headline" | "description">): boolean {
  if (/rip current statement/i.test(a.event)) return true;
  if (/beach hazards? statement/i.test(a.event)) {
    return /rip current/i.test(`${a.headline ?? ""} ${a.description ?? ""}`);
  }
  return false;
}

export type { NwsAlert, SrfPeriod };
