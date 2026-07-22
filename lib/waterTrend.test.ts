import { describe, it, expect } from "vitest";
import { waterTrend, type WaterTrendReading } from "@/lib/waterTrend";

// Fixed "now" so every test is deterministic.
const NOW = Date.parse("2026-07-22T18:00:00Z");
const HOUR = 3_600_000;

/** Hourly readings from `fromH` to `toH` hours ago (inclusive), value from `tempAt(ageH)`. */
function hourlySeries(
  fromH: number,
  toH: number,
  tempAt: (ageH: number) => number,
): WaterTrendReading[] {
  const out: WaterTrendReading[] = [];
  for (let h = fromH; h <= toH; h++) {
    out.push({ t: new Date(NOW - h * HOUR).toISOString(), waterTempF: tempAt(h) });
  }
  return out;
}

describe("waterTrend", () => {
  it("flags a clean cold-upwelling drop (>=3F colder in the last 2 days)", () => {
    // Warm all week (84F), then a step down to 79F within the last day —
    // both the 42-54h and 6.5-7.5d buckets sit in the warm plateau.
    const history = hourlySeries(0, 190, (ageH) => (ageH < 24 ? 79 : 84));
    const trend = waterTrend(history, { nowMs: NOW });
    expect(trend).not.toBeNull();
    expect(trend!.status).toBe("upwelling");
    expect(trend!.deltaF48h).toBe(-5);
    expect(trend!.deltaF7d).toBe(-5);
    expect(trend!.note).toContain("Cold upwelling");
    expect(trend!.note).toContain("5.0");
  });

  it("classifies a milder drop as 'cooling' (between -1.5 and -3F)", () => {
    const history = hourlySeries(0, 190, (ageH) => (ageH < 24 ? 82 : 84));
    const trend = waterTrend(history, { nowMs: NOW })!;
    expect(trend.status).toBe("cooling");
    expect(trend.deltaF48h).toBe(-2);
  });

  it("reports 'steady' when the water hasn't moved", () => {
    const history = hourlySeries(0, 190, () => 82);
    const trend = waterTrend(history, { nowMs: NOW });
    expect(trend).not.toBeNull();
    expect(trend!.status).toBe("steady");
    expect(trend!.deltaF48h).toBe(0);
    expect(trend!.deltaF7d).toBe(0);
  });

  it("flags a fast warm-up (>=3F warmer in the last 2 days)", () => {
    const history = hourlySeries(0, 190, (ageH) => (ageH < 24 ? 87 : 82));
    const trend = waterTrend(history, { nowMs: NOW })!;
    expect(trend.status).toBe("warming-fast");
    expect(trend.deltaF48h).toBe(5);
    expect(trend.note).toContain("warming fast");
  });

  it("returns honest-null on too little history (< 36h span)", () => {
    const history = hourlySeries(0, 20, () => 82); // only 20h of trailing data
    expect(waterTrend(history, { nowMs: NOW })).toBeNull();
  });

  it("returns honest-null when the span is wide enough but readings are too sparse", () => {
    // Spans ~190h (>= 36h) but only 5 scattered readings — way more than 50%
    // of the ~hourly-cadence readings we'd expect are missing.
    const history: WaterTrendReading[] = [10, 50, 90, 130, 180].map((h) => ({
      t: new Date(NOW - h * HOUR).toISOString(),
      waterTempF: 82,
    }));
    expect(waterTrend(history, { nowMs: NOW })).toBeNull();
  });

  it("is outlier-resistant: one 40F garbage reading doesn't flip a steady sea", () => {
    const history = hourlySeries(0, 190, () => 82);
    // Inject one garbage reading in the "recent 6h" bucket and one in the
    // "42-54h ago" bucket — both buckets have enough real readings that a
    // single bad row can't move the median.
    const withOutliers = history.map((r) => {
      const ageH = Math.round((NOW - Date.parse(r.t)) / HOUR);
      if (ageH === 2 || ageH === 48) return { ...r, waterTempF: 40 };
      return r;
    });
    const trend = waterTrend(withOutliers, { nowMs: NOW });
    expect(trend).not.toBeNull();
    expect(trend!.status).toBe("steady");
    expect(trend!.deltaF48h).toBe(0);
  });

  it("an outlier can't manufacture a false upwelling/warming call either", () => {
    const history = hourlySeries(0, 190, () => 82);
    const withOutlier = history.map((r) => {
      const ageH = Math.round((NOW - Date.parse(r.t)) / HOUR);
      return ageH === 1 ? { ...r, waterTempF: 40 } : r;
    });
    const trend = waterTrend(withOutlier, { nowMs: NOW })!;
    expect(trend.status).toBe("steady");
  });

  it("deltaF7d is honestly null when history doesn't reach back 7 days, even though deltaF48h is fine", () => {
    // Only 60h of trailing history: covers the 42-54h bucket but not 6.5-7.5d.
    const history = hourlySeries(0, 60, (ageH) => (ageH < 24 ? 79 : 84));
    const trend = waterTrend(history, { nowMs: NOW });
    expect(trend).not.toBeNull();
    expect(trend!.status).toBe("upwelling");
    expect(trend!.deltaF48h).toBe(-5);
    expect(trend!.deltaF7d).toBeNull();
  });

  it("ignores future-dated / non-finite readings rather than crashing", () => {
    const history: WaterTrendReading[] = [
      ...hourlySeries(0, 190, () => 82),
      { t: new Date(NOW + 3600_000).toISOString(), waterTempF: 999 }, // future
      { t: new Date(NOW - 10 * HOUR).toISOString(), waterTempF: NaN }, // garbage
    ];
    const trend = waterTrend(history, { nowMs: NOW });
    expect(trend).not.toBeNull();
    expect(trend!.status).toBe("steady");
  });

  it("returns null on empty input", () => {
    expect(waterTrend([], { nowMs: NOW })).toBeNull();
  });
});
