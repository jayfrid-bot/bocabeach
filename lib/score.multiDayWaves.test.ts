// 2026-09-10: all seven day cards read "3 ft · really choppy" although the
// marine model had the week calming to under 2 ft. Every future hour was
// scoring TODAY's wave reading because the hourly wave forecast never reached
// the scoring buckets. Each hour now looks its wave height up by time.
import { describe, expect, it } from "vitest";
import { computeMultiDayWindows } from "@/lib/score";
import type { ConditionsSnapshot } from "@/lib/types";
import fixture from "./__fixtures__/boca-2026-09-08-darkening.json";

const NOW = Date.parse("2026-09-08T15:41:00.000Z");
const snap = () => JSON.parse(JSON.stringify(fixture.snapshot)) as ConditionsSnapshot;

/** A distinct wave height per calendar day, laid over every hourly bucket. */
function withWeekOfWaves(s: ConditionsSnapshot): { s: ConditionsSnapshot; byDay: Map<string, number> } {
  const byDay = new Map<string, number>();
  const hourlyWaves = (s.hourly.data ?? []).map((h) => {
    const day = h.time.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, 1 + byDay.size * 0.6); // 1.0, 1.6, 2.2 …
    return { time: h.time, waveHeightFt: byDay.get(day)!, wavePeriodS: 7 };
  });
  s.marine.data!.hourlyWaves = hourlyWaves;
  return { s, byDay };
}

type Win = { date: string; peakBreakdown?: { time?: string; subScores?: { key: string; display?: string }[] } };
const wavesDisplay = (w: Win) => w.peakBreakdown?.subScores?.find((x) => x.key === "waves")?.display ?? "";
/** The app prints "1 ft", "1.6 ft" — no trailing ".0". */
const ft = (n: number) => `${Number(n.toFixed(1))} ft`;

describe("sea state is forecast per day, not copied from today", () => {
  it("each day card shows the wave height forecast for its peak hour", () => {
    const { s, byDay } = withWeekOfWaves(snap());
    const windows = computeMultiDayWindows(s, NOW) as Win[];
    expect(windows.length).toBeGreaterThanOrEqual(5);
    const seen = new Set<string>();
    for (const w of windows) {
      // Heights were laid down per UTC date; the card's peak hour names its own.
      const expected = byDay.get(w.peakBreakdown!.time!.slice(0, 10))!;
      expect(wavesDisplay(w).startsWith(ft(expected))).toBe(true);
      seen.add(wavesDisplay(w));
    }
    expect(seen.size).toBeGreaterThanOrEqual(5); // a week of DIFFERENT readings
  });

  it("an hour outside the marine horizon still falls back to today's reading", () => {
    const s = snap();
    s.marine.data!.hourlyWaves = undefined;
    const windows = computeMultiDayWindows(s, NOW) as Win[];
    const today = s.marine.data!.waveHeightFt!;
    for (const w of windows) expect(wavesDisplay(w).startsWith(ft(today))).toBe(true);
  });
});
