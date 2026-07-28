import { describe, expect, it } from "vitest";
import { computeTideLevel, interpolateTideHeightFt, raisedCosineEase } from "@/lib/tideLevel";
import type { TideEvent } from "@/lib/types";

const iso = (h: number) => new Date(`2026-07-15T${String(h).padStart(2, "0")}:00:00Z`).toISOString();

describe("computeTideLevel", () => {
  it("returns null with no events", () => {
    expect(computeTideLevel([], Date.parse(iso(12)))).toBeNull();
  });

  it("falls back to a coarse trend-based fraction with a single event", () => {
    const events: TideEvent[] = [{ type: "high", time: iso(14), heightFt: 3 }];
    const rising = computeTideLevel(events, Date.parse(iso(12)), "rising");
    expect(rising?.method).toBe("trend-fallback");
    expect(rising?.heightFt).toBeNull();
    expect(rising?.fraction).toBeLessThan(0.5);

    const falling = computeTideLevel(events, Date.parse(iso(12)), "falling");
    expect(falling?.fraction).toBeGreaterThan(0.5);
  });

  it("infers a rising fallback fraction from event type when trend is omitted", () => {
    const highOnly: TideEvent[] = [{ type: "high", time: iso(14), heightFt: 3 }];
    expect(computeTideLevel(highOnly, Date.parse(iso(12)))?.fraction).toBeLessThan(0.5);
    const lowOnly: TideEvent[] = [{ type: "low", time: iso(14), heightFt: 0.2 }];
    expect(computeTideLevel(lowOnly, Date.parse(iso(12)))?.fraction).toBeGreaterThan(0.5);
  });

  it("sits at the low exactly at a low-tide turning point", () => {
    const events: TideEvent[] = [
      { type: "low", time: iso(12), heightFt: 0.5 },
      { type: "high", time: iso(18), heightFt: 3.5 },
    ];
    const r = computeTideLevel(events, Date.parse(iso(12)));
    expect(r?.method).toBe("interpolated");
    expect(r?.heightFt).toBeCloseTo(0.5, 5);
    expect(r?.fraction).toBeCloseTo(0, 5);
  });

  it("sits at the high exactly at a high-tide turning point", () => {
    const events: TideEvent[] = [
      { type: "low", time: iso(12), heightFt: 0.5 },
      { type: "high", time: iso(18), heightFt: 3.5 },
    ];
    const r = computeTideLevel(events, Date.parse(iso(18)));
    expect(r?.heightFt).toBeCloseTo(3.5, 5);
    expect(r?.fraction).toBeCloseTo(1, 5);
  });

  it("eases through the midpoint via a raised cosine, not a straight lerp", () => {
    const events: TideEvent[] = [
      { type: "low", time: iso(12), heightFt: 0 },
      { type: "high", time: iso(18), heightFt: 4 },
    ];
    // At the temporal midpoint (15:00) the cosine ease is exactly 0.5 — same
    // as a lerp there — but the SLOPE differs, which is the honest part.
    // Check a point 25% of the way through instead: cosine ease at f=0.25 is
    // (1 - cos(pi/4))/2 ≈ 0.1464, well below the 0.25 a linear lerp would give.
    const t = Date.parse(iso(12)) + 0.25 * (Date.parse(iso(18)) - Date.parse(iso(12)));
    const r = computeTideLevel(events, t);
    expect(r?.heightFt).toBeCloseTo(4 * ((1 - Math.cos(Math.PI * 0.25)) / 2), 5);
    expect(r?.heightFt).toBeLessThan(1); // well under the linear-lerp value of 1.0
  });

  it("synthesizes a previous turning point so 'now' before the first event still brackets", () => {
    // Two upcoming events only (as the real API returns) — "now" sits before
    // the first one, which only resolves because of the mirrored previous point.
    const events: TideEvent[] = [
      { type: "high", time: iso(14), heightFt: 3.2 },
      { type: "low", time: iso(20), heightFt: 0.4 },
    ];
    const r = computeTideLevel(events, Date.parse(iso(11)));
    expect(r).not.toBeNull();
    expect(r!.fraction).toBeGreaterThanOrEqual(0);
    expect(r!.fraction).toBeLessThanOrEqual(1);
  });

  it("clamps to the nearest end outside the known window instead of extrapolating", () => {
    const events: TideEvent[] = [
      { type: "low", time: iso(12), heightFt: 0.5 },
      { type: "high", time: iso(18), heightFt: 3.5 },
    ];
    const before = computeTideLevel(events, Date.parse(iso(0)));
    const after = computeTideLevel(events, Date.parse(iso(23)));
    expect(before?.fraction).toBeGreaterThanOrEqual(0);
    expect(after?.fraction).toBeLessThanOrEqual(1);
  });
});

describe("interpolateTideHeightFt — the shared raised-cosine curve", () => {
  // Real CO-OPS hi/lo predictions for gauge 8722670 (Lake Worth Pier), GMT.
  const EVENTS = [
    { type: "low" as const, time: "2026-07-28T17:57:00.000Z", heightFt: 0.003 },
    { type: "high" as const, time: "2026-07-29T00:28:00.000Z", heightFt: 2.883 },
    { type: "low" as const, time: "2026-07-29T06:38:00.000Z", heightFt: 0.363 },
  ];

  it("eases on a cosine, NOT a straight line, between two events", () => {
    const t0 = Date.parse(EVENTS[0].time);
    const t1 = Date.parse(EVENTS[1].time);
    const quarter = t0 + (t1 - t0) * 0.25;
    const got = interpolateTideHeightFt(EVENTS, quarter)!;
    // Raised cosine at f=0.25 is (1 - cos(pi/4))/2 = 0.14645, well BELOW the
    // 0.25 a linear lerp would give — the tide lingers near its turning point.
    const linear = 0.003 + 0.25 * (2.883 - 0.003);
    expect(got).toBeCloseTo(0.003 + 0.14645 * (2.883 - 0.003), 4);
    expect(got).toBeLessThan(linear);
  });

  it("hits each turning point exactly and the midpoint at half the range", () => {
    expect(interpolateTideHeightFt(EVENTS, Date.parse(EVENTS[0].time))).toBeCloseTo(0.003, 6);
    expect(interpolateTideHeightFt(EVENTS, Date.parse(EVENTS[1].time))).toBeCloseTo(2.883, 6);
    const mid = (Date.parse(EVENTS[0].time) + Date.parse(EVENTS[1].time)) / 2;
    expect(interpolateTideHeightFt(EVENTS, mid)).toBeCloseTo((0.003 + 2.883) / 2, 6);
  });

  it("works across a LATER bracket too (it scans the whole window, not just the first pair)", () => {
    const mid = (Date.parse(EVENTS[1].time) + Date.parse(EVENTS[2].time)) / 2;
    expect(interpolateTideHeightFt(EVENTS, mid)).toBeCloseTo((2.883 + 0.363) / 2, 6);
  });

  it("sorts unordered input rather than trusting the caller", () => {
    const shuffled = [EVENTS[2], EVENTS[0], EVENTS[1]];
    const mid = (Date.parse(EVENTS[0].time) + Date.parse(EVENTS[1].time)) / 2;
    expect(interpolateTideHeightFt(shuffled, mid)).toBeCloseTo((0.003 + 2.883) / 2, 6);
  });

  it("returns null OUTSIDE the window — no extrapolation past the last event", () => {
    expect(interpolateTideHeightFt(EVENTS, Date.parse("2026-07-28T12:00:00.000Z"))).toBeNull();
    expect(interpolateTideHeightFt(EVENTS, Date.parse("2026-07-29T12:00:00.000Z"))).toBeNull();
  });

  it("returns null with fewer than two usable events, or an unparseable instant", () => {
    expect(interpolateTideHeightFt([EVENTS[0]], Date.parse(EVENTS[0].time))).toBeNull();
    expect(interpolateTideHeightFt([], 0)).toBeNull();
    expect(interpolateTideHeightFt(EVENTS, NaN)).toBeNull();
  });
});

describe("raisedCosineEase", () => {
  it("is 0 at 0, 1 at 1, 0.5 at the midpoint, and clamps outside [0,1]", () => {
    expect(raisedCosineEase(0)).toBe(0);
    expect(raisedCosineEase(1)).toBeCloseTo(1, 12);
    expect(raisedCosineEase(0.5)).toBeCloseTo(0.5, 12);
    expect(raisedCosineEase(-2)).toBe(0);
    expect(raisedCosineEase(9)).toBeCloseTo(1, 12);
  });
});
