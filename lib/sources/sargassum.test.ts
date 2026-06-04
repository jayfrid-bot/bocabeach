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
});
