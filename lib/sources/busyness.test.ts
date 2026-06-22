import { describe, it, expect } from "vitest";
import { summarizeBusyness, fetchBusyness, type CamFeed } from "@/lib/sources/busyness";
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

  it("surfaces the busiest cam's fullness % and averages it by hour", () => {
    const d = summarizeBusyness({
      latest: {
        cams: [
          { name: "A", crowd: "quiet", people: 5, crowdPct: 20 },
          { name: "B", crowd: "busy", people: 40, crowdPct: 78 },
        ],
      },
      history: [
        { hour: 9, level: "quiet", people: 5, crowdPct: 10 },
        { hour: 9, level: "moderate", people: 15, crowdPct: 40 },
      ],
    });
    expect(d.crowdPct).toBe(78); // busiest cam
    expect(d.byHour?.find((x) => x.hour === 9)?.crowdPct).toBe(25); // (10+40)/2
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

  it("averages each day's crowd as busyness-by-day", () => {
    const d = summarizeBusyness({
      history: [
        { t: "2026-06-03T09:00-04:00", hour: 9, level: "quiet", people: 5 },
        { t: "2026-06-03T16:00-04:00", hour: 16, level: "busy", people: 40 },
        { t: "2026-06-04T12:00-04:00", hour: 12, level: "moderate", people: 12 },
        { t: "nope", hour: 1, level: "packed" }, // bad date -> dropped
      ],
    });
    // 06-03: avg rank (1+3)/2=2→moderate, avg people (5+40)/2≈23; 06-04: single moderate
    expect(d.byDay).toEqual([
      { date: "2026-06-03", avg: 2, level: "moderate", people: 23, samples: 2 },
      { date: "2026-06-04", avg: 2, level: "moderate", people: 12, samples: 1 },
    ]);
  });
});

describe("fetchBusyness — cam gating", () => {
  it("returns no data for a cam-less beach (crowd is cam-derived, not global)", async () => {
    const w = await fetchBusyness(CAMLESS_LOCATION);
    expect(w.data).toBeNull();
    expect(w.status).toBe("best-effort");
    expect(w.note).toMatch(/no beach cams/i);
  });
});
