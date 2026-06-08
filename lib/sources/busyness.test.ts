import { describe, it, expect } from "vitest";
import { summarizeBusyness, type CamFeed } from "@/lib/sources/busyness";

const feed = (cams: unknown[]): CamFeed => ({
  latest: { capturedAtLocal: "2026-06-03T16:00:00-04:00", cams: cams as never },
});

describe("summarizeBusyness", () => {
  it("reports the busiest cam as the headline", () => {
    const d = summarizeBusyness(
      feed([
        { name: "A", crowd: "quiet", people: 5 },
        { name: "B", crowd: "busy", people: 40 },
        { name: "C", crowd: "moderate", people: 15 },
      ]),
    );
    expect(d.level).toBe("busy");
    expect(d.peopleEstimate).toBe(40);
    expect(d.cams).toHaveLength(3);
    expect(d.capturedAtLocal).toBe("2026-06-03T16:00:00-04:00");
  });

  it("ignores cams without a valid crowd read, and degrades to unknown", () => {
    expect(summarizeBusyness(feed([{ name: "A" }, { name: "B", crowd: "n/a" }])).level).toBe(
      "unknown",
    );
    expect(summarizeBusyness({}).level).toBe("unknown");
  });

  it("averages the history into a typical busyness-by-hour", () => {
    const d = summarizeBusyness({
      history: [
        { hour: 9, level: "quiet", people: 5 },
        { hour: 9, level: "moderate", people: 15 },
        { hour: 12, level: "busy", people: 40 },
        { hour: 12, level: "packed", people: 60 },
      ],
    });
    const at = (h: number) => d.byHour?.find((x) => x.hour === h);
    expect(at(9)).toMatchObject({ level: "moderate", people: 10, samples: 2 });
    expect(at(12)).toMatchObject({ level: "packed", people: 50, samples: 2 });
    // chronological order
    expect(d.byHour?.map((x) => x.hour)).toEqual([9, 12]);
  });

  it("takes each day's PEAK crowd as busyness-by-day", () => {
    const d = summarizeBusyness({
      history: [
        { t: "2026-06-03T09:00-04:00", hour: 9, level: "quiet", people: 5 },
        { t: "2026-06-03T16:00-04:00", hour: 16, level: "busy", people: 40 },
        { t: "2026-06-04T12:00-04:00", hour: 12, level: "moderate", people: 12 },
        { t: "nope", hour: 1, level: "packed" }, // bad date -> dropped
      ],
    });
    expect(d.byDay).toEqual([
      { date: "2026-06-03", level: "busy", people: 40 },
      { date: "2026-06-04", level: "moderate", people: 12 },
    ]);
  });
});
