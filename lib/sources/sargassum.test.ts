import { describe, it, expect } from "vitest";
import { summarizeSeaweed, fetchSargassum, type CamSeaweedFeed } from "@/lib/sources/sargassum";
import type { Location } from "@/lib/types";

const CAMLESS_LOCATION: Location = {
  slug: "test-beach",
  name: "Test Beach",
  region: "Test County, CA",
  tier: "auto",
  lat: 34.0,
  lon: -118.5,
  timezone: "America/Los_Angeles",
  noaaTideStationId: "9410840",
  ndbcBuoyId: "icac1",
  cams: [],
};

describe("summarizeSeaweed", () => {
  it("scores point-in-time: the latest capture wins, morning gets no extra weight", () => {
    const feed: CamSeaweedFeed = {
      morning: {
        capturedAtLocal: "2026-06-03T07:10:00-04:00",
        cams: [
          { name: "South", level: "low", note: "thin wrack line" },
          { name: "Inlet", level: "moderate", note: "bands by the jetty" },
        ],
      },
      latest: {
        capturedAtLocal: "2026-06-03T16:00:00-04:00",
        cams: [{ name: "South", level: "none", note: "clean sand" }],
      },
    };
    const d = summarizeSeaweed(feed)!;
    expect(d.level).toBe("none"); // the beach is clean NOW — that's the level
    expect(d.isMorning).toBe(false);
    expect(d.note).toBe("clean sand");
  });

  it("uses the morning group only when there is no latest capture at all", () => {
    const d = summarizeSeaweed({
      morning: {
        capturedAtLocal: "2026-06-03T07:10:00-04:00",
        cams: [{ name: "Inlet", level: "moderate" }],
      },
    })!;
    expect(d.level).toBe("moderate");
    expect(d.isMorning).toBe(true);
  });

  it("surfaces the worst cam's coverage %, tie-breaking equal levels by coverage", () => {
    const d = summarizeSeaweed({
      latest: {
        cams: [
          { name: "A", level: "high", coveragePct: 55 },
          { name: "B", level: "high", coveragePct: 80 },
          { name: "C", level: "moderate", coveragePct: 95 },
        ],
      },
    })!;
    expect(d.level).toBe("high");
    expect(d.coveragePct).toBe(80); // the worse of the two "high" cams, not the moderate's 95
  });

  it("falls back to the latest reading when there is no morning one", () => {
    const d = summarizeSeaweed({
      latest: { capturedAtLocal: "x", cams: [{ name: "A", level: "high" }] },
    })!;
    expect(d.level).toBe("high");
    expect(d.isMorning).toBe(false);
  });

  it("an earlier heavier read never outranks the latest capture", () => {
    // Point-in-time semantics: the 14:08 moderate read IS the current level,
    // even though the 10:32 read was high/65%.
    const d = summarizeSeaweed({
      latest: {
        capturedAtLocal: "2026-06-11T14:08-04:00",
        cams: [{ name: "Inlet", level: "moderate", coveragePct: 30, note: "brown seaweed line" }],
      },
      history: [
        { t: "2026-06-11T10:32-04:00", hour: 10, seaweed: "high", cov: 65 },
        { t: "2026-06-11T14:08-04:00", hour: 14, seaweed: "moderate", cov: 30 },
      ],
    })!;
    expect(d.level).toBe("moderate");
    expect(d.coveragePct).toBe(30);
  });

  it("exposes today's reads in capture order (yesterday's excluded) for per-hour scoring", () => {
    const d = summarizeSeaweed({
      latest: {
        capturedAtLocal: "2026-06-11T14:08-04:00",
        cams: [{ name: "Inlet", level: "moderate", coveragePct: 30 }],
      },
      history: [
        { t: "2026-06-10T20:10-04:00", hour: 20, seaweed: "high", cov: 70 }, // yesterday
        { t: "2026-06-11T10:32-04:00", hour: 10, seaweed: "high", cov: 65 },
        { t: "2026-06-11T14:08-04:00", hour: 14, seaweed: "moderate", cov: 30 },
      ],
    })!;
    expect(d.todayReads).toEqual([
      { hour: 10, level: "high", coveragePct: 65 },
      { hour: 14, level: "moderate", coveragePct: 30 },
    ]);
  });

  it("returns null when no cam has a usable reading", () => {
    expect(summarizeSeaweed({})).toBeNull();
    expect(summarizeSeaweed({ latest: { cams: [{ name: "A", level: "unknown" }] } })).toBeNull();
  });

  it("derives byHour (avg) and byDay (average) from the rolling history", () => {
    const d = summarizeSeaweed({
      latest: { cams: [{ name: "A", level: "low" }] },
      history: [
        { t: "2026-06-01T07:00-04:00", hour: 7, seaweed: "high" },
        { t: "2026-06-01T15:00-04:00", hour: 15, seaweed: "low" },
        { t: "2026-06-02T07:00-04:00", hour: 7, seaweed: "moderate" },
        { t: "2026-06-02T15:00-04:00", hour: 15, seaweed: "none" },
        { t: "bad", seaweed: "high" }, // bad date -> dropped by byDay; no hour -> not in byHour
        { hour: 7 }, // no seaweed/cov -> ignored entirely
      ],
    })!;
    // by-hour: continuous avg rank per hour. 7: (3+2)/2=2.5→high; 15: (1+0)/2=0.5→low
    expect(d.byHour).toEqual([
      { hour: 7, level: "high", avg: 2.5, samples: 2 },
      { hour: 15, level: "low", avg: 0.5, samples: 2 },
    ]);
    // by-day: average rank ((3+1)/2=2→moderate; (2+0)/2=1→low), worst single read.
    expect(d.byDay).toEqual([
      { date: "2026-06-01", avg: 2, samples: 2, level: "moderate", worst: "high" },
      { date: "2026-06-02", avg: 1, samples: 2, level: "low", worst: "moderate" },
    ]);
  });

  it("uses measured coverage % when present and averages it per day", () => {
    const d = summarizeSeaweed({
      latest: { cams: [{ name: "A", level: "low" }] },
      history: [
        // measured cov overrides the category; cov→rank: 40→2.33, 80→3, 0→0
        { t: "2026-06-01T08:00-04:00", hour: 8, seaweed: "moderate", cov: 40 },
        { t: "2026-06-01T12:00-04:00", hour: 12, seaweed: "high", cov: 80 },
        { t: "2026-06-01T16:00-04:00", hour: 16, seaweed: "low", cov: 0 },
      ],
    })!;
    // avg (2.333+3+0)/3 = 1.78 → "moderate"; worst single read "high"
    expect(d.byDay).toEqual([
      { date: "2026-06-01", avg: 1.78, samples: 3, level: "moderate", worst: "high" },
    ]);
    // by-hour height is the coverage-driven continuous avg (granular), not the band
    expect(d.byHour?.map((h) => h.avg)).toEqual([2.33, 3, 0]);
  });

  it("still surfaces the history charts even with no current cam reading", () => {
    const d = summarizeSeaweed({
      history: [{ t: "2026-06-01T07:00-04:00", hour: 7, seaweed: "moderate" }],
    })!;
    expect(d.level).toBe("unknown");
    expect(d.cams).toHaveLength(0);
    expect(d.byDay).toHaveLength(1);
    expect(d.byHour).toHaveLength(1);
  });

  it("caps byDay to the most recent 56 days (serving-path bound)", () => {
    // 70 distinct days of history → the chart keeps only the newest 56.
    const history = Array.from({ length: 70 }, (_, i) => {
      const date = new Date(Date.UTC(2026, 3, 1) + i * 86_400_000)
        .toISOString()
        .slice(0, 10);
      return { t: `${date}T07:00:00-04:00`, hour: 7, seaweed: "moderate" as const };
    });
    const d = summarizeSeaweed({ latest: { cams: [{ name: "A", level: "low" }] }, history })!;
    expect(d.byDay).toHaveLength(56);
    expect(d.byDay?.[0].date).toBe("2026-04-15"); // oldest 14 trimmed
    expect(d.byDay?.at(-1)?.date).toBe("2026-06-09"); // newest kept
  });
});

describe("summarizeSeaweed — vsAvg lands on the parsed data", () => {
  const e = (date: string, hour: number, cov: number) => ({
    t: `${date}T${String(hour).padStart(2, "0")}:00:00-04:00`,
    hour,
    seaweed: "moderate",
    cov,
  });
  // Today's coverage (2026-07-21) runs lighter than prior days at the same hours,
  // across every weekday (matchWeekday=false for seaweed).
  const history = [
    e("2026-07-21", 8, 20),
    e("2026-07-21", 12, 20),
    e("2026-07-21", 16, 20),
    // Ten prior days, all three hours each → 30 baseline cells / 10 days
    // (the seaweed call site requires ≥10 baseline days).
    ...[20, 19, 18, 17, 16, 15, 14, 13, 12, 11].flatMap((day) => [
      e(`2026-07-${day}`, 8, 40),
      e(`2026-07-${day}`, 12, 40),
      e(`2026-07-${day}`, 16, 40),
    ]),
  ];

  it("attaches an all-weekday, hour-matched coverage comparison when given today's date", () => {
    const d = summarizeSeaweed(
      { latest: { cams: [{ name: "A", level: "low", coveragePct: 20 }] }, history: history as never },
      "2026-07-21",
    );
    expect(d!.vsAvg?.baselineDays).toBe(10);
    expect(Math.round(d!.vsAvg!.deltaPct!)).toBe(-50); // 20 vs 40
  });

  it("omits vsAvg entirely when today's date isn't supplied", () => {
    const d = summarizeSeaweed({ latest: { cams: [{ name: "A", level: "low" }] } });
    expect(d!.vsAvg).toBeUndefined();
  });
});

describe("fetchSargassum — cam gating", () => {
  it("returns no data for a cam-less beach (seaweed is cam-derived, not global)", async () => {
    const w = await fetchSargassum(CAMLESS_LOCATION);
    expect(w.data).toBeNull();
    expect(w.status).toBe("best-effort");
    expect(w.note).toMatch(/no beach cams/i);
  });
});
