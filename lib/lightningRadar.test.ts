import { describe, expect, it } from "vitest";
import {
  RADAR_BAND_DENSITY_CAP,
  RADAR_BAND_MAX_OPACITY,
  RADAR_BAND_MIN_OPACITY,
  RADAR_MAX_MI,
  bearingDistanceToPoint,
  radarBandCounts,
  radarBandDensity,
  radarBandOpacity,
  radarRadiusFraction,
} from "@/lib/lightningRadar";

describe("radarRadiusFraction", () => {
  it("is 0 at the center and 1 at the max distance", () => {
    expect(radarRadiusFraction(0)).toBe(0);
    expect(radarRadiusFraction(RADAR_MAX_MI)).toBe(1);
  });

  it("uses a sqrt scale so near-field distances get proportionally more radius than linear would", () => {
    const tenMi = radarRadiusFraction(10);
    const linearTenMi = 10 / RADAR_MAX_MI; // 0.2
    expect(tenMi).toBeGreaterThan(linearTenMi);
    expect(tenMi).toBeCloseTo(Math.sqrt(0.2), 6);
  });

  it("clamps distances beyond the max to the outer edge", () => {
    expect(radarRadiusFraction(500)).toBe(1);
  });

  it("clamps negative/garbage distances to the center rather than going negative", () => {
    expect(radarRadiusFraction(-5)).toBe(0);
    expect(radarRadiusFraction(NaN)).toBe(0);
  });
});

describe("bearingDistanceToPoint", () => {
  const R = 100;

  it("plots due north as straight up (negative y, x=0)", () => {
    const p = bearingDistanceToPoint(0, RADAR_MAX_MI, R);
    expect(p.x).toBe(0);
    expect(p.y).toBeCloseTo(-R, 5);
  });

  it("plots due east as straight right (positive x, y=0)", () => {
    const p = bearingDistanceToPoint(90, RADAR_MAX_MI, R);
    expect(p.x).toBeCloseTo(R, 5);
    expect(p.y).toBeCloseTo(0, 5);
  });

  it("plots due south and west on the opposite sides", () => {
    const south = bearingDistanceToPoint(180, RADAR_MAX_MI, R);
    expect(south.x).toBeCloseTo(0, 5);
    expect(south.y).toBeCloseTo(R, 5);

    const west = bearingDistanceToPoint(270, RADAR_MAX_MI, R);
    expect(west.x).toBeCloseTo(-R, 5);
    expect(west.y).toBeCloseTo(0, 5);
  });

  it("normalizes out-of-range bearings (negative / >360)", () => {
    const a = bearingDistanceToPoint(-90, RADAR_MAX_MI, R); // same as 270
    const b = bearingDistanceToPoint(270, RADAR_MAX_MI, R);
    expect(a).toEqual(b);

    const c = bearingDistanceToPoint(450, RADAR_MAX_MI, R); // same as 90
    const d = bearingDistanceToPoint(90, RADAR_MAX_MI, R);
    expect(c).toEqual(d);
  });

  it("places distance 0 at the exact center regardless of bearing", () => {
    expect(bearingDistanceToPoint(37, 0, R)).toEqual({ x: 0, y: 0 });
  });

  it("rounds coordinates to 2 decimals for hydration-safe output", () => {
    const p = bearingDistanceToPoint(31, 17, 83);
    expect(p.x).toBe(Math.round(p.x * 100) / 100);
    expect(p.y).toBe(Math.round(p.y * 100) / 100);
  });
});

describe("radarBandCounts", () => {
  it("derives non-overlapping per-band counts from cumulative fields", () => {
    const counts = radarBandCounts({ within10mi: 3, within25mi: 8, within50mi: 20 });
    expect(counts).toEqual({ inner: 3, mid: 5, outer: 12 });
  });

  it("sums back up to the outermost cumulative total", () => {
    const d = { within10mi: 2, within25mi: 9, within50mi: 15 };
    const counts = radarBandCounts(d);
    expect(counts.inner + counts.mid + counts.outer).toBe(d.within50mi);
  });

  it("handles an all-zero (all-clear) feed", () => {
    expect(radarBandCounts({ within10mi: 0, within25mi: 0, within50mi: 0 })).toEqual({
      inner: 0,
      mid: 0,
      outer: 0,
    });
  });

  it("clamps negative subtraction results to 0 instead of crashing on a bad/inconsistent feed", () => {
    // within25mi < within10mi should never happen (cumulative fields), but a
    // bad upstream payload shouldn't produce a negative count or throw.
    const counts = radarBandCounts({ within10mi: 10, within25mi: 4, within50mi: 2 });
    expect(counts).toEqual({ inner: 10, mid: 0, outer: 0 });
    expect(Object.values(counts).every((n) => n >= 0)).toBe(true);
  });

  it("treats non-finite inputs as 0 rather than propagating NaN", () => {
    const counts = radarBandCounts({
      within10mi: Number.NaN,
      within25mi: 5,
      within50mi: 5,
    });
    expect(counts.inner).toBe(0);
    expect(Number.isFinite(counts.mid)).toBe(true);
    expect(Number.isFinite(counts.outer)).toBe(true);
  });
});

describe("radarBandDensity", () => {
  it("is 0 for no strikes", () => {
    expect(radarBandDensity(0)).toBe(0);
  });

  it("is 1 at and beyond the cap", () => {
    expect(radarBandDensity(RADAR_BAND_DENSITY_CAP)).toBe(1);
    expect(radarBandDensity(RADAR_BAND_DENSITY_CAP * 10)).toBe(1);
  });

  it("scales proportionally below the cap", () => {
    expect(radarBandDensity(RADAR_BAND_DENSITY_CAP / 2)).toBeCloseTo(0.5, 6);
    expect(radarBandDensity(3, 12)).toBeCloseTo(0.25, 6);
  });

  it("is monotonic — more strikes never produce less density", () => {
    expect(radarBandDensity(2)).toBeLessThan(radarBandDensity(5));
    expect(radarBandDensity(5)).toBeLessThan(radarBandDensity(9));
  });

  it("treats negative/non-finite counts as 0 rather than propagating garbage", () => {
    expect(radarBandDensity(-4)).toBe(0);
    expect(radarBandDensity(Number.NaN)).toBe(0);
  });

  it("respects a custom cap", () => {
    expect(radarBandDensity(5, 5)).toBe(1);
    expect(radarBandDensity(5, 10)).toBeCloseTo(0.5, 6);
  });
});

describe("radarBandOpacity", () => {
  it("is 0 for no strikes", () => {
    expect(radarBandOpacity(0)).toBe(0);
  });

  it("never exceeds RADAR_BAND_MAX_OPACITY, even far beyond the density cap", () => {
    expect(radarBandOpacity(RADAR_BAND_DENSITY_CAP)).toBeCloseTo(RADAR_BAND_MAX_OPACITY, 6);
    expect(radarBandOpacity(RADAR_BAND_DENSITY_CAP * 20)).toBeCloseTo(RADAR_BAND_MAX_OPACITY, 6);
  });

  it("stays well under the old formula's ~0.62 max — a real 27/84-strike count must not look like a solid mass", () => {
    const opacity = radarBandOpacity(84);
    expect(opacity).toBeLessThanOrEqual(0.18);
  });

  it("is at least RADAR_BAND_MIN_OPACITY for any count above 0 — never fully invisible", () => {
    expect(radarBandOpacity(1)).toBeGreaterThanOrEqual(RADAR_BAND_MIN_OPACITY);
  });

  it("is monotonic — more strikes never produce less opacity", () => {
    expect(radarBandOpacity(2)).toBeLessThan(radarBandOpacity(6));
    expect(radarBandOpacity(6)).toBeLessThan(radarBandOpacity(11));
  });

  it("treats negative/non-finite counts as 0 rather than propagating garbage", () => {
    expect(radarBandOpacity(-4)).toBe(0);
    expect(radarBandOpacity(Number.NaN)).toBe(0);
  });

  it("respects a custom cap", () => {
    expect(radarBandOpacity(5, 5)).toBeCloseTo(RADAR_BAND_MAX_OPACITY, 6);
  });
});
