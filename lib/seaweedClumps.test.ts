import { describe, expect, it } from "vitest";
import {
  BACK_SLOTS,
  coverageToStampCounts,
  FRONT_SLOTS,
  SEAWEED_LEVEL_FALLBACK_PCT,
  STRIP_H,
  STRIP_W,
  WATERLINE_Y,
  wrackLayout,
  wrackLineY,
  wrackRevealOrder,
} from "@/lib/seaweedClumps";

/** Count stamps per horizontal quartile of the strip. */
function quartileCounts(pcts: { x: number }[]): number[] {
  const q = [0, 0, 0, 0];
  for (const s of pcts) q[Math.min(3, Math.floor((s.x / STRIP_W) * 4))]++;
  return q;
}

describe("wrackRevealOrder", () => {
  it("is deterministic and a permutation of every slot index", () => {
    for (const slots of [FRONT_SLOTS, BACK_SLOTS]) {
      const order = wrackRevealOrder(slots);
      expect(order).toEqual(wrackRevealOrder(slots));
      expect([...order].sort((a, b) => a - b)).toEqual([...Array(slots).keys()]);
    }
  });

  it("spreads every prefix across the full range rather than clustering at one end", () => {
    const order = wrackRevealOrder(FRONT_SLOTS);
    // The first quarter of the reveal order should already touch both the
    // low and high halves of the strip, not sit bunched at the left.
    const firstQuarter = order.slice(0, Math.ceil(FRONT_SLOTS / 4));
    expect(firstQuarter.some((i) => i < FRONT_SLOTS / 2)).toBe(true);
    expect(firstQuarter.some((i) => i >= FRONT_SLOTS / 2)).toBe(true);
  });
});

describe("coverageToStampCounts", () => {
  it("maps the anchor coverages to the documented clump counts", () => {
    expect(coverageToStampCounts(0)).toEqual({ front: 0, back: 0, total: 0 });
    expect(coverageToStampCounts(15)).toEqual({ front: 4, back: 0, total: 4 });
    expect(coverageToStampCounts(40)).toEqual({ front: 10, back: 0, total: 10 });
    expect(coverageToStampCounts(70)).toEqual({ front: 17, back: 5, total: 22 });
    expect(coverageToStampCounts(100)).toEqual({
      front: FRONT_SLOTS,
      back: BACK_SLOTS,
      total: FRONT_SLOTS + BACK_SLOTS,
    });
  });

  it("keeps the thickening back row empty until coverage passes 50%", () => {
    for (const pct of [0, 10, 25, 40, 50]) {
      expect(coverageToStampCounts(pct).back).toBe(0);
    }
    expect(coverageToStampCounts(60).back).toBeGreaterThan(0);
  });

  it("is monotonically non-decreasing in coverage, and strictly rising across the anchors", () => {
    let prev = -1;
    for (let pct = 0; pct <= 100; pct++) {
      const t = coverageToStampCounts(pct).total;
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
    const anchors = [0, 15, 40, 70, 100].map((p) => coverageToStampCounts(p).total);
    for (let i = 1; i < anchors.length; i++) {
      expect(anchors[i]).toBeGreaterThan(anchors[i - 1]);
    }
  });

  it("clamps out-of-range input", () => {
    expect(coverageToStampCounts(-10).total).toBe(0);
    expect(coverageToStampCounts(140).total).toBe(FRONT_SLOTS + BACK_SLOTS);
  });
});

describe("wrackLineY", () => {
  it("is wavy (not ruler-straight) but stays a gentle band", () => {
    const ys = Array.from({ length: 41 }, (_, i) => wrackLineY(i * 10));
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(3);
    // ...and the whole line stays between the wet sand and the strip bottom.
    for (const y of ys) {
      expect(y).toBeGreaterThan(WATERLINE_Y);
      expect(y).toBeLessThan(STRIP_H);
    }
  });
});

describe("wrackLayout", () => {
  it("is deterministic — same coverage always yields an identical layout", () => {
    for (const pct of [0, 15, 40, 70, 100, 43]) {
      expect(wrackLayout(pct)).toEqual(wrackLayout(pct));
    }
  });

  it("renders no clumps at 0% and one stamp per slot at 100%", () => {
    expect(wrackLayout(0)).toEqual([]);
    expect(wrackLayout(100)).toHaveLength(FRONT_SLOTS + BACK_SLOTS);
  });

  it("matches coverageToStampCounts at every anchor coverage", () => {
    for (const pct of [0, 15, 40, 70, 100]) {
      expect(wrackLayout(pct)).toHaveLength(coverageToStampCounts(pct).total);
    }
  });

  it("spreads partial coverage across the FULL width — every quartile occupied, never left-packed", () => {
    // 15%: sparse tufts, but still one in each quarter of the strip.
    expect(quartileCounts(wrackLayout(15)).every((n) => n >= 1)).toBe(true);
    // 40%: a broken band with at least two clumps per quarter.
    const q40 = quartileCounts(wrackLayout(40));
    expect(q40.every((n) => n >= 2)).toBe(true);
    // ...and explicitly not packed into the leftmost 40% of the strip.
    const xs40 = wrackLayout(40).map((s) => s.x);
    expect(Math.max(...xs40)).toBeGreaterThan(STRIP_W * 0.75);
  });

  it("is progressive — slots covered at a lower coverage stay covered at a higher one", () => {
    const frontSlots = (pct: number) =>
      new Set(wrackLayout(pct).filter((s) => s.row === "front").map((s) => s.slot));
    const at15 = frontSlots(15);
    const at40 = frontSlots(40);
    const at70 = frontSlots(70);
    for (const s of at15) expect(at40.has(s)).toBe(true);
    for (const s of at40) expect(at70.has(s)).toBe(true);
  });

  it("thickens the band as coverage rises — taller y-spread and bigger clumps", () => {
    const spread = (pct: number) => {
      const ys = wrackLayout(pct).map((s) => s.y);
      return Math.max(...ys) - Math.min(...ys);
    };
    expect(spread(70)).toBeGreaterThan(spread(40));
    const maxScale = (pct: number) => Math.max(...wrackLayout(pct).map((s) => s.scale));
    expect(maxScale(100)).toBeGreaterThan(maxScale(15));
  });

  it("keeps every stamp on the sand side of the waterline and inside the strip", () => {
    for (const pct of [15, 40, 70, 100]) {
      for (const s of wrackLayout(pct)) {
        expect(s.x).toBeGreaterThanOrEqual(0);
        expect(s.x).toBeLessThanOrEqual(STRIP_W);
        expect(s.y).toBeGreaterThan(WATERLINE_Y);
        expect(s.y).toBeLessThan(STRIP_H);
        expect(s.scale).toBeGreaterThan(0);
        expect([0, 1, 2]).toContain(s.variant);
        expect([0, 1, 2]).toContain(s.tone);
      }
    }
  });

  it("emits painter's order (sorted by y) with unique keys", () => {
    const stamps = wrackLayout(100);
    for (let i = 1; i < stamps.length; i++) {
      expect(stamps[i].y).toBeGreaterThanOrEqual(stamps[i - 1].y);
    }
    expect(new Set(stamps.map((s) => s.key)).size).toBe(stamps.length);
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
