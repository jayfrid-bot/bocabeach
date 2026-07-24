import { describe, it, expect } from "vitest";
import { planLabel, LABEL_R, GAP } from "@/components/ScoreWheel";

/** Same arc-length formula the component uses at the render radius. */
function arcLenFor(weightShare: number): number {
  const span = weightShare * 360 - GAP;
  return ((span * Math.PI) / 180) * LABEL_R;
}

describe("ScoreWheel planLabel — every slice gets readable text", () => {
  // The current weights (lib/score.ts) sum to 1.00 across all 10 factors —
  // the worst case for label width, since removing any factor only makes the
  // remaining shares bigger after renormalization. uv (4%) and crowds (5%)
  // are the two smallest.
  it("uv (4%, the smallest weight) fits its full label tangentially", () => {
    const plan = planLabel("uv", 0, arcLenFor(0.04));
    expect(plan.text).toBe("UV");
    expect(plan.radial).toBe(false);
    expect(plan.fontSize).toBeGreaterThanOrEqual(8);
  });

  it("crowds (5%) falls back to a radial spoke to keep its full word", () => {
    const arcLen = arcLenFor(0.05);
    const plan = planLabel("crowds", 45, arcLen);
    // The tangential arc at 5% is too tight for "Crowds" (6 chars) even with
    // the "Busy" abbreviation — it must go radial to stay readable.
    expect(plan.radial).toBe(true);
    expect(plan.text.length).toBeGreaterThan(0);
  });

  it("comfort (8%) shrinks to its abbreviation instead of dropping", () => {
    const plan = planLabel("comfort", 200, arcLenFor(0.08));
    expect(plan.text).toBe("Humid");
    expect(plan.radial).toBe(false);
  });

  it("sargassum (7%) shrinks to its abbreviation instead of dropping", () => {
    const plan = planLabel("sargassum", 300, arcLenFor(0.07));
    expect(plan.text).toBe("Algae");
  });

  it("never returns empty text, even for a pathologically thin slice", () => {
    const plan = planLabel("crowds", 10, 1 /* near-zero arc */);
    expect(plan.text.length).toBeGreaterThan(0);
    expect(plan.fontSize).toBeGreaterThanOrEqual(8);
  });

  it("upright rotation never renders text upside down (bottom-left quadrant flips)", () => {
    // mid=200 is bottom-left; tangential rotation should flip 180° so the
    // rendered angle (mod 360, SVG rotate wraps) stays out of the upside-down
    // (90, 270) band.
    const plan = planLabel("wind", 200, arcLenFor(0.13));
    const norm = ((plan.rot % 360) + 360) % 360;
    expect(norm <= 90 || norm >= 270).toBe(true);
  });

  it("adjacent thin radial spokes diverge (different mid-angles never collide)", () => {
    const a = planLabel("crowds", 40, arcLenFor(0.05));
    const b = planLabel("sargassum", 65, arcLenFor(0.07));
    expect(a.rot).not.toBe(b.rot);
  });
});
