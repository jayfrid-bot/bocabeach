import { describe, it, expect } from "vitest";
import {
  countdownLabel,
  describeRow,
  launchTimeLine,
  meteorTimingLine,
  weekdayDate,
  weekdayDateTime,
} from "./SkyEventsCard";
import { SUN_QUALITY_BANDS } from "@/lib/sunQuality";
import type {
  EclipseSkyEvent,
  LaunchSkyEvent,
  MeteorSkyEvent,
  MoonSkyEvent,
  SkyEventsCardRow,
  TideSkyEvent,
} from "@/lib/skyEventsTypes";

// No React test harness in this repo (vitest.config.ts only includes
// **/*.test.ts, and there's no @testing-library/react dependency) — same
// "test the pure exported helper" precedent SunQualityCard.test.ts already
// sets for `cardTitle`. This file tests SkyEventsCard.tsx's exported pure
// copy/formatting helpers directly, never renders JSX.

const NY = "America/New_York";
const HAWAII = "Pacific/Honolulu";

// describeRow only reads `events` — `sortInstant` is irrelevant to every
// test below, so a fixed placeholder keeps these fixtures simple.
function row(...events: SkyEventsCardRow["events"]): SkyEventsCardRow {
  return { events, sortInstant: "2026-01-01T00:00:00Z" };
}

function tideEvent(overrides: Partial<TideSkyEvent> = {}): TideSkyEvent {
  return {
    eventType: "tide",
    tier: "validated",
    stationId: "8722670",
    datum: "STND",
    episode: { start: "2026-10-15T15:42:00Z", end: "2026-10-15T15:42:00Z" },
    heightFt: 34.5,
    rating: null,
    source: { feedGeneratedAt: "2026-10-01T00:00:00Z", validThrough: "2026-10-29T00:00:00Z" },
    ...overrides,
  };
}

function eclipseEvent(overrides: Partial<EclipseSkyEvent> = {}): EclipseSkyEvent {
  return {
    eventType: "eclipse",
    kind: "total",
    peak: "2027-03-08T05:58:00Z",
    peakIsVisible: true,
    visible: { start: "2027-03-08T05:10:00Z", end: "2027-03-08T06:42:00Z" },
    rating: { label: "Good", sampledOver: { start: "2027-03-08T05:10:00Z", end: "2027-03-08T06:42:00Z" } },
    source: { feedGeneratedAt: "2026-10-01T00:00:00Z", validThrough: "2027-03-09T00:00:00Z" },
    ...overrides,
  };
}

function moonEvent(overrides: Partial<MoonSkyEvent> = {}): MoonSkyEvent {
  return {
    eventType: "moon",
    fullMoonInstant: "2026-10-03T23:12:00Z",
    closeness: 0.95,
    isSupermoon: true,
    supermoonRank: 1,
    viewingWindow: { start: "2026-10-03T20:00:00Z", end: "2026-10-04T04:00:00Z" },
    moonriseLocal: "2026-10-03T23:12:00Z",
    overWater: { bearingDeg: 88, line: "over the water" },
    rating: { label: "Great", sampledOver: { start: "2026-10-03T20:00:00Z", end: "2026-10-04T04:00:00Z" } },
    source: { feedGeneratedAt: "2026-10-01T00:00:00Z", validThrough: "2026-10-05T00:00:00Z" },
    ...overrides,
  };
}

function meteorEvent(overrides: Partial<MeteorSkyEvent> = {}): MeteorSkyEvent {
  return {
    eventType: "meteor",
    showerId: "perseids",
    showerName: "Perseids",
    peak: "2026-08-12T09:00:00Z",
    activityWindow: { start: "2026-07-17T00:00:00Z", end: "2026-08-24T00:00:00Z" },
    bestLocalWindow: { start: "2026-08-12T05:00:00Z", end: "2026-08-12T09:00:00Z" },
    radiantRaDeg: 46,
    radiantDecDeg: 58,
    zhr: 100,
    sourceEdition: "IMO 2026",
    rating: { label: "Fair", sampledOver: { start: "2026-08-12T05:00:00Z", end: "2026-08-12T09:00:00Z" } },
    ...overrides,
  };
}

function launchEvent(overrides: Partial<LaunchSkyEvent> = {}): LaunchSkyEvent {
  return {
    eventType: "launch",
    ll2Id: "abc-123",
    name: "SpaceX Falcon 9",
    net: "2026-10-08T21:15:00Z",
    netPrecision: "Minute",
    windowStart: "2026-10-08T21:15:00Z",
    windowEnd: "2026-10-08T22:30:00Z",
    status: "Go",
    padId: 235,
    padLocationId: 143,
    observerLightState: "twilight",
    padLightState: "twilight",
    rangeTier: "near",
    knownOrbital: true,
    whereToLook: { bearingDeg: 349, line: "bearing 349° (nearly due north)" },
    rating: null,
    source: { feedGeneratedAt: "2026-10-01T00:00:00Z", validThrough: "2026-10-08T22:00:00Z" },
    ...overrides,
  };
}

describe("weekdayDate / weekdayDateTime — explicit weekday/date/time, never 'tonight' (§1, §9)", () => {
  it("formats a plain instant in the beach's own timezone", () => {
    expect(weekdayDate("2026-10-15T15:42:00Z", NY)).toBe("Thu, Oct 15");
    expect(weekdayDateTime("2026-10-15T15:42:00Z", NY)).toBe("Thu, Oct 15, 11:42 AM");
  });

  it("Hawaii (no DST, UTC-10) reads a different local weekday/date than the same instant in the Eastern beach's tz", () => {
    // Sunday 05:00Z: 1:00 AM Sunday in New York (EDT, UTC-4, DST still in
    // effect in early October) vs 7:00 PM SATURDAY in Honolulu (UTC-10, no
    // DST) — the whole point of formatting at the edge with the beach's own
    // IANA tz rather than UTC or the viewer's tz.
    const instant = "2026-10-04T05:00:00Z";
    expect(weekdayDate(instant, NY)).toBe("Sun, Oct 4");
    expect(weekdayDate(instant, HAWAII)).toBe("Sat, Oct 3");
  });

  it("carries a DST spring-forward transition without crashing or losing an hour of local clock time", () => {
    // 2026-03-08: US DST begins at 2:00 AM EST -> 3:00 AM EDT. 06:00Z is
    // 1:00 AM EST; 07:30Z (90 real minutes later) is 3:30 AM EDT — the
    // local clock jumps 2h30m for a 1h30m span, the 1h DST skip.
    const before = weekdayDateTime("2026-03-08T06:00:00Z", NY);
    const after = weekdayDateTime("2026-03-08T07:30:00Z", NY);
    expect(before).toBe("Sun, Mar 8, 1:00 AM");
    expect(after).toBe("Sun, Mar 8, 3:30 AM");
  });
});

describe("describeRow — tide (never sky-rated, §5)", () => {
  it("validated flood-threshold copy, no rating slot", () => {
    const r = describeRow(row(tideEvent()), NY, Date.parse("2026-10-01T00:00:00Z"));
    expect(r.title).toBe("High-tide flooding possible");
    expect(r.timeLine).toBe("Thu, Oct 15, 11:42 AM");
    expect(r.ratable).toBe(false);
    expect(r.rating).toBeNull();
  });

  it("very-high tier uses different, non-alarming copy", () => {
    const r = describeRow(row(tideEvent({ tier: "very-high" })), NY, Date.parse("2026-10-01T00:00:00Z"));
    expect(r.title).toBe("Very high tide");
    expect(r.shortLine).toContain("top 1%");
  });

  it("an episode spanning more than one qualifying high says so plainly", () => {
    const multi = tideEvent({ episode: { start: "2026-10-15T15:42:00Z", end: "2026-10-16T04:10:00Z" } });
    const r = describeRow(row(multi), NY, Date.parse("2026-10-01T00:00:00Z"));
    expect(r.shortLine).toContain("Repeats through");
  });
});

describe("describeRow — eclipse", () => {
  it("shows the peak time when the peak itself is visible", () => {
    const r = describeRow(row(eclipseEvent()), NY, 0);
    expect(r.title).toBe("Total lunar eclipse");
    expect(r.timeLine).toContain("peak");
    expect(r.ratable).toBe(true);
    expect(r.rating).toEqual({ label: "Good" });
  });

  it("shows the visible range, no peak claim, when the peak itself isn't visible", () => {
    const e = eclipseEvent({ peakIsVisible: false, kind: "partial" });
    const r = describeRow(row(e), NY, 0);
    expect(r.title).toBe("Partial lunar eclipse");
    expect(r.timeLine).not.toContain("peak");
    expect(r.timeLine).toContain("visible here");
  });

  it("a 2-event [eclipse, moon] row gets the merged 'during the full moon' title", () => {
    const r = describeRow(row(eclipseEvent(), moonEvent()), NY, 0);
    expect(r.title).toBe("Total eclipse during the full moon");
  });
});

describe("describeRow — moon", () => {
  it("supermoon ranked #1 gets the 'closest full moon' line, leading with moonrise", () => {
    const r = describeRow(row(moonEvent()), NY, 0);
    expect(r.title).toBe("Supermoon");
    expect(r.shortLine.startsWith("Rises over the water")).toBe(true);
    expect(r.shortLine).toContain("closest full moon of the year");
  });

  it("a non-#1 supermoon skips the 'closest' claim", () => {
    const r = describeRow(row(moonEvent({ supermoonRank: undefined })), NY, 0);
    expect(r.shortLine).not.toContain("closest");
  });

  it("without a reviewed shore normal, still states the plain moonrise time (no blank line)", () => {
    const r = describeRow(row(moonEvent({ overWater: undefined, isSupermoon: false, supermoonRank: undefined })), NY, 0);
    expect(r.title).toBe("Full moon");
    expect(r.shortLine).toContain("Moonrise at");
    expect(r.shortLine).not.toContain("over the water");
  });

  it("a missing rating renders as 'no badge' (ratable but null) — never guessed", () => {
    const r = describeRow(row(moonEvent({ rating: null })), NY, 0);
    expect(r.ratable).toBe(true);
    expect(r.rating).toBeNull();
  });
});

describe("meteorTimingLine / describeRow — meteor", () => {
  it("'Best after midnight' when the best local window starts in the small hours", () => {
    // 2026-08-12T05:00:00Z = 1:00 AM EDT.
    expect(meteorTimingLine(meteorEvent(), NY)).toBe("Best after midnight.");
  });

  it("'Best after dark' when the best local window starts in the evening", () => {
    const evening = meteorEvent({ bestLocalWindow: { start: "2026-08-13T01:00:00Z", end: "2026-08-13T05:00:00Z" } }); // 9 PM EDT
    expect(meteorTimingLine(evening, NY)).toBe("Best after dark.");
  });

  it("row title is the shower's own name, rating passes through", () => {
    const r = describeRow(row(meteorEvent()), NY, 0);
    expect(r.title).toBe("Perseids");
    expect(r.rating).toEqual({ label: "Fair" });
  });
});

describe("launchTimeLine / describeRow — launch (§7)", () => {
  it("Minute precision shows the window range", () => {
    expect(launchTimeLine(launchEvent(), NY)).toContain("Window");
  });

  it("coarser-than-Minute precision shows 'time not set', never a countdown target", () => {
    const coarse = launchEvent({ netPrecision: "Month" });
    expect(launchTimeLine(coarse, NY)).toContain("time not set");
    const r = describeRow(row(coarse), NY, Date.parse("2026-09-01T00:00:00Z"));
    expect(r.countdownTargetIso).toBeUndefined();
  });

  it("a Minute-precision future launch carries a countdown target; Hold never does", () => {
    const nowMs = Date.parse("2026-10-08T20:00:00Z"); // before net
    const goRow = describeRow(row(launchEvent()), NY, nowMs);
    expect(goRow.countdownTargetIso).toBe("2026-10-08T21:15:00Z");

    const holdRow = describeRow(row(launchEvent({ status: "Hold" })), NY, nowMs);
    expect(holdRow.countdownTargetIso).toBeUndefined();
  });

  it("a launch whose net has already passed carries no countdown target", () => {
    const nowMs = Date.parse("2026-10-08T21:20:00Z"); // after net
    const r = describeRow(row(launchEvent()), NY, nowMs);
    expect(r.countdownTargetIso).toBeUndefined();
  });

  it("a twilight launch gets the plume line; the where-to-look copy is shown verbatim", () => {
    const r = describeRow(row(launchEvent()), NY, 0);
    expect(r.shortLine).toContain("bearing 349°");
    expect(r.shortLine).toContain("Twilight launch");
    expect(r.shortLine).toContain("Status: Go.");
  });
});

describe("countdownLabel", () => {
  it("formats hours + minutes remaining", () => {
    const target = "2026-10-08T21:15:00Z";
    const now = Date.parse("2026-10-08T19:00:59Z"); // ~2h14m before
    expect(countdownLabel(target, now)).toBe("Launches in 2h 14m.");
  });

  it("drops the hour when under 60 minutes remain", () => {
    const target = "2026-10-08T21:15:00Z";
    const now = Date.parse("2026-10-08T20:33:00Z");
    expect(countdownLabel(target, now)).toBe("Launches in 42m.");
  });

  it("never goes negative — a passed target reads as 'window open now'", () => {
    const target = "2026-10-08T21:15:00Z";
    const now = Date.parse("2026-10-08T21:16:00Z");
    expect(countdownLabel(target, now)).toBe("Launch window open now.");
  });
});

describe("rating word source", () => {
  it("every SkyRatingLabel this card can show has a defined color", () => {
    for (const label of ["Poor", "Fair", "Good", "Great", "Amazing"] as const) {
      expect(SUN_QUALITY_BANDS.some((b) => b.label === label)).toBe(true);
    }
  });
});
