import { describe, expect, it } from "vitest";
import { estimateSandTempF, sandVerdict } from "@/lib/sandTemp";

describe("estimateSandTempF", () => {
  it("returns undefined without a ground-surface basis", () => {
    expect(estimateSandTempF({ solarWm2: 900 })).toBeUndefined();
  });

  it("adds the full boost in calm full sun", () => {
    expect(estimateSandTempF({ soilTempF: 100, solarWm2: 900, windSpeedMph: 0 })).toBe(118);
  });

  it("adds no boost at night (zero radiation)", () => {
    expect(estimateSandTempF({ soilTempF: 80, solarWm2: 0, windSpeedMph: 0 })).toBe(80);
  });

  it("scales the boost with partial sun", () => {
    expect(estimateSandTempF({ soilTempF: 100, solarWm2: 450, windSpeedMph: 0 })).toBe(109);
  });

  it("damps the boost in wind but keeps a floor", () => {
    const calm = estimateSandTempF({ soilTempF: 100, solarWm2: 900, windSpeedMph: 0 })!;
    const breezy = estimateSandTempF({ soilTempF: 100, solarWm2: 900, windSpeedMph: 15 })!;
    const gale = estimateSandTempF({ soilTempF: 100, solarWm2: 900, windSpeedMph: 40 })!;
    expect(breezy).toBeLessThan(calm);
    expect(gale).toBe(Math.round(100 + 18 * 0.35)); // wind floor, not zero
  });

  it("collapses the boost after recent rain", () => {
    const dry = estimateSandTempF({ soilTempF: 100, solarWm2: 900, windSpeedMph: 5 })!;
    const wet = estimateSandTempF({ soilTempF: 100, solarWm2: 900, windSpeedMph: 5, recentRainIn: 0.2 })!;
    expect(wet).toBeLessThan(dry);
    expect(wet - 100).toBeLessThanOrEqual(6);
  });

  it("clamps radiation above full sun", () => {
    expect(estimateSandTempF({ soilTempF: 100, solarWm2: 2000, windSpeedMph: 0 })).toBe(118);
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
