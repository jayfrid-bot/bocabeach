import { describe, it, expect } from "vitest";
import {
  vsAverage,
  weekdayName,
  DEFAULT_LOOKBACK_DAYS,
  NEAR_ZERO_BASELINE,
  HOUR_MIN,
  HOUR_MAX,
  type VsAverageEntry,
} from "@/lib/vsAverage";

// A local ISO timestamp (with -04:00 offset) for a given date + hour.
const at = (date: string, hour: number): string =>
  `${date}T${String(hour).padStart(2, "0")}:00:00-04:00`;

// Build a crowdPct read.
const crowd = (date: string, hour: number, crowdPct: number): VsAverageEntry =>
  ({ t: at(date, hour), hour, crowdPct }) as VsAverageEntry;

// Build a cov (seaweed coverage) read.
const cov = (date: string, hour: number, cv: number): VsAverageEntry =>
  ({ t: at(date, hour), hour, cov: cv }) as VsAverageEntry;

describe("weekdayName", () => {
  it("derives the weekday from a YYYY-MM-DD date, tz-independent", () => {
    expect(weekdayName("2026-07-21")).toBe("Tuesday");
    expect(weekdayName("2026-07-20")).toBe("Monday");
    expect(weekdayName("2026-07-19")).toBe("Sunday");
  });
  it("returns null for a malformed date", () => {
    expect(weekdayName("nope")).toBeNull();
  });
});

describe("vsAverage — hour matching (the core honesty rule)", () => {
  it("restricts the baseline to today's hours: a morning-only today ignores afternoon history", () => {
    // Today (2026-07-21, Tuesday) has ONLY a 9 AM read at 20%.
    const today = [crowd("2026-07-21", 9, 20)];
    // Prior Tuesdays: calm mornings (9 AM ≈ 20) but packed afternoons (16 ≈ 90).
    // If the afternoon leaked into the baseline, today would look far "quieter".
    const history: VsAverageEntry[] = [
      ...today,
      crowd("2026-07-14", 9, 22),
      crowd("2026-07-14", 16, 90),
      crowd("2026-07-07", 9, 18),
      crowd("2026-07-07", 16, 88),
      crowd("2026-06-30", 9, 20),
      crowd("2026-06-30", 16, 92),
    ];
    const r = vsAverage(history, "2026-07-21", { matchWeekday: true }, "crowdPct");
    // Baseline uses ONLY hour 9: mean(22,18,20)=20 → today 20 vs 20 → ~0%.
    expect(r.baselineMean).toBeCloseTo(20, 5);
    expect(r.baselineSamples).toBe(3); // three hour-9 cells; the afternoon reads are excluded
    expect(Math.round(r.deltaPct!)).toBe(0);
  });
});

describe("vsAverage — day-hour cell binning (equal weight per hour, not per read)", () => {
  it("a dense baseline day counts the same as a sparse one at the same hour", () => {
    // One dense day (SIX reads at hour 12, all 60) and one sparse day (ONE read
    // at 20). Per-read pooling → (6×60+20)/7 ≈ 54.3; per-CELL → (60+20)/2 = 40.
    const history: VsAverageEntry[] = [
      crowd("2026-07-21", 12, 40), // today
      ...Array.from({ length: 6 }, () => crowd("2026-07-20", 12, 60)), // dense day
      crowd("2026-07-19", 12, 20), // sparse day
    ];
    const r = vsAverage(
      history,
      "2026-07-21",
      { matchWeekday: false, minBaselineDays: 1, minBaselineSamples: 1 },
      "crowdPct",
    );
    expect(r.baselineMean).toBeCloseTo(40, 5); // (60 + 20) / 2, NOT the pooled 54.3
    expect(r.baselineSamples).toBe(2); // two day-hour cells, not seven reads
    expect(r.baselineDays).toBe(2);
    expect(Math.round(r.deltaPct!)).toBe(0); // today 40 vs 40
  });

  it("drops a today-hour with zero baseline coverage from BOTH sides (the todayMean-skew bug)", () => {
    // Today has a well-supported hour 9 AND a lone hour-18 spike never seen on any
    // prior day. The stray hour must not leak into todayMean.
    const history: VsAverageEntry[] = [
      crowd("2026-07-21", 9, 20),
      crowd("2026-07-21", 18, 90), // no baseline at 18 → excluded from todayMean
      crowd("2026-07-20", 9, 20),
      crowd("2026-07-19", 9, 20),
      crowd("2026-07-18", 9, 20),
    ];
    const r = vsAverage(
      history,
      "2026-07-21",
      { matchWeekday: false, minBaselineDays: 1, minBaselineSamples: 1 },
      "crowdPct",
    );
    expect(r.todayMean).toBe(20); // the unsupported 90 is gone, not blended in
    expect(r.baselineMean).toBeCloseTo(20, 5);
    expect(Math.round(r.deltaPct!)).toBe(0);
  });

  it("ignores reads outside local hours 6–20 on both sides", () => {
    expect(HOUR_MIN).toBe(6);
    expect(HOUR_MAX).toBe(20);
    const history: VsAverageEntry[] = [
      crowd("2026-07-21", 12, 30),
      crowd("2026-07-21", 22, 99), // night today → ignored
      crowd("2026-07-20", 12, 20),
      crowd("2026-07-20", 22, 5), // night baseline → ignored
      crowd("2026-07-19", 12, 20),
      crowd("2026-07-18", 12, 20),
    ];
    const r = vsAverage(
      history,
      "2026-07-21",
      { matchWeekday: false, minBaselineDays: 1, minBaselineSamples: 1 },
      "crowdPct",
    );
    expect(r.todayMean).toBe(30); // the 22:00 99 never counted
    expect(r.baselineMean).toBeCloseTo(20, 5); // three hour-12 cells only
    expect(r.baselineSamples).toBe(3);
  });
});

describe("vsAverage — NEAR_ZERO_BASELINE boundary (10)", () => {
  it("is 10", () => {
    expect(NEAR_ZERO_BASELINE).toBe(10);
  });

  // Eight prior days, one hour-12 cell each, all at value `v`; today is 20.
  const build = (v: number): VsAverageEntry[] => [
    cov("2026-07-21", 12, 20),
    ...[20, 19, 18, 17, 16, 15, 14, 13].map((d) => cov(`2026-07-${d}`, 12, v)),
  ];

  it("a baseline mean below 10 falls back to deltaPts (ratio suppressed)", () => {
    const r = vsAverage(build(9), "2026-07-21", { matchWeekday: false }, "cov");
    expect(r.baselineMean).toBeCloseTo(9, 5);
    expect(r.deltaPct).toBeNull();
    expect(r.deltaPts).toBeCloseTo(20 - 9, 5);
  });

  it("a baseline mean at/above 10 reports a ratio", () => {
    const r = vsAverage(build(10), "2026-07-21", { matchWeekday: false }, "cov");
    expect(r.baselineMean).toBeCloseTo(10, 5);
    expect(Math.round(r.deltaPct!)).toBe(100); // 20 vs 10
    expect(r.deltaPts).toBeUndefined();
  });
});

describe("vsAverage — weekday matching on/off", () => {
  // Today 2026-07-21 (Tuesday), one 12:00 read at 30.
  const today = [crowd("2026-07-21", 12, 30)];
  // Tuesdays run quiet (~20) at noon; weekends run busy (~60).
  const history: VsAverageEntry[] = [
    ...today,
    crowd("2026-07-14", 12, 20), // Tue
    crowd("2026-07-07", 12, 22), // Tue
    crowd("2026-06-30", 12, 18), // Tue
    crowd("2026-07-18", 12, 60), // Sat
    crowd("2026-07-19", 12, 62), // Sun
    crowd("2026-07-11", 12, 58), // Sat
  ];

  it("matchWeekday=true restricts to the same weekday", () => {
    // Guards relaxed to isolate the weekday logic (tiny synthetic baseline).
    const r = vsAverage(
      history,
      "2026-07-21",
      { matchWeekday: true, minBaselineDays: 1, minBaselineSamples: 1 },
      "crowdPct",
    );
    expect(r.baselineSamples).toBe(3); // only the three Tuesdays
    expect(r.baselineMean).toBeCloseTo(20, 5);
    expect(Math.round(r.deltaPct!)).toBe(50); // 30 vs 20 → +50%
  });

  it("matchWeekday=false blends every weekday", () => {
    const r = vsAverage(
      history,
      "2026-07-21",
      { matchWeekday: false, minBaselineDays: 1, minBaselineSamples: 1 },
      "crowdPct",
    );
    expect(r.baselineSamples).toBe(6); // all six prior reads
    expect(r.baselineMean).toBeCloseTo(40, 5); // (20+22+18+60+62+58)/6
    expect(Math.round(r.deltaPct!)).toBe(-25); // 30 vs 40 → −25%
  });
});

describe("vsAverage — lookback cutoff", () => {
  it("excludes reads older than lookbackDays", () => {
    const today = [cov("2026-07-21", 10, 40)];
    const history: VsAverageEntry[] = [
      ...today,
      cov("2026-07-14", 10, 10), // 7 days ago — inside a 10-day window
      cov("2026-07-05", 10, 10), // 16 days ago — outside a 10-day window
      cov("2026-06-20", 10, 10), // way outside
    ];
    const r = vsAverage(
      history,
      "2026-07-21",
      { matchWeekday: false, lookbackDays: 10, minBaselineDays: 1, minBaselineSamples: 1 },
      "cov",
    );
    expect(r.baselineSamples).toBe(1); // only the 7-days-ago read survives
    expect(r.baselineMean).toBeCloseTo(10, 5);
  });

  it("default lookback is ~8 weeks", () => {
    expect(DEFAULT_LOOKBACK_DAYS).toBe(56);
  });
});

describe("vsAverage — the four null guards", () => {
  const baseHistory: VsAverageEntry[] = [
    crowd("2026-07-14", 12, 20),
    crowd("2026-07-07", 12, 22),
    crowd("2026-06-30", 12, 18),
    crowd("2026-07-14", 9, 20),
    crowd("2026-07-07", 9, 22),
    crowd("2026-06-30", 9, 18),
    crowd("2026-07-14", 16, 40),
    crowd("2026-07-07", 16, 42),
  ];

  it("today has no reads yet → null", () => {
    // History exists but nothing dated today (2026-07-21).
    const r = vsAverage(baseHistory, "2026-07-21", { matchWeekday: false }, "crowdPct");
    expect(r.deltaPct).toBeNull();
    expect(r.deltaPts).toBeUndefined();
    expect(r.todayMean).toBeNull();
  });

  it("baselineDays < minBaselineDays → null", () => {
    // Today + a baseline with enough CELLS (2 days × 3 hours = 6) but only 2
    // distinct days — the day guard, not the sample guard, is what fires.
    const history: VsAverageEntry[] = [
      crowd("2026-07-21", 12, 30),
      crowd("2026-07-21", 14, 30),
      crowd("2026-07-21", 16, 30),
      crowd("2026-07-14", 12, 20),
      crowd("2026-07-14", 14, 20),
      crowd("2026-07-14", 16, 20),
      crowd("2026-07-07", 12, 22),
      crowd("2026-07-07", 14, 22),
      crowd("2026-07-07", 16, 22),
    ];
    const r = vsAverage(
      history,
      "2026-07-21",
      { matchWeekday: false, minBaselineDays: 3, minBaselineSamples: 3 },
      "crowdPct",
    );
    expect(r.baselineDays).toBe(2);
    expect(r.baselineSamples).toBe(6); // 2 days × 3 supported hours = 6 cells
    expect(r.deltaPct).toBeNull();
  });

  it("baselineSamples < minBaselineSamples → null", () => {
    const history: VsAverageEntry[] = [
      crowd("2026-07-21", 12, 30),
      crowd("2026-07-14", 12, 20),
      crowd("2026-07-07", 12, 22),
      crowd("2026-06-30", 12, 18),
    ];
    // 3 distinct days (≥ default 3) but only 3 samples (< default 8).
    const r = vsAverage(history, "2026-07-21", { matchWeekday: false }, "crowdPct");
    expect(r.baselineDays).toBe(3);
    expect(r.baselineSamples).toBe(3);
    expect(r.deltaPct).toBeNull();
  });

  it("near-zero baseline → deltaPct null", () => {
    const history: VsAverageEntry[] = [
      cov("2026-07-21", 12, 12),
      cov("2026-07-20", 12, 0),
      cov("2026-07-19", 12, 1),
      cov("2026-07-18", 12, 0),
      cov("2026-07-17", 12, 2),
      cov("2026-07-16", 12, 0),
      cov("2026-07-15", 12, 1),
      cov("2026-07-14", 12, 0),
      cov("2026-07-13", 12, 1),
    ];
    const r = vsAverage(history, "2026-07-21", { matchWeekday: false }, "cov");
    expect(r.baselineMean).toBeLessThan(3);
    expect(r.deltaPct).toBeNull();
  });
});

describe("vsAverage — near-zero baseline deltaPts path", () => {
  it("returns a raw points delta instead of a runaway ratio", () => {
    // Baseline coverage averages well under 3 (near-zero); today is 12.
    const history: VsAverageEntry[] = [
      cov("2026-07-21", 12, 12),
      cov("2026-07-20", 12, 0),
      cov("2026-07-19", 12, 1),
      cov("2026-07-18", 12, 0),
      cov("2026-07-17", 12, 2),
      cov("2026-07-16", 12, 0),
      cov("2026-07-15", 12, 1),
      cov("2026-07-14", 12, 0),
      cov("2026-07-13", 12, 1),
    ];
    const r = vsAverage(history, "2026-07-21", { matchWeekday: false }, "cov");
    expect(r.deltaPct).toBeNull(); // no misleading "1100% more seaweed"
    expect(r.deltaPts).not.toBeNull();
    // baseline mean = (0+1+0+2+0+1+0+1)/8 = 0.625; today 12 → +11.375 pts.
    expect(r.deltaPts).toBeCloseTo(12 - 0.625, 5);
  });
});

describe("vsAverage — deltaPct signs", () => {
  const baseline: VsAverageEntry[] = [
    crowd("2026-07-14", 12, 40),
    crowd("2026-07-07", 12, 40),
    crowd("2026-06-30", 12, 40),
    crowd("2026-07-14", 13, 40),
    crowd("2026-07-07", 13, 40),
    crowd("2026-06-30", 13, 40),
    crowd("2026-07-14", 14, 40),
    crowd("2026-07-07", 14, 40),
  ];

  it("today busier than baseline → positive deltaPct", () => {
    const r = vsAverage(
      [crowd("2026-07-21", 12, 60), crowd("2026-07-21", 13, 60), crowd("2026-07-21", 14, 60), ...baseline],
      "2026-07-21",
      { matchWeekday: false },
      "crowdPct",
    );
    expect(r.deltaPct).toBeCloseTo(50, 5); // 60 vs 40
  });

  it("today quieter than baseline → negative deltaPct", () => {
    const r = vsAverage(
      [crowd("2026-07-21", 12, 20), crowd("2026-07-21", 13, 20), crowd("2026-07-21", 14, 20), ...baseline],
      "2026-07-21",
      { matchWeekday: false },
      "crowdPct",
    );
    expect(r.deltaPct).toBeCloseTo(-50, 5); // 20 vs 40
  });
});

describe("vsAverage — realistic ~3-week fixture", () => {
  // Synthesize 3 weeks of ~5 reads/day at hours 8,11,14,17,20 with a smooth
  // time-of-day crowd shape, then compare a today that runs 20% hotter.
  const HOURS = [8, 11, 14, 17, 20];
  const SHAPE: Record<number, number> = { 8: 10, 11: 35, 14: 55, 17: 40, 20: 15 };
  const iso = (y: number, m: number, d: number) =>
    `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

  const history: VsAverageEntry[] = [];
  // Baseline: 21 prior days ending the day before "today" (2026-07-21).
  for (let back = 1; back <= 21; back++) {
    const day = 21 - back; // 2026-07-20 down to 2026-06-30
    const [y, m, d] =
      day >= 1 ? [2026, 7, day] : [2026, 6, 30 + day]; // roll into June
    for (const h of HOURS) history.push(crowd(iso(y, m, d), h, SHAPE[h]));
  }
  // Today: same shape, +20%.
  for (const h of HOURS) history.push(crowd("2026-07-21", h, Math.round(SHAPE[h] * 1.2)));

  it("reports today ~20% busier with a full baseline", () => {
    const r = vsAverage(history, "2026-07-21", { matchWeekday: false }, "crowdPct");
    expect(r.baselineDays).toBe(21);
    expect(r.baselineSamples).toBe(21 * HOURS.length);
    // today mean / baseline mean ≈ 1.2 (rounding in Math.round nudges it slightly).
    expect(Math.round(r.deltaPct!)).toBeGreaterThanOrEqual(18);
    expect(Math.round(r.deltaPct!)).toBeLessThanOrEqual(22);
  });

  it("weekday-matched baseline is a strict subset (fewer samples, still speaks)", () => {
    const r = vsAverage(history, "2026-07-21", { matchWeekday: true }, "crowdPct");
    // Only the Tuesdays in the window feed it (2026-07-14, 07-07, 06-30).
    expect(r.baselineDays).toBe(3);
    expect(r.baselineSamples).toBe(3 * HOURS.length);
    expect(Math.round(r.deltaPct!)).toBeGreaterThanOrEqual(18);
  });
});
