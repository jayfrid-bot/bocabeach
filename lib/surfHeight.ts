// Buoy/model wave height (Hs, significant wave height) is NOT what a
// beachgoer or the NWS mean by "surf height" — Hs is the offshore
// statistical average, while breaking wave height for a long-period swell
// runs well above it as the swell shoals into shallow water. This module
// estimates the latter from the former.
//
// THE 2026-09-18 BUG THIS FIXES: the app showed "Waves 1.3 ft" for Boca from
// NDBC 41122's raw WVHT (Hs), while Boca had red flags, a High Rip Current
// Statement, and the NWS Surf Zone Forecast said 4-6 ft. 41122 is ~25 mi
// south of Boca and the only wave-reporting buoy within 100 km — its Hs is
// a real, useful signal, but only once corrected for what long-period swell
// actually does at the shoreline.
//
// FORMULA — Komar & Gaughan (1972) shallow-water breaking-wave relation:
//
//   Hb = 0.39 * g^(1/5) * (T * H0^2)^(2/5)
//
// where H0 is the deep-water significant wave height (m), T is the peak/
// dominant wave period (s), g is gravity, and Hb is the estimated breaking
// (surf) height (m). Longer periods carry more energy per unit height, so
// the same Hs breaks bigger the slower/longer the swell — which is exactly
// the effect the raw Hs number was missing.
//
// ASSUMPTIONS AND CAVEATS — read before trusting this at face value:
//  - It's a DEEP-WATER approximation. NDBC 41122 (the buoy this app reads)
//    sits in ~16 m of water, which is not truly "deep" for a long-period
//    swell (whose orbital motion can already feel the bottom there). At 16 m
//    and a 14 s period the shoaling coefficient Ks is ≈1.015 — the 16 m
//    reading is actually slightly LARGER than the true deep-water H0, not
//    smaller (deshoaling back to H0 would LOWER Hb by about 1%, which is
//    negligible next to everything else this estimate already glosses over).
//    The formula still tracked observed/forecast surf reasonably in one
//    round of backtesting (see
//    docs/benchmarks/2026-09-28-surf-height-validation.md — promising, not
//    broadly validated), but it's a first-order estimate, not a nearshore
//    wave-transformation model.
//  - It ignores refraction, shoaling over the ACTUAL shelf profile between
//    the buoy and any given beach, and local bathymetry — the same offshore
//    height and period can break differently at different beaches.
//  - Guard: a missing period, or one implausible for real ocean swell
//    (at/under MIN_TRUSTED_PERIOD_S, or over MAX_TRUSTED_PERIOD_S), means we
//    don't trust it enough to amplify Hs — fall back to Hb = Hs. Never
//    INFLATE a reading off a period we can't attribute to real swell.
//  - Clamp: whatever the formula computes, Hb is clamped to [Hs, 2.5 x Hs] —
//    a sanity fence so a garbled/extreme period can't blow up the estimate.

import { ftToM, mToFt, round } from "@/lib/util";

const GRAVITY_M_S2 = 9.80665;
const G_POW_ONE_FIFTH = Math.pow(GRAVITY_M_S2, 1 / 5);

/** At/under this period (seconds), treat it as noise rather than real swell. */
export const MIN_TRUSTED_PERIOD_S = 3;
/** Over this period (seconds), treat it as a bad/garbled reading. */
export const MAX_TRUSTED_PERIOD_S = 25;

/** Never report the shore as calmer than the buoy's own offshore reading,
 *  and never more than this multiple of it — see the clamp note above. */
export const MAX_AMPLIFICATION = 2.5;

/**
 * Komar & Gaughan (1972) breaking-wave-height estimate, in meters.
 *
 * `hsM` is the deep-water significant wave height (m); `periodS` is the
 * peak/dominant wave period (s) — NDBC's DPD, validated as the period that
 * fits observed/forecast surf (see the validation doc cited above); NDBC's
 * APD (average period) systematically undershoots in swell and is NOT a
 * substitute.
 *
 * Returns `undefined` only when `hsM` itself is missing/invalid. A missing
 * or implausible period does not fail the estimate — it just falls back to
 * `Hb = Hs` (no amplification) rather than inventing an amplified number
 * from a period we don't trust.
 */
export function breakerHeightM(
  hsM: number | undefined,
  periodS: number | undefined,
): number | undefined {
  if (hsM == null || !Number.isFinite(hsM) || hsM < 0) return undefined;
  const validPeriod =
    periodS != null &&
    Number.isFinite(periodS) &&
    periodS > MIN_TRUSTED_PERIOD_S &&
    periodS <= MAX_TRUSTED_PERIOD_S;
  if (!validPeriod) return hsM; // fallback: no trusted period, don't amplify.

  const hb = 0.39 * G_POW_ONE_FIFTH * Math.pow(periodS * hsM * hsM, 2 / 5);
  // Clamp to a physically sane band around the buoy's own reading.
  return Math.min(Math.max(hb, hsM), MAX_AMPLIFICATION * hsM);
}

/**
 * Feet-in/feet-out convenience wrapper around {@link breakerHeightM} — what
 * the rest of the app (all imperial units) actually calls. Rounded to 0.1 ft,
 * matching the precision `lib/sources/buoy.ts`/`lib/sources/marine.ts` already
 * store wave heights at.
 */
export function estimateSurfHeightFt(
  hsFt: number | undefined,
  periodS: number | undefined,
): number | undefined {
  if (hsFt == null || !Number.isFinite(hsFt) || hsFt < 0) return undefined;
  const hbM = breakerHeightM(ftToM(hsFt), periodS);
  return hbM == null ? undefined : round(mToFt(hbM), 1);
}

export interface SurfSourceInputs {
  /** TOTAL (combined sea-state) significant wave height, ft. */
  totalHeightFt?: number;
  /** The period paired with `totalHeightFt` FROM THE SAME MEASUREMENT — never
   *  a period read off a different (e.g. swell-only) field. */
  totalPeriodS?: number;
  /** The SWELL-only component's height, ft, when the source reports one
   *  separately from the total. */
  swellHeightFt?: number;
  /** The period paired with `swellHeightFt` from that same swell reading. */
  swellPeriodS?: number;
}

export interface SurfSourceResult {
  /** The estimated surf (breaking) height, ft — what the app shows/scores. */
  surfFt?: number;
  /** Whichever raw height actually fed `surfFt` — the secondary "reading"
   *  line's number (never mixed with a period from a different reading). */
  rawHeightFt?: number;
  /** The period paired with `rawHeightFt` above (same reading, matched). */
  rawPeriodS?: number;
}

/**
 * Pick which (height, period) PAIR to run through {@link estimateSurfHeightFt},
 * given that a source (the Open-Meteo marine model, mainly) can report a TOTAL
 * combined-sea-state height/period AND a separate SWELL-only height/period —
 * two independent readings, each internally consistent, but never to be
 * cross-paired (Codex review 2026-09-28 #2): a long SWELL period paired with
 * the TOTAL height (which includes short-period local wind chop the swell
 * period says nothing about) fabricates an amplification the physics doesn't
 * support.
 *
 * Rule: if the total reading carries its OWN period, use it — matched, safe,
 * even if that period later fails the trust guard inside `breakerHeightM` (a
 * self-consistent reading that just isn't trusted is not a mismatch). Only
 * when the total's own period is MISSING do we reach for the swell reading —
 * and then only as a matched swell-height/swell-period pair, never spliced
 * onto the total height — and the result can never read BELOW the raw total
 * Hs (a swell component estimate that undershoots the sea state's own total
 * height is not a correction, so the total wins). With neither period
 * available, the total Hs stands unamplified, exactly as `estimateSurfHeightFt`
 * already does for a missing period on its own.
 *
 * When there's no TOTAL reading at all (Codex review round-2 #2 — a source
 * that only reports the swell component, never the combined sea state), a
 * complete swell height+period pair still estimates surf on its own — there
 * is nothing to compare it against or fall back to, so it isn't withheld.
 * The caller's `waveTotalHsFt` (see `lib/score.ts`'s `Derived`) is left null
 * in that case: there genuinely is no total Hs to report as one.
 */
export function estimateSurfFromSources(inputs: SurfSourceInputs): SurfSourceResult {
  const { totalHeightFt, totalPeriodS, swellHeightFt, swellPeriodS } = inputs;

  if (totalHeightFt == null || !Number.isFinite(totalHeightFt) || totalHeightFt < 0) {
    if (swellHeightFt != null && swellPeriodS != null) {
      return {
        surfFt: estimateSurfHeightFt(swellHeightFt, swellPeriodS),
        rawHeightFt: swellHeightFt,
        rawPeriodS: swellPeriodS,
      };
    }
    return {};
  }

  if (totalPeriodS != null) {
    return {
      surfFt: estimateSurfHeightFt(totalHeightFt, totalPeriodS),
      rawHeightFt: totalHeightFt,
      rawPeriodS: totalPeriodS,
    };
  }

  if (swellHeightFt != null && swellPeriodS != null) {
    const swellSurfFt = estimateSurfHeightFt(swellHeightFt, swellPeriodS);
    if (swellSurfFt != null && swellSurfFt > totalHeightFt) {
      return { surfFt: swellSurfFt, rawHeightFt: swellHeightFt, rawPeriodS: swellPeriodS };
    }
    // The swell component doesn't beat the raw total Hs — report the total,
    // unamplified, rather than a "correction" that reads below it.
    return { surfFt: totalHeightFt, rawHeightFt: totalHeightFt, rawPeriodS: undefined };
  }

  return { surfFt: totalHeightFt, rawHeightFt: totalHeightFt, rawPeriodS: undefined };
}
