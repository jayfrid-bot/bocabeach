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

  it("caps byDay to the most recent 56 days (serving-path bound)", () => {
    // 70 distinct days of history → the chart keeps only the newest 56.
    const history = Array.from({ length: 70 }, (_, i) => {
      const date = new Date(Date.UTC(2026, 3, 1) + i * 86_400_000)
        .toISOString()
        .slice(0, 10);
      return { t: `${date}T12:00:00-04:00`, hour: 12, level: "moderate" as const };
    });
    const d = summarizeBusyness({ history });
    expect(d.byDay).toHaveLength(56);
    // The oldest 14 days are dropped; the newest survives.
    expect(d.byDay?.[0].date).toBe("2026-04-15"); // day 15 of 70 (first 14 trimmed)
    expect(d.byDay?.at(-1)?.date).toBe("2026-06-09"); // day 70
  });
});

describe("summarizeBusyness — vsAvg lands on the parsed data", () => {
  // Today (2026-07-21, Tuesday) runs busier than prior Tuesdays at the same hours.
  const c = (date: string, hour: number, crowdPct: number) => ({
    t: `${date}T${String(hour).padStart(2, "0")}:00:00-04:00`,
    hour,
    level: "moderate",
    crowdPct,
  });
  const history = [
    c("2026-07-21", 12, 60),
    c("2026-07-21", 14, 60),
    c("2026-07-21", 16, 60),
    // Five prior Tuesdays, all three hours each → 15 baseline cells / 5 days
    // (the busyness call site requires ≥5 baseline days).
    c("2026-07-14", 12, 40),
    c("2026-07-14", 14, 40),
    c("2026-07-14", 16, 40),
    c("2026-07-07", 12, 40),
    c("2026-07-07", 14, 40),
    c("2026-07-07", 16, 40),
    c("2026-06-30", 12, 40),
    c("2026-06-30", 14, 40),
    c("2026-06-30", 16, 40),
    c("2026-06-23", 12, 40),
    c("2026-06-23", 14, 40),
    c("2026-06-23", 16, 40),
    c("2026-06-16", 12, 40),
    c("2026-06-16", 14, 40),
    c("2026-06-16", 16, 40),
    // A prior Saturday at the same hours — excluded by same-weekday matching.
    c("2026-07-18", 12, 95),
    c("2026-07-18", 14, 95),
  ];

  it("attaches a same-weekday, hour-matched crowd comparison when given today's date", () => {
    const d = summarizeBusyness(
      { latest: { cams: [{ name: "A", crowd: "busy", crowdPct: 60 }] }, history: history as never },
      undefined,
      "2026-07-21",
    );
    expect(d.vsAvg?.weekday).toBe("Tuesday");
    expect(d.vsAvg?.baselineDays).toBe(5); // five prior Tuesdays
    expect(Math.round(d.vsAvg!.deltaPct!)).toBe(50); // 60 vs 40
  });

  it("still computes vsAvg from today's reads when the live read is night-gated", () => {
    const feed: CamFeed = {
      latest: { capturedAtLocal: "2026-07-21T22:00:00-04:00", cams: [] },
      history: history as never,
    };
    const now = new Date("2026-07-21T23:30:00-04:00"); // past sunset + buffer
    const d = summarizeBusyness(feed, {
      now,
      sunriseIso: "2026-07-21T06:30:00-04:00",
      sunsetIso: "2026-07-21T20:00:00-04:00",
    }, "2026-07-21");
    expect(d.level).toBe("unknown");
    expect(d.vsAvg?.deltaPct).not.toBeNull();
    expect(Math.round(d.vsAvg!.deltaPct!)).toBe(50);
  });

  it("omits vsAvg entirely when today's date isn't supplied (cam-selection-only callers)", () => {
    const d = summarizeBusyness({ latest: { cams: [{ name: "A", crowd: "busy" }] } });
    expect(d.vsAvg).toBeUndefined();
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

describe("summarizeBusyness — daylight/freshness gate", () => {
  const dayCams = [
    { name: "A", crowd: "quiet", people: 5, crowdPct: 20 },
    { name: "B", crowd: "busy", people: 40, crowdPct: 78 },
  ];
  const history = [
    { t: "2026-07-13T09:00:00-04:00", hour: 9, level: "quiet", people: 5, crowdPct: 10 },
    { t: "2026-07-13T12:00:00-04:00", hour: 12, level: "busy", people: 40, crowdPct: 78 },
  ];
  // A midsummer Boca Raton day: sunrise ~06:30, sunset ~20:00 local (both -04:00).
  const sunriseIso = "2026-07-14T06:30:00-04:00";
  const sunsetIso = "2026-07-14T20:00:00-04:00";

  it("degrades a night capture to unknown with no headline, keeping the history charts", () => {
    const feed: CamFeed = {
      latest: { capturedAtLocal: "2026-07-13T17:00:00-04:00", cams: dayCams as never },
      history: history as never,
    };
    // 11 PM local — well past sunset + buffer.
    const now = new Date("2026-07-14T23:00:00-04:00");
    const d = summarizeBusyness(feed, { now, sunriseIso, sunsetIso });

    expect(d.level).toBe("unknown");
    expect(d.peopleEstimate).toBeUndefined();
    expect(d.crowdPct).toBeUndefined();
    expect(d.cams).toBeUndefined();
    expect(d.note).toMatch(/dark/i);
    // Historical aggregates are untouched — still valid daytime data.
    expect(d.byHour?.length).toBe(2);
    expect(d.byDay?.length).toBe(1);
  });

  it("degrades a pre-dawn capture (before sunrise - buffer) to unknown", () => {
    const feed: CamFeed = {
      latest: { capturedAtLocal: "2026-07-13T17:00:00-04:00", cams: dayCams as never },
    };
    const now = new Date("2026-07-14T05:30:00-04:00"); // an hour before sunrise
    const d = summarizeBusyness(feed, { now, sunriseIso, sunsetIso });
    expect(d.level).toBe("unknown");
    expect(d.note).toMatch(/dark/i);
  });

  it("leaves a fresh daytime capture unchanged", () => {
    const feed: CamFeed = {
      latest: { capturedAtLocal: "2026-07-14T12:30:00-04:00", cams: dayCams as never },
      history: history as never,
    };
    const now = new Date("2026-07-14T13:00:00-04:00"); // 30 min after capture, midday
    const d = summarizeBusyness(feed, { now, sunriseIso, sunsetIso });
    expect(d.level).toBe("busy");
    expect(d.peopleEstimate).toBe(40);
    expect(d.crowdPct).toBe(78);
    expect(d.cams).toHaveLength(2);
    expect(d.note).toBeUndefined();
  });

  it("still works with no gate options passed at all (existing callers/tests)", () => {
    const d = summarizeBusyness({
      latest: { capturedAtLocal: "2026-07-14T12:30:00-04:00", cams: dayCams as never },
    });
    expect(d.level).toBe("busy");
  });

  it("degrades a stale daytime capture (>3h old) to unknown even mid-afternoon", () => {
    const feed: CamFeed = {
      latest: { capturedAtLocal: "2026-07-14T09:00:00-04:00", cams: dayCams as never },
    };
    const now = new Date("2026-07-14T13:00:00-04:00"); // 4h after capture, still daylight
    const d = summarizeBusyness(feed, { now, sunriseIso, sunsetIso });
    expect(d.level).toBe("unknown");
    expect(d.note).toMatch(/stale|old/i);
  });

  it("does not flag a capture just under the staleness threshold", () => {
    const feed: CamFeed = {
      latest: { capturedAtLocal: "2026-07-14T10:30:00-04:00", cams: dayCams as never },
    };
    const now = new Date("2026-07-14T13:00:00-04:00"); // 2.5h after capture
    const d = summarizeBusyness(feed, { now, sunriseIso, sunsetIso });
    expect(d.level).toBe("busy");
  });
});
