// Pure geometry + derivation helpers for the Strike Radar graphic on
// LightningCard. Kept dependency-free and side-effect-free (no Date.now(),
// no Math.random()) so the SSR and first client render always agree, and so
// the math is unit-testable in isolation from the SVG markup.

import type { LightningData } from "@/lib/types";
import { clamp, round } from "@/lib/util";

/** Range rings drawn on the radar, miles from the beach. */
export const RADAR_RINGS_MI = [5, 10, 25, 50] as const;

/** The app's get-out-of-the-water threshold — styled distinctly on the radar. */
export const RADAR_SAFETY_RING_MI = 5;

/** Outermost ring / radial scale domain. Strikes beyond this are clamped to
 *  the edge rather than overflowing the plot. */
export const RADAR_MAX_MI = 50;

/**
 * Fraction (0-1) of the radar's max radius for a given distance, on a sqrt
 * scale rather than linear.
 *
 * Why sqrt: a linear scale spends most of the plot's area on the 25-50 mi
 * band (which matters least — those strikes aren't a swim-out-of-the-water
 * decision) and crushes the 0-10 mi band into a tiny, illegible core (which
 * matters most). Since ring area grows with r^2 either way, mapping distance
 * through sqrt() makes each ring's pixel radius grow proportional to actual
 * ring area rather than raw distance, which visually equalizes the rings and
 * gives the near field — where the safety-relevant decisions live — far more
 * legible space. It under-represents how much *closer* a 3 mi strike is than
 * a 9 mi one in pixel terms, but the exact "N mi" label (always rendered
 * alongside the marker) carries that precision instead — the plot's job is
 * bearing + rough band, not a precise ruler.
 */
export function radarRadiusFraction(distanceMi: number, maxDistanceMi: number = RADAR_MAX_MI): number {
  if (!Number.isFinite(distanceMi) || maxDistanceMi <= 0) return 0;
  const d = clamp(distanceMi, 0, maxDistanceMi);
  return Math.sqrt(d / maxDistanceMi);
}

export interface RadarPoint {
  x: number;
  y: number;
}

/**
 * Project a bearing (deg, clockwise from north, 0=N/90=E) + distance (mi)
 * into SVG-local coordinates centered on the beach at (0, 0), with +y down
 * (standard SVG) so north points toward -y.
 *
 * Coordinates are rounded to 2 decimals — same convention as WaveHeightCard's
 * `round2` / ScoreWheel's rounded trig — so server and client render the
 * identical path string on hydration.
 */
export function bearingDistanceToPoint(
  bearingDeg: number,
  distanceMi: number,
  maxRadiusPx: number,
  maxDistanceMi: number = RADAR_MAX_MI,
): RadarPoint {
  const frac = radarRadiusFraction(distanceMi, maxDistanceMi);
  const r = frac * maxRadiusPx;
  const rad = (((bearingDeg % 360) + 360) % 360) * (Math.PI / 180);
  const x = r * Math.sin(rad);
  const y = -r * Math.cos(rad);
  // `+ 0` normalizes any -0 (e.g. distance 0, or bearing exactly south/east
  // producing a signed-zero component) to +0 for clean equality checks and a
  // tidier rendered "0" instead of "-0" if ever stringified.
  return { x: round(x, 2) + 0, y: round(y, 2) + 0 };
}

export interface RadarBandCounts {
  /** 0-10 mi */
  inner: number;
  /** 10-25 mi */
  mid: number;
  /** 25-50 mi */
  outer: number;
}

/**
 * Per-band strike counts derived from the CUMULATIVE within10mi/25mi/50mi
 * fields (within10mi ⊆ within25mi ⊆ within50mi upstream). Subtracts adjacent
 * bands to get counts unique to each annulus so the radar never double-counts
 * a strike into more than one ring band.
 *
 * A bad upstream feed could in principle report a smaller cumulative count
 * at a wider radius than a narrower one (e.g. within25mi < within10mi) —
 * clamp any resulting negative to 0 rather than rendering or throwing on a
 * negative dot count.
 */
export function radarBandCounts(
  d: Pick<LightningData, "within10mi" | "within25mi" | "within50mi">,
): RadarBandCounts {
  const w10 = Number.isFinite(d.within10mi) ? d.within10mi : 0;
  const w25 = Number.isFinite(d.within25mi) ? d.within25mi : 0;
  const w50 = Number.isFinite(d.within50mi) ? d.within50mi : 0;
  return {
    inner: Math.max(0, w10),
    mid: Math.max(0, w25 - w10),
    outer: Math.max(0, w50 - w25),
  };
}

/**
 * Deterministic angles (deg, 0-360) to scatter up to `maxDots` density dots
 * within a band. Uses the golden angle (~137.5°) so successive dots spread
 * evenly around the ring without clustering, with no randomness — the same
 * count always produces the same angles, so SSR/client markup matches.
 *
 * These dots represent a COUNT, not real strike positions (we only know the
 * true bearing of the single nearest strike) — deliberately kept small/faint
 * in the component so they read as texture/density, not as plotted events.
 */
export function radarBandDotAngles(count: number, maxDots = 12): number[] {
  const n = Math.min(Math.max(0, Math.floor(count)), maxDots);
  const angles: number[] = [];
  for (let i = 0; i < n; i++) {
    angles.push(round((i * 137.5) % 360, 1));
  }
  return angles;
}
