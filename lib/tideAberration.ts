// ---------------------------------------------------------------------------
// Tide aberrations: how TODAY's tides compare to what's NORMAL at this station.
//
// NOAA publishes deterministic harmonic hi/lo predictions years ahead. Over a
// ±3-week window the daily highs and lows form two clear distributions; today's
// extremes either sit inside that normal band or escape it. The two aberrations
// worth calling out on a South-Florida beach are:
//   • KING TIDE  — a perigean spring high (sun + moon aligned at lunar perigee);
//     these push the water far up the beach and cause the sunny-day flooding of
//     A1A and the beach parking lots.
//   • UNUSUALLY LOW LOW — the fun flip side of the same spring cycle: the water
//     pulls way back, exposing sandbars and tide pools.
//
// Pure + deterministic: callers pass `nowMs` and the beach `tz` explicitly, so
// server and client agree and tests are trivial. No aberration is EVER claimed
// on a thin window (< 14 local days) or when today has no high/low to compare —
// the honest-null case returns `null`.
// ---------------------------------------------------------------------------

export type TideHighStatus = "normal" | "elevated" | "king";
export type TideLowStatus = "normal" | "low" | "very-low";

export interface TideWindowEvent {
  type: "high" | "low";
  /** ISO timestamp (UTC). */
  time: string;
  heightFt: number;
}

export interface TideAberration {
  /** Today's peak high vs the window's high-tide distribution. */
  highStatus: TideHighStatus;
  /** Today's lowest low vs the window's low-tide distribution. */
  lowStatus: TideLowStatus;
  /** Today's max high minus the window's median high (ft; +ve = higher than normal). */
  deltaHighFt: number;
  /** Today's min low minus the window's median low (ft; -ve = lower than normal). */
  deltaLowFt: number;
  medianHighFt: number;
  medianLowFt: number;
  /** 90th-percentile of window highs — the top of the "normal high" band. */
  p90HighFt: number;
  /** 10th-percentile of window lows — the bottom of the "normal low" band. */
  p10LowFt: number;
  /** Today's actual peak high / lowest low (ft). */
  todayMaxHighFt: number;
  todayMinLowFt: number;
  /** Distinct local calendar days that fed the distributions. */
  windowDays: number;
}

/** Minimum exceedance beyond the band's median for an aberration to be "meaningful". */
const MEANINGFUL_FT = 0.5;
/** Fewest distinct local days of predictions before we'll make any claim. */
const MIN_WINDOW_DAYS = 14;

/**
 * Linear-interpolated percentile of a numeric sample (p in 0..100).
 * Uses the same "type-7" convention as most stats packages.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (rank - lo) * (sorted[hi] - sorted[lo]);
}

const median = (values: number[]): number => percentile(values, 50);

/** YYYY-MM-DD for an instant in a given IANA time zone. */
function localYmd(ms: number, tz: string): string {
  // en-CA formats as YYYY-MM-DD, which is exactly what we want to bucket by.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Compare today's tide extremes against the ±window distribution.
 *
 * @param events  All hi/lo events across the window (heights in ft, MLLW).
 * @param opts.nowMs  "Now" — determines which local day is "today".
 * @param opts.tz     IANA time zone of the beach (buckets events into local days).
 * @returns the typed aberration, or `null` for the honest-null cases
 *          (thin window, or today has no high/low to compare).
 */
export function computeTideAberration(
  events: TideWindowEvent[],
  opts: { nowMs: number; tz: string },
): TideAberration | null {
  const { nowMs, tz } = opts;
  if (events.length === 0) return null;

  const highs = events.filter((e) => e.type === "high").map((e) => e.heightFt);
  const lows = events.filter((e) => e.type === "low").map((e) => e.heightFt);
  if (highs.length < 2 || lows.length < 2) return null;

  // Honest-null on a thin window: count DISTINCT local calendar days present.
  const days = new Set(events.map((e) => localYmd(new Date(e.time).getTime(), tz)));
  const windowDays = days.size;
  if (windowDays < MIN_WINDOW_DAYS) return null;

  const todayYmd = localYmd(nowMs, tz);
  const todayHighs = events
    .filter((e) => e.type === "high" && localYmd(new Date(e.time).getTime(), tz) === todayYmd)
    .map((e) => e.heightFt);
  const todayLows = events
    .filter((e) => e.type === "low" && localYmd(new Date(e.time).getTime(), tz) === todayYmd)
    .map((e) => e.heightFt);
  // Need at least one high AND one low today to make the comparison honestly.
  if (todayHighs.length === 0 || todayLows.length === 0) return null;

  const medianHighFt = median(highs);
  const p90HighFt = percentile(highs, 90);
  const p95HighFt = percentile(highs, 95);
  const medianLowFt = median(lows);
  const p10LowFt = percentile(lows, 10);
  const p05LowFt = percentile(lows, 5);

  const todayMaxHighFt = Math.max(...todayHighs);
  const todayMinLowFt = Math.min(...todayLows);
  const deltaHighFt = todayMaxHighFt - medianHighFt;
  const deltaLowFt = todayMinLowFt - medianLowFt; // negative when lower than normal

  // Highs: escape the top of the normal band AND clear the median by a
  // meaningful margin. Degree splits at p95 (king) vs p90 (near-king/elevated).
  let highStatus: TideHighStatus = "normal";
  if (todayMaxHighFt >= p90HighFt && deltaHighFt >= MEANINGFUL_FT) {
    highStatus = todayMaxHighFt >= p95HighFt ? "king" : "elevated";
  }

  // Lows: mirror image — dip below the bottom of the band AND undercut the
  // median by a meaningful margin. Degree splits at p05 (very-low) vs p10 (low).
  let lowStatus: TideLowStatus = "normal";
  if (todayMinLowFt <= p10LowFt && medianLowFt - todayMinLowFt >= MEANINGFUL_FT) {
    lowStatus = todayMinLowFt <= p05LowFt ? "very-low" : "low";
  }

  return {
    highStatus,
    lowStatus,
    deltaHighFt: round1(deltaHighFt),
    deltaLowFt: round1(deltaLowFt),
    medianHighFt: round1(medianHighFt),
    medianLowFt: round1(medianLowFt),
    p90HighFt: round1(p90HighFt),
    p10LowFt: round1(p10LowFt),
    todayMaxHighFt: round1(todayMaxHighFt),
    todayMinLowFt: round1(todayMinLowFt),
    windowDays,
  };
}
