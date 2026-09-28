// 2026-09-10: all seven day cards read "3 ft · really choppy" although the
// marine model had the week calming to under 2 ft. Every future hour was
// scoring TODAY's wave reading because the hourly wave forecast never reached
// the scoring buckets. Each hour now looks its wave height up by time.
import { describe, expect, it } from "vitest";
import { computeMultiDayWindows } from "@/lib/score";
import { estimateSurfHeightFt } from "@/lib/surfHeight";
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
      // The display now shows the ESTIMATED SURF height (lib/surfHeight.ts),
      // not the raw Hs laid down above — every hour here shares the same
      // wavePeriodS (7s), so run the same conversion to get the expected value.
      const rawExpected = byDay.get(w.peakBreakdown!.time!.slice(0, 10))!;
      const expected = estimateSurfHeightFt(rawExpected, 7)!;
      expect(wavesDisplay(w).startsWith(ft(expected))).toBe(true);
      seen.add(wavesDisplay(w));
    }
    expect(seen.size).toBeGreaterThanOrEqual(5); // a week of DIFFERENT readings
  });

  it("an hour outside the marine horizon still falls back to today's reading", () => {
    const s = snap();
    s.marine.data!.hourlyWaves = undefined;
    const windows = computeMultiDayWindows(s, NOW) as Win[];
    // Today's reading is also the estimated surf height, not raw Hs.
    const today = estimateSurfHeightFt(s.marine.data!.waveHeightFt!, s.marine.data!.wavePeriodS)!;
    for (const w of windows) expect(wavesDisplay(w).startsWith(ft(today))).toBe(true);
  });

  // Codex review round-3 #1: an hour with NO total waveHeightFt but a
  // complete swell height+period pair used to be dropped from the hourly
  // wave map entirely (it required a total height to even be stored), so
  // every such hour silently fell back to TODAY's single reading instead of
  // its own forecast — exactly the 2026-09-10 bug this file guards against,
  // just for the swell-only shape.
  it("a swell-only hour (no total waveHeightFt) still gets its own per-day surf estimate, not today's reading", () => {
    const s = snap();
    const byDay = new Map<string, number>();
    s.marine.data!.hourlyWaves = (s.hourly.data ?? []).map((h) => {
      const day = h.time.slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, 1 + byDay.size * 0.6); // 1.0, 1.6, 2.2 …
      return { time: h.time, swellHeightFt: byDay.get(day)!, swellPeriodS: 15 }; // no waveHeightFt/wavePeriodS at all
    });
    const windows = computeMultiDayWindows(s, NOW) as Win[];
    expect(windows.length).toBeGreaterThanOrEqual(5);
    const seen = new Set<string>();
    for (const w of windows) {
      const rawExpected = byDay.get(w.peakBreakdown!.time!.slice(0, 10))!;
      const expected = estimateSurfHeightFt(rawExpected, 15)!;
      expect(wavesDisplay(w).startsWith(ft(expected))).toBe(true);
      seen.add(wavesDisplay(w));
    }
    // A week of DIFFERENT per-day readings — proves each day used its OWN
    // swell-only forecast rather than every day collapsing onto today's
    // single reading (the bug this test targets).
    expect(seen.size).toBeGreaterThanOrEqual(5);
  });
});
