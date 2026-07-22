// ---------------------------------------------------------------------------
// Display helpers for the "vs average" cam readouts (busyness + seaweed).
//
// Both cards show a "compared to a typical day" one-liner derived from
// lib/vsAverage.ts. This module owns the FALSE-PRECISION trims so the two cards
// round identically: a handful of cam reads can't justify 1% precision, so we
// round the shown % to the nearest 5, and anything within ±10% raw reads as
// "about typical" (below the noise floor). The deltaPts fallback (near-zero
// baseline) is worded with its unit and a 0 always reads as "typical", never "+0".
//
// Pure + unit-tested (lib/vsAveragePhrase.test.ts). The React cards only map the
// returned tone to their colour classes.
// ---------------------------------------------------------------------------

/** Displayed % deltas are rounded to the nearest 5 (8.19% → "≈10%"). */
export const VS_AVG_ROUND_PCT = 5;
/** ±10% (on the RAW delta, before rounding) reads as "about typical". */
export const TYPICAL_BAND_PCT = 10;

/** Round to the nearest 5. */
export const roundToNearest5 = (n: number): number =>
  Math.round(n / VS_AVG_ROUND_PCT) * VS_AVG_ROUND_PCT;

/** Which way today leans — the card maps this to amber/emerald/slate. */
export type VsAvgTone = "busier" | "quieter" | "typical";

export interface BusynessPhrase {
  text: string;
  tone: VsAvgTone;
}

/**
 * Busyness one-liner. Returns null when there's nothing to say yet (no deltaPct
 * and no deltaPts fallback). "busier"/"quieter" carry the sign; "typical" covers
 * both the ±10% band and a delta that rounds away to nothing.
 */
export function busynessVsAvgPhrase(vsAvg: {
  deltaPct: number | null;
  deltaPts?: number | null;
  weekday: string;
}): BusynessPhrase | null {
  const { deltaPct, deltaPts, weekday } = vsAvg;
  const typical: BusynessPhrase = { text: `about typical for a ${weekday}`, tone: "typical" };
  if (deltaPct != null) {
    if (Math.abs(deltaPct) <= TYPICAL_BAND_PCT) return typical;
    const abs = roundToNearest5(Math.abs(deltaPct));
    if (abs === 0) return typical; // rounded away to nothing → typical, never "≈0%"
    return deltaPct > 0
      ? { text: `≈${abs}% busier than the average ${weekday}`, tone: "busier" }
      : { text: `≈${abs}% quieter than the average ${weekday}`, tone: "quieter" };
  }
  if (deltaPts != null) {
    const n = Math.round(deltaPts);
    if (n === 0) return typical; // never render "+0"
    return n > 0
      ? { text: `≈${n} points fuller than usual`, tone: "busier" }
      : { text: `≈${Math.abs(n)} points emptier than usual`, tone: "quieter" };
  }
  return null;
}

/**
 * Seaweed sub-line fragment (leading " · "), for the seaweed tile. Returns "" until
 * there's enough history. Same rounding/band rules as busyness; the deltaPts
 * fallback names its unit ("coverage") and a 0 reads as typical, never "+0".
 */
export function seaweedVsAvgPhrase(vsAvg?: {
  deltaPct: number | null;
  deltaPts?: number | null;
}): string {
  if (!vsAvg) return "";
  const { deltaPct, deltaPts } = vsAvg;
  const typical = " · typical seaweed for this beach";
  if (deltaPct != null) {
    if (Math.abs(deltaPct) <= TYPICAL_BAND_PCT) return typical;
    const abs = roundToNearest5(Math.abs(deltaPct));
    if (abs === 0) return typical;
    return ` · ≈${abs}% ${deltaPct > 0 ? "more" : "less"} seaweed than average`;
  }
  if (deltaPts != null) {
    const n = Math.round(deltaPts);
    if (n === 0) return typical;
    return ` · ≈${Math.abs(n)} points ${n > 0 ? "more" : "less"} coverage than usual`;
  }
  return "";
}
