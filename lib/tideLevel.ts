// Pure tide-height interpolation, shared by the tide cross-section graphic.
// No Date.now()/Math.random() in here — callers pass `nowMs` explicitly so
// server and client render the same output (see TideCrossSection.tsx).

import type { TideEvent } from "@/lib/types";

export type TideLevelMethod = "interpolated" | "trend-fallback";

export interface TideLevelResult {
  /** 0 (lowest known level in the window) .. 1 (highest). Always present. */
  fraction: number;
  /**
   * Estimated current height in feet. Only set for `"interpolated"` — with a
   * single known event there's no honest way to back out an absolute height,
   * so the fallback only claims a rough position, not a number.
   */
  heightFt: number | null;
  method: TideLevelMethod;
  /** The low/high bracketing the fraction, for labeling the water range. */
  loFt: number;
  hiFt: number;
}

/**
 * Estimate where the tide sits right now between its surrounding turning
 * points.
 *
 * Real tides move like simple harmonic motion (fast through the mid-tide,
 * flattening out near the high/low extremes) — not a straight ramp. So
 * between two bracketing events we ease with a raised cosine:
 *   height = h0 + (1 - cos(pi * f)) / 2 * (h1 - h0)
 * which is 0 slope at each end and steepest at the midpoint. A linear lerp
 * would be simpler but dishonest: it implies a constant rise/fall rate that
 * real tides don't have. (Same formula TideCurve.tsx already draws with.)
 *
 * The upstream API only returns *upcoming* events, so to bracket "now" (which
 * is almost always before the first event) we mirror a synthetic previous
 * turning point: opposite type, one typical interval earlier, height borrowed
 * from the next same-type event. Tides alternate with a near-constant
 * interval, so this is a reasonable stand-in for the real (unreported) past
 * event.
 *
 * With only one known event there's nothing to mirror an interval from, so
 * we fall back to a coarse trend-based placement (see `method`) instead of
 * fabricating a bracket.
 */
export function computeTideLevel(
  events: TideEvent[],
  nowMs: number,
  trend?: "rising" | "falling",
): TideLevelResult | null {
  if (events.length === 0) return null;

  if (events.length === 1) {
    const e = events[0];
    const rising = trend === "rising" || (trend == null && e.type === "high");
    // Honest but coarse: we know the *direction*, not the absolute height, so
    // park the water a bit off-center toward whichever end it's heading —
    // not a precise read, just enough to make the graphic point the right way.
    return {
      fraction: rising ? 0.35 : 0.65,
      heightFt: null,
      method: "trend-fallback",
      loFt: e.heightFt,
      hiFt: e.heightFt,
    };
  }

  const next = events.map((e) => ({ ...e, t: new Date(e.time).getTime() }));
  const prev = {
    type: next[1].type,
    t: next[0].t - (next[1].t - next[0].t),
    heightFt: next[1].heightFt,
  };
  const pts = [prev, ...next];

  const t0 = pts[0].t;
  const tN = pts[pts.length - 1].t;
  const t = Math.max(t0, Math.min(tN, nowMs));

  let heightFt = pts[pts.length - 1].heightFt;
  for (let i = 0; i < pts.length - 1; i++) {
    if (t <= pts[i + 1].t) {
      const f = (t - pts[i].t) / (pts[i + 1].t - pts[i].t);
      const ease = (1 - Math.cos(Math.PI * f)) / 2;
      heightFt = pts[i].heightFt + ease * (pts[i + 1].heightFt - pts[i].heightFt);
      break;
    }
  }

  const hts = pts.map((p) => p.heightFt);
  const loFt = Math.min(...hts);
  const hiFt = Math.max(...hts);
  const span = Math.max(hiFt - loFt, 0.001);
  const fraction = Math.min(1, Math.max(0, (heightFt - loFt) / span));

  return { fraction, heightFt, method: "interpolated", loFt, hiFt };
}
