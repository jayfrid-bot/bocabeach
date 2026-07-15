import { describe, expect, it } from "vitest";
import {
  CLUMP_CELLS,
  clumpLayout,
  clumpRevealOrder,
  coverageToClumpCount,
  coveredCellIndices,
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

describe("clumpRevealOrder", () => {
  it("is deterministic and a permutation of every cell index", () => {
    const order = clumpRevealOrder(CLUMP_CELLS);
    expect(order).toEqual(clumpRevealOrder(CLUMP_CELLS));
    expect([...order].sort((a, b) => a - b)).toEqual([...Array(CLUMP_CELLS).keys()]);
  });

  it("spreads every prefix across the full range rather than clustering at one end", () => {
    const order = clumpRevealOrder(CLUMP_CELLS);
    // The first quarter of the reveal order should already touch both the
    // low and high halves of the strip, not sit bunched at the left.
    const firstQuarter = order.slice(0, Math.ceil(CLUMP_CELLS / 4));
    expect(firstQuarter.some((i) => i < CLUMP_CELLS / 2)).toBe(true);
    expect(firstQuarter.some((i) => i >= CLUMP_CELLS / 2)).toBe(true);
  });
});

describe("coveredCellIndices", () => {
  it("covers nothing at 0% and everything at 100%", () => {
    expect(coveredCellIndices(0)).toEqual([]);
    expect(coveredCellIndices(100)).toEqual([...Array(CLUMP_CELLS).keys()]);
  });

  it("covers a count matching coverageToClumpCount at 15/40/70%", () => {
    for (const pct of [15, 40, 70]) {
      expect(coveredCellIndices(pct)).toHaveLength(coverageToClumpCount(pct));
    }
  });

  it("spreads covered cells across the full width instead of packing the left X%", () => {
    // At 40% (8 of 20 cells) a left-packed fill would be exactly [0..7] — the
    // covered set must NOT match that, and must include cells from both the
    // left and right halves of the strip.
    const covered = coveredCellIndices(40);
    expect(covered).not.toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(covered.some((i) => i < CLUMP_CELLS / 2)).toBe(true);
    expect(covered.some((i) => i >= CLUMP_CELLS / 2)).toBe(true);
  });

  it("is progressive — higher coverage is a superset of lower coverage", () => {
    const at15 = new Set(coveredCellIndices(15));
    const at40 = new Set(coveredCellIndices(40));
    const at70 = new Set(coveredCellIndices(70));
    for (const i of at15) expect(at40.has(i)).toBe(true);
    for (const i of at40) expect(at70.has(i)).toBe(true);
  });

  it("is deterministic — same coverage always yields the same covered cells", () => {
    expect(coveredCellIndices(40)).toEqual(coveredCellIndices(40));
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
