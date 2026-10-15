import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConditionsResponse, DayWindow } from "@/lib/types";

vi.mock("@/lib/watchViewCache", () => ({ peekWatchView: vi.fn(), storeWatchView: vi.fn(async () => true) }));
vi.mock("@/lib/conditions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/conditions")>();
  return { ...actual, getConditions: vi.fn() };
});

import { getConditions } from "@/lib/conditions";
import { buildOutlook, loadBeachOutlook } from "@/lib/agent/outlook";
import { BUILT_MS, conditionsFor } from "@/lib/agent/testkit";

const mocked = vi.mocked(getConditions);
const fixture = (): ConditionsResponse => conditionsFor("boca-raton")!;

beforeEach(() => {
  mocked.mockImplementation(async (slug: string) => conditionsFor(slug));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(BUILT_MS);
});
afterEach(() => {
  mocked.mockReset();
  vi.useRealTimers();
});

describe("buildOutlook", () => {
  it("gives per day: date, weekday, peak score + rating, local window, sky and notes", () => {
    const o = buildOutlook(fixture(), 3, BUILT_MS)!;
    expect(o.days.map((d) => [d.date, d.label, d.weekday])).toEqual([
      ["2026-09-04", "Today", "Friday"],
      ["2026-09-05", "Tomorrow", "Saturday"],
      ["2026-09-06", "Sunday", "Sunday"],
    ]);
    const sat = o.days[1];
    expect(sat.peakScore).toBe(78);
    expect(sat.rating).toBe("Good");
    expect(sat.bestWindow).toMatchObject({ text: "11 AM–7 PM", score: 78, rating: "Good", good: true });
    expect(sat.sky).toBe("Overcast");
    expect(sat.notes).toEqual([]);
    expect(sat.summary).toContain("Tomorrow (Saturday)");
    expect(o.timezone).toBe("America/New_York");
    expect(o.forecastNote).toBe("Forecast, not a guarantee; check again the morning of.");
    expect(o.summary.endsWith(o.forecastNote)).toBe(true);
    expect(o.safetyNote).toBe("Lifeguard flags and posted warnings always win.");
    expect(o.attribution.credit).toContain("Is It Beach Day");
    expect(Date.parse(o.validUntil)).toBeGreaterThan(BUILT_MS);
    expect(o.note).toBeUndefined();
  });

  it("counts calendar days from today and honors 1 and 2", () => {
    expect(buildOutlook(fixture(), 1, BUILT_MS)!.days.map((d) => d.label)).toEqual(["Today"]);
    expect(buildOutlook(fixture(), 2, BUILT_MS)!.days.map((d) => d.label)).toEqual(["Today", "Tomorrow"]);
    // Never past 3, whatever is asked of the builder.
    expect(buildOutlook(fixture(), 9, BUILT_MS)!.days).toHaveLength(3);
    expect(buildOutlook(fixture(), 0, BUILT_MS)!.days).toHaveLength(1);
  });

  it("carries the safety caps of the peak hour as notes", () => {
    const res = fixture();
    res.multiDayWindows[1].peakBreakdown!.caps = ["Rain likely — score capped at 40"];
    const d = buildOutlook(res, 2, BUILT_MS)!.days[1];
    expect(d.notes).toEqual(["Rain likely — score capped at 40"]);
    expect(d.summary).toContain("Safety notes: Rain likely — score capped at 40.");
  });

  it("says plainly when a day has no good window", () => {
    const res = fixture();
    res.multiDayWindows[1].best!.score = 52;
    res.multiDayWindows[1].peakScore = 52;
    const d = buildOutlook(res, 2, BUILT_MS)!.days[1];
    expect(d.rating).toBe("Marginal");
    expect(d.bestWindow!.good).toBe(false);
    expect(d.summary).toMatch(/No good window/);
  });

  it("evening: when today's window has ended, today says no beach time is left and shows no past peak", () => {
    const res = fixture();
    res.multiDayWindows[0].peakBreakdown!.caps = ["Rip current risk: Moderate"];
    const late = Date.parse("2026-09-04T23:30:00Z");
    const o = buildOutlook(res, 3, late)!;
    const today = o.days[0];
    expect(today).toMatchObject({ label: "Today", noTimeLeft: true, peakScore: null, rating: null, bestWindow: null, sky: null, notes: [] });
    expect(today.summary).toBe("Today (Friday): no beach time left today.");
    expect(o.summary).not.toMatch(/expected peak 80/);
    // Days still count from today, and the other days are untouched.
    expect(o.days.map((d) => d.label)).toEqual(["Today", "Tomorrow", "Sunday"]);
    expect(o.days[1]).toMatchObject({ noTimeLeft: false, peakScore: 78 });
    expect(o.days[1].bestWindow).not.toBeNull();
    expect(o.note).toBeUndefined();
  });

  it("evening: when all of today's daylight is past (no window at all), same answer, never the past peak", () => {
    const res = fixture();
    res.multiDayWindows[0].best = null; // peakScore (80) and its breakdown still describe hours that are gone
    res.multiDayWindows[0].peakBreakdown!.caps = ["Rip current risk: Moderate"];
    const o = buildOutlook(res, 1, BUILT_MS)!;
    expect(o.days).toHaveLength(1);
    expect(o.days[0]).toMatchObject({ noTimeLeft: true, peakScore: null, rating: null, bestWindow: null, sky: null, notes: [] });
    expect(JSON.stringify(o)).not.toContain("Rip current risk");
    expect(o.summary).toContain("no beach time left today");
  });

  it("a day other than today is never marked as having no time left", () => {
    const res = fixture();
    res.multiDayWindows[1].best = null;
    const d = buildOutlook(res, 2, BUILT_MS)!.days[1];
    expect(d.noTimeLeft).toBe(false);
  });

  it("leaves out a day with no data and says so, instead of guessing", () => {
    const res = fixture();
    res.multiDayWindows = res.multiDayWindows.filter((w) => w.date !== "2026-09-06");
    const o = buildOutlook(res, 3, BUILT_MS)!;
    expect(o.days.map((d) => d.date)).toEqual(["2026-09-04", "2026-09-05"]);
    expect(o.note).toMatch(/Only 2 of the 3 days/);
    expect(o.summary).toContain(o.note!);
    res.multiDayWindows = [];
    const none = buildOutlook(res, 3, BUILT_MS)!;
    expect(none.days).toEqual([]);
    expect(none.note).toMatch(/No forecast days/);
    expect(none.summary).toContain("Forecast, not a guarantee");
  });

  it("handles a day with a null peak or no breakdown", () => {
    const res = fixture();
    const w = res.multiDayWindows[1] as DayWindow;
    w.peakScore = null;
    w.best = null;
    delete w.peakBreakdown;
    const d = buildOutlook(res, 2, BUILT_MS)!.days[1];
    expect(d.peakScore).toBeNull();
    expect(d.rating).toBeNull();
    expect(d.bestWindow).toBeNull();
    expect(d.sky).toBe("Mostly Sunny"); // from the emoji, in the same Title Case the sky text uses
    expect(d.notes).toEqual([]);
    expect(d.summary).toMatch(/no usable score/);
  });

  it("returns null for a beach the app does not list", () => {
    const res = fixture();
    res.snapshot.location.slug = "nowhere";
    expect(buildOutlook(res, 3, BUILT_MS)).toBeNull();
  });
});

describe("loadBeachOutlook", () => {
  it("builds the one beach asked for, once", async () => {
    const r = await loadBeachOutlook("boca-raton", 3);
    expect(r.status).toBe("ok");
    expect(mocked).toHaveBeenCalledTimes(1);
  });
  it("maps not found, a partial build and an expired reading", async () => {
    expect((await loadBeachOutlook("nope", 3)).status).toBe("not_found");
    expect((await loadBeachOutlook("Bad Slug", 3)).status).toBe("not_found");
    mocked.mockImplementation(async (slug: string) => ({ ...conditionsFor(slug)!, budgetAborted: true }) as ConditionsResponse);
    expect((await loadBeachOutlook("boca-raton", 3)).status).toBe("incomplete");
    mocked.mockImplementation(async (slug: string) => conditionsFor(slug));
    vi.setSystemTime(BUILT_MS + 16 * 60 * 1000);
    expect((await loadBeachOutlook("boca-raton", 3)).status).toBe("expired");
  });
});
