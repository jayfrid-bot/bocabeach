import { describe, it, expect } from "vitest";
import { summarizeSeaweed, type CamSeaweedFeed } from "@/lib/sources/sargassum";

describe("summarizeSeaweed", () => {
  it("takes the worst cam and prefers the morning (pre-tractor) reading", () => {
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
        cams: [{ name: "South", level: "none" }],
      },
    };
    const d = summarizeSeaweed(feed)!;
    expect(d.level).toBe("moderate"); // worst of the morning cams
    expect(d.isMorning).toBe(true);
    expect(d.note).toBe("bands by the jetty");
    expect(d.cams).toHaveLength(2);
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

  it("returns null when no cam has a usable reading", () => {
    expect(summarizeSeaweed({})).toBeNull();
    expect(summarizeSeaweed({ latest: { cams: [{ name: "A", level: "unknown" }] } })).toBeNull();
  });

  it("derives byHour (avg) and byDay (worst) from the rolling history", () => {
    const d = summarizeSeaweed({
      latest: { cams: [{ name: "A", level: "low" }] },
      history: [
        { t: "2026-06-01T07:00-04:00", hour: 7, seaweed: "high" },
        { t: "2026-06-01T15:00-04:00", hour: 15, seaweed: "low" },
        { t: "2026-06-02T07:00-04:00", hour: 7, seaweed: "moderate" },
        { t: "2026-06-02T15:00-04:00", hour: 15, seaweed: "none" },
        { t: "bad", seaweed: "high" }, // bad date -> dropped by byDay; no hour -> not in byHour
        { hour: 7 }, // no seaweed -> ignored entirely
      ],
    })!;
    // by-hour: avg rank per hour. 7: (3+2)/2=2.5→high; 15: (1+0)/2=0.5→low
    expect(d.byHour).toEqual([
      { hour: 7, level: "high", samples: 2 },
      { hour: 15, level: "low", samples: 2 },
    ]);
    // by-day: worst seaweed each day, sorted ascending
    expect(d.byDay).toEqual([
      { date: "2026-06-01", level: "high" },
      { date: "2026-06-02", level: "moderate" },
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
