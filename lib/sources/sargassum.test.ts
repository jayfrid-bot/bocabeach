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

  it("surfaces the per-day history as byDay: de-duped by date, sorted, junk dropped", () => {
    const d = summarizeSeaweed({
      latest: { cams: [{ name: "A", level: "low" }] },
      seaweedHistory: [
        { date: "2026-06-03", level: "high", isMorning: true },
        { date: "2026-06-01", level: "none" },
        { date: "2026-06-02", level: "bogus" }, // dropped (bad level)
        { date: "2026-06-03", level: "moderate" }, // later entry wins for the dup date
        { level: "low" }, // dropped (no date)
      ],
    })!;
    expect(d.byDay).toEqual([
      { date: "2026-06-01", level: "none", isMorning: undefined },
      { date: "2026-06-03", level: "moderate", isMorning: undefined },
    ]);
  });

  it("still surfaces byDay even when there is no current cam reading", () => {
    const d = summarizeSeaweed({
      seaweedHistory: [{ date: "2026-06-01", level: "moderate" }],
    })!;
    expect(d.level).toBe("unknown");
    expect(d.cams).toHaveLength(0);
    expect(d.byDay).toHaveLength(1);
  });
});
