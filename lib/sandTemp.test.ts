import { describe, expect, it } from "vitest";
import { estimateSandRangeF, estimateSandTempF, sandVerdict } from "@/lib/sandTemp";

describe("estimateSandTempF", () => {
  it("returns undefined without a ground-surface basis", () => {
    expect(estimateSandTempF({ solarWm2: 900 })).toBeUndefined();
  });

  it("adds the full boost in calm full sun", () => {
    expect(estimateSandTempF({ soilTempF: 100, solarWm2: 1000, windSpeedMph: 0 })).toBe(150);
  });

  it("adds no boost at night (zero radiation)", () => {
    expect(estimateSandTempF({ soilTempF: 80, solarWm2: 0, windSpeedMph: 0 })).toBe(80);
  });

  it("scales the boost with partial sun", () => {
    expect(estimateSandTempF({ soilTempF: 100, solarWm2: 500, windSpeedMph: 0 })).toBe(125);
  });

  it("damps the boost in wind but keeps a floor", () => {
    const calm = estimateSandTempF({ soilTempF: 100, solarWm2: 1000, windSpeedMph: 0 })!;
    const breezy = estimateSandTempF({ soilTempF: 100, solarWm2: 1000, windSpeedMph: 15 })!;
    const gale = estimateSandTempF({ soilTempF: 100, solarWm2: 1000, windSpeedMph: 40 })!;
    expect(breezy).toBeLessThan(calm);
    expect(gale).toBe(Math.round(100 + 50 * 0.6)); // wind floor, not zero
  });

  it("collapses the boost after recent rain", () => {
    const dry = estimateSandTempF({ soilTempF: 100, solarWm2: 900, windSpeedMph: 5 })!;
    const wet = estimateSandTempF({ soilTempF: 100, solarWm2: 900, windSpeedMph: 5, recentRainIn: 0.2 })!;
    expect(wet).toBeLessThan(dry);
    expect(wet - 100).toBeLessThanOrEqual(14);
  });

  it("clamps radiation above full sun", () => {
    expect(estimateSandTempF({ soilTempF: 100, solarWm2: 2000, windSpeedMph: 0 })).toBe(150);
  });
});

describe("estimateSandRangeF", () => {
  it("matches the 2026-06-11 IR ground truth: ~130 near the surf, ~140 by the dunes", () => {
    // Measured ~2 PM: soil 98F, ~980 W/m2 full sun, 11 mph sea breeze.
    const r = estimateSandRangeF({ soilTempF: 98, solarWm2: 980, windSpeedMph: 11 })!;
    expect(r.dunesF).toBeGreaterThanOrEqual(137);
    expect(r.dunesF).toBeLessThanOrEqual(142);
    expect(r.surfF).toBeGreaterThanOrEqual(127);
    expect(r.surfF).toBeLessThanOrEqual(132);
  });

  it("collapses to the ground temp at night (both ends equal)", () => {
    const r = estimateSandRangeF({ soilTempF: 80, solarWm2: 0 })!;
    expect(r.surfF).toBe(80);
    expect(r.dunesF).toBe(80);
  });
});

describe("sandVerdict", () => {
  it("maps the barefoot-comfort bands", () => {
    expect(sandVerdict(85).label).toBe("Barefoot fine");
    expect(sandVerdict(100).label).toBe("Warm");
    expect(sandVerdict(120).label).toBe("Hot");
    expect(sandVerdict(135).label).toBe("Scorching");
  });
});
