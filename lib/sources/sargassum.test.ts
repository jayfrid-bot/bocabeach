import { describe, it, expect } from "vitest";
import { summarizeSeaweed, type CamSeaweedFeed } from "@/lib/sources/sargassum";

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
    // by-hour: avg rank per hour. 7: (3+2)/2=2.5→high; 15: (1+0)/2=0.5→low
    expect(d.byHour).toEqual([
      { hour: 7, level: "high", samples: 2 },
      { hour: 15, level: "low", samples: 2 },
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
});
