// ---------------------------------------------------------------------------
// Water "feel" trend — the insider signal a local knows and a tourist doesn't:
// the ocean surface warms and cools on its own multi-day rhythm, and a sharp
// recent move is worth calling out even when the *absolute* temperature is
// still "warm enough". Two SE-Florida-summer patterns this exists to catch:
//   • COLD UPWELLING — sustained N/NW wind pushes the warm surface layer
//     offshore and colder deep water wells up in its place. Water can drop
//     several degrees in a couple of days even in July. Surfers/divers/anyone
//     who was in last week notice this well before a single "77°F" readout
//     would ever hint at it.
//   • WARMING FAST — the mirror image: a stagnant, sunny stretch bakes the
//     shallows noticeably warmer in a couple of days (a jellyfish/algae cue
//     for some readers, a "finally warm enough" cue for others).
//
// DESIGN — robust deltas, not point-to-point noise:
//   deltaF48h = median(readings from the last 6h) − median(readings 42–54h ago)
//   deltaF7d  = median(readings from the last 6h) − median(readings 6.5–7.5d ago)
// Medians (not single nearest-in-time readings) so one bad/garbled row from a
// buoy or a marine-model hiccup can't flip the call. `status` is driven ONLY
// by deltaF48h (the more actionable, more reliably-covered window); deltaF7d
// is informational context returned alongside it, and — independently — is
// honestly null when the supplied history doesn't reach back that far (see
// the INTEGRATION NOTE below for widening the fetch that would fix that).
//
// HONEST-NULL: this module says nothing rather than guess from thin air.
// Returns null when the history doesn't reach back >= 36h (can't even attempt
// a "how's it moved lately" read), when > 50% of the readings we'd expect
// across the covered span are missing (assumes ~hourly cadence as the honest
// minimum bar — real feeds run denser, so this only trips on genuinely gappy
// data), or — belt & suspenders beyond the letter of those two rules — when
// either the "most recent 6h" or "42–54h ago" bucket individually comes up
// completely empty (which a >=36h-but-uneven history can still produce), since
// deltaF48h can't be honestly computed from an empty bucket either way.
//
// Pure + deterministic: caller passes `nowMs` (or it defaults to Date.now()
// for ergonomic call sites); no I/O, no globals, trivially unit-testable.
// ---------------------------------------------------------------------------

import { round } from "@/lib/util";

/** One water-temperature observation. `t` is any parseable ISO instant — only
 *  the absolute time matters, not its offset/timezone. */
export interface WaterTrendReading {
  t: string;
  waterTempF: number;
}

export type WaterTrendStatus = "upwelling" | "cooling" | "warming-fast" | "steady";

export interface WaterTrendResult {
  status: WaterTrendStatus;
  /** median(last 6h) − median(42–54h ago), °F, rounded to 0.1. Drives `status`. */
  deltaF48h: number;
  /** median(last 6h) − median(6.5–7.5d ago), °F, rounded to 0.1. Informational
   *  only — null when the supplied history doesn't cover that older window. */
  deltaF7d: number | null;
  /** Human-readable one-liner for the UI (and a tooltip/aria description). */
  note: string;
}

export interface WaterTrendOptions {
  /** "Now", for computing how many hours ago each reading is. Defaults to
   *  Date.now() — pass a fixed value from tests for determinism. */
  nowMs?: number;
}

/** Fewest hours of trailing history before we'll attempt any read at all. */
export const MIN_HISTORY_HOURS = 36;
/** Above this fraction of "expected" (~hourly-cadence) readings missing across
 *  the covered span, the data's too gappy to trust a median off of. */
export const MAX_MISSING_FRACTION = 0.5;

const RECENT_WINDOW_H = 6;
const H48_LO = 42;
const H48_HI = 54;
const H7D_LO = 6.5 * 24; // 156h
const H7D_HI = 7.5 * 24; // 180h

/** Degree thresholds on deltaF48h that separate the four statuses. */
const UPWELLING_AT = -3;
const COOLING_AT = -1.5;
const WARMING_FAST_AT = 3;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Hours between `t` and `nowMs` (positive = in the past). Null if `t` doesn't parse. */
function hoursAgo(t: string, nowMs: number): number | null {
  const ms = Date.parse(t);
  if (!Number.isFinite(ms)) return null;
  return (nowMs - ms) / 3_600_000;
}

/**
 * Compute the water-temperature trend from up to 7 trailing days of readings.
 * See the file header for the full design rationale.
 */
export function waterTrend(
  history: readonly WaterTrendReading[],
  opts: WaterTrendOptions = {},
): WaterTrendResult | null {
  const nowMs = opts.nowMs ?? Date.now();

  const valid = history
    .map((r) => ({ ageH: hoursAgo(r.t, nowMs), tempF: r.waterTempF }))
    .filter(
      (r): r is { ageH: number; tempF: number } =>
        r.ageH !== null && r.ageH >= 0 && Number.isFinite(r.tempF),
    );
  if (valid.length === 0) return null;

  // Honest-null #1: not enough trailing span to attempt a read at all.
  const oldestAgeH = Math.max(...valid.map((r) => r.ageH));
  if (oldestAgeH < MIN_HISTORY_HOURS) return null;

  // Honest-null #2: too many gaps across the covered span. No cadence is
  // assumed from the caller — ~1 reading/hour is the honest minimum bar
  // (NDBC's ~10-min cadence and Open-Meteo's hourly output both clear it
  // easily; a feed with real outages doesn't).
  const expected = oldestAgeH;
  const missingFraction = Math.max(0, 1 - valid.length / expected);
  if (missingFraction > MAX_MISSING_FRACTION) return null;

  const recent = valid.filter((r) => r.ageH <= RECENT_WINDOW_H).map((r) => r.tempF);
  const bucket48 = valid.filter((r) => r.ageH >= H48_LO && r.ageH <= H48_HI).map((r) => r.tempF);
  const bucket7d = valid.filter((r) => r.ageH >= H7D_LO && r.ageH <= H7D_HI).map((r) => r.tempF);

  const recentMedian = median(recent);
  const median48 = median(bucket48);
  // Honest-null #3: the two buckets deltaF48h is built from must both have
  // data — an uneven-but->=36h history can still leave one of them empty.
  if (recentMedian === null || median48 === null) return null;

  const deltaF48h = round(recentMedian - median48, 1);
  const median7d = median(bucket7d);
  const deltaF7d = median7d === null ? null : round(recentMedian - median7d, 1);

  const magnitude = Math.abs(deltaF48h).toFixed(1);
  let status: WaterTrendStatus;
  let note: string;
  if (deltaF48h <= UPWELLING_AT) {
    status = "upwelling";
    note = `Cold upwelling — water dropped ${magnitude}°F over the last 2 days. N/NW winds pushing warm surface water offshore.`;
  } else if (deltaF48h <= COOLING_AT) {
    status = "cooling";
    note = `Water cooling — down ${magnitude}°F over the last 2 days.`;
  } else if (deltaF48h >= WARMING_FAST_AT) {
    status = "warming-fast";
    note = `Water warming fast — up ${magnitude}°F over the last 2 days.`;
  } else {
    status = "steady";
    note = "Water temp holding steady — no notable trend over the last 2 days.";
  }

  return { status, deltaF48h, deltaF7d, note };
}
