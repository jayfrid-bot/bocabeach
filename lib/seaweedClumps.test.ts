import { describe, expect, it } from "vitest";
import {
  CLUMP_CELLS,
  clumpLayout,
  coverageToClumpCount,
  SEAWEED_LEVEL_FALLBACK_PCT,
} from "@/lib/seaweedClumps";

describe("clumpLayout", () => {
  it("is deterministic — same call always returns the same shapes", () => {
    expect(clumpLayout()).toEqual(clumpLayout());
  });

  it("returns one shape per cell, left to right", () => {
    const shapes = clumpLayout(CLUMP_CELLS);
    expect(shapes).toHaveLength(CLUMP_CELLS);
    expect(shapes.map((s) => s.index)).toEqual([...Array(CLUMP_CELLS).keys()]);
    // centers should be non-decreasing left to right (no reordering from jitter)
    for (let i = 1; i < shapes.length; i++) {
      expect(shapes[i].cx).toBeGreaterThan(shapes[i - 1].cx - 0.05);
    }
  });

  it("keeps every shape within the 0-1 strip bounds", () => {
    for (const s of clumpLayout()) {
      expect(s.cx).toBeGreaterThanOrEqual(0);
      expect(s.cx).toBeLessThanOrEqual(1);
      expect(s.rx).toBeGreaterThan(0);
      expect(s.ry).toBeGreaterThan(0);
    }
  });
});

describe("coverageToClumpCount", () => {
  it("maps 0% and 100% to the extremes", () => {
    expect(coverageToClumpCount(0)).toBe(0);
    expect(coverageToClumpCount(100)).toBe(CLUMP_CELLS);
  });

  it("maps a mid coverage % proportionally", () => {
    expect(coverageToClumpCount(50)).toBe(10);
    expect(coverageToClumpCount(25)).toBe(5);
  });

  it("clamps out-of-range input", () => {
    expect(coverageToClumpCount(-10)).toBe(0);
    expect(coverageToClumpCount(140)).toBe(CLUMP_CELLS);
  });
});

describe("SEAWEED_LEVEL_FALLBACK_PCT", () => {
  it("matches the bands lib/score.ts uses for its sliding seaweed ceiling", () => {
    expect(SEAWEED_LEVEL_FALLBACK_PCT).toMatchObject({
      none: 0,
      low: 15,
      moderate: 40,
      high: 70,
    });
  });
});
