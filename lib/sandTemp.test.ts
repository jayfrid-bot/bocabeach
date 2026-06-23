import { describe, expect, it } from "vitest";
import {
  currentSandRangeF,
  currentSandTempF,
  estimateSandRangeF,
  estimateSandTempF,
  sandVerdict,
} from "@/lib/sandTemp";

describe("estimateSandTempF", () => {
  it("returns undefined without a ground-surface basis", () => {
    expect(estimateSandTempF({ solarWm2: 900 })).toBeUndefined();
  });

  it("adds the full boost in calm full sun", () => {
    expect(estimateSandTempF({ soilTempF: 80, solarWm2: 1000, windSpeedMph: 0 })).toBe(135);
  });

  it("adds no boost at night (zero radiation)", () => {
    expect(estimateSandTempF({ soilTempF: 80, solarWm2: 0, windSpeedMph: 0 })).toBe(80);
  });

  it("scales the boost concavely with partial sun (sqrt, not linear)", () => {
    // 50% sun → ~71% of the full boost: dry sand heats fast even at moderate sun.
    expect(estimateSandTempF({ soilTempF: 80, solarWm2: 500, windSpeedMph: 0 })).toBe(119);
  });

  it("damps the boost in wind but keeps a floor", () => {
    const calm = estimateSandTempF({ soilTempF: 80, solarWm2: 1000, windSpeedMph: 0 })!;
    const breezy = estimateSandTempF({ soilTempF: 80, solarWm2: 1000, windSpeedMph: 15 })!;
    const gale = estimateSandTempF({ soilTempF: 80, solarWm2: 1000, windSpeedMph: 40 })!;
    expect(breezy).toBeLessThan(calm);
    expect(gale).toBe(Math.round(80 + 55 * 0.6)); // wind floor, not zero
  });

  it("collapses the boost after recent rain", () => {
    const dry = estimateSandTempF({ soilTempF: 100, solarWm2: 900, windSpeedMph: 5 })!;
    const wet = estimateSandTempF({ soilTempF: 100, solarWm2: 900, windSpeedMph: 5, recentRainIn: 0.2 })!;
    expect(wet).toBeLessThan(dry);
    expect(wet - 100).toBeLessThanOrEqual(14);
  });

  it("clamps radiation above full sun", () => {
    expect(estimateSandTempF({ soilTempF: 80, solarWm2: 2000, windSpeedMph: 0 })).toBe(135);
  });
});

describe("estimateSandRangeF", () => {
  it("matches the 2026-06-11 IR ground truth: ~130 near the surf, ~140 by the dunes", () => {
    // Measured ~2 PM: soil 98F, ~980 W/m2 full sun, 11 mph sea breeze.
    const r = estimateSandRangeF({ soilTempF: 98, solarWm2: 980, windSpeedMph: 11 })!;
    expect(r.dunesF).toBeGreaterThanOrEqual(133);
    expect(r.dunesF).toBeLessThanOrEqual(140);
    expect(r.surfF).toBeGreaterThanOrEqual(119);
    expect(r.surfF).toBeLessThanOrEqual(128);
    expect(r.surfF).toBeLessThan(r.dunesF); // wet surf sand cooler than dry dunes
  });


  it("matches the 2026-06-15 IR ground truth: 129-135°F on a hot-soil afternoon", () => {
    // Measured ~1 PM: soil 109F (hotter baseline than 6/11), 820 W/m2, 10 mph.
    // The ground-damp factor keeps the model from double-counting solar
    // heating that the modeled soil temp already absorbs.
    const r = estimateSandRangeF({ soilTempF: 109, solarWm2: 820, windSpeedMph: 10 })!;
    expect(r.dunesF).toBeGreaterThanOrEqual(130);
    expect(r.dunesF).toBeLessThanOrEqual(140);
    expect(r.surfF).toBeGreaterThanOrEqual(125);
    expect(r.surfF).toBeLessThanOrEqual(133);
  });

  it("matches the 2026-06-23 IR ground truth: 113°F surf / 124°F dunes (low morning sun)", () => {
    // Measured ~9:54 AM: soil 91F, 380 W/m2 (moderate morning sun), 2 mph. The
    // concave solar response captures dry sand running hot even below 40% sun.
    const r = estimateSandRangeF({ soilTempF: 91, solarWm2: 380, windSpeedMph: 2 })!;
    expect(r.surfF).toBeGreaterThanOrEqual(110);
    expect(r.surfF).toBeLessThanOrEqual(116);
    expect(r.dunesF).toBeGreaterThanOrEqual(120);
    expect(r.dunesF).toBeLessThanOrEqual(127);
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

describe("current sand value: card and score agree", () => {
  // The metric card (range) and the score (single dunes value) must read the
  // SAME hour bucket, so the dunes end of the range equals the scored value.
  const hours = Array.from({ length: 6 }, (_, i) => ({
    time: new Date(Date.parse("2026-06-17T15:00:00Z") + i * 3600_000).toISOString(),
    soilTempF: 90 + i,
    solarWm2: 800,
    windSpeedMph: 8,
    precipIn: 0,
  }));
  const now = Date.parse("2026-06-17T16:30:00Z"); // inside the 16:00 bucket

  it("range dunes end equals the single scored value", () => {
    const single = currentSandTempF(hours, now);
    const range = currentSandRangeF(hours, now);
    expect(range).not.toBeUndefined();
    expect(range!.dunesF).toBe(single);
    expect(range!.surfF).toBeLessThanOrEqual(range!.dunesF); // surf never hotter than dunes
  });

  it("returns undefined together when no bucket is near now", () => {
    const far = Date.parse("2026-06-20T16:30:00Z");
    expect(currentSandTempF(hours, far)).toBeUndefined();
    expect(currentSandRangeF(hours, far)).toBeUndefined();
  });
});
