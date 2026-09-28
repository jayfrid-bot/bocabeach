// Alert-local fixtures only (never the shared snapshot/API/page fixtures
// Crew H owns) — SKY_EVENTS_PLAN.md §13's rule for Phase 3. Every SkyEvent
// built here is the minimum valid shape lib/skyEventsTypes.ts defines,
// constructed directly, never read off a real conditions snapshot.

import { describe, expect, it } from "vitest";
import {
  beachLocal8amWindow,
  buildComingUpSubject,
  COMING_UP_WINDOW_MS,
  readSkyAlertCandidates,
  selectComingUpEvent,
  TIDE_ALERT_MAX_FEED_AGE_MS,
} from "@/lib/alerts/comingUp";
import { localHourParts } from "@/lib/history/archive";
import type {
  EclipseSkyEvent,
  LaunchSkyEvent,
  MeteorSkyEvent,
  MoonSkyEvent,
  SkyEvent,
  TideSkyEvent,
} from "@/lib/skyEventsTypes";

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2027-03-08T08:00:00.000Z"); // a beach-local 8:00 AM run, expressed in UTC
const WINDOW_START = NOW;
const WINDOW_END = NOW + COMING_UP_WINDOW_MS;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function freshSource(over: Partial<{ feedGeneratedAt: string; validThrough: string }> = {}) {
  return { feedGeneratedAt: iso(NOW - 5 * 60_000), validThrough: iso(NOW + 30 * DAY), ...over };
}

function tide(over: Partial<TideSkyEvent> = {}): TideSkyEvent {
  return {
    eventType: "tide",
    tier: "validated",
    stationId: "8722670",
    datum: "STND",
    episode: { start: iso(WINDOW_START + 10 * HOUR), end: iso(WINDOW_START + 12 * HOUR) },
    heightFt: 33.9,
    rating: null,
    source: freshSource(),
    ...over,
  };
}

function eclipse(over: Partial<EclipseSkyEvent> = {}): EclipseSkyEvent {
  return {
    eventType: "eclipse",
    kind: "total",
    peak: iso(WINDOW_START + 6 * HOUR),
    peakIsVisible: true,
    visible: { start: iso(WINDOW_START + 5 * HOUR), end: iso(WINDOW_START + 7 * HOUR) },
    rating: { label: "Good", sampledOver: { start: iso(WINDOW_START + 5 * HOUR), end: iso(WINDOW_START + 7 * HOUR) } },
    source: freshSource(),
    ...over,
  };
}

function supermoon(over: Partial<MoonSkyEvent> = {}): MoonSkyEvent {
  return {
    eventType: "moon",
    fullMoonInstant: iso(WINDOW_START + 8 * HOUR),
    closeness: 0.95,
    isSupermoon: true,
    supermoonRank: 1,
    viewingWindow: { start: iso(WINDOW_START + 9 * HOUR), end: iso(WINDOW_START + 15 * HOUR) },
    moonriseLocal: iso(WINDOW_START + 9 * HOUR),
    overWater: { bearingDeg: 90, line: "rises over the water at 7:12 PM" },
    rating: { label: "Great", sampledOver: { start: iso(WINDOW_START + 9 * HOUR), end: iso(WINDOW_START + 15 * HOUR) } },
    source: freshSource(),
    ...over,
  };
}

function meteor(over: Partial<MeteorSkyEvent> = {}): MeteorSkyEvent {
  return {
    eventType: "meteor",
    showerId: "perseids",
    showerName: "Perseids",
    peak: iso(WINDOW_START + 4 * HOUR),
    activityWindow: { start: iso(WINDOW_START - DAY), end: iso(WINDOW_START + DAY) },
    bestLocalWindow: { start: iso(WINDOW_START + 3 * HOUR), end: iso(WINDOW_START + 8 * HOUR) },
    radiantRaDeg: 48,
    radiantDecDeg: 58,
    zhr: 100,
    sourceEdition: "IMO 2027",
    rating: { label: "Fair", sampledOver: { start: iso(WINDOW_START + 3 * HOUR), end: iso(WINDOW_START + 8 * HOUR) } },
    ...over,
  };
}

function launch(over: Partial<LaunchSkyEvent> = {}): LaunchSkyEvent {
  return {
    eventType: "launch",
    ll2Id: "uuid-1",
    name: "SpaceX Falcon 9",
    net: iso(NOW + 6 * HOUR),
    netPrecision: "Minute",
    windowStart: iso(NOW + 6 * HOUR),
    windowEnd: iso(NOW + 6 * HOUR + 30 * 60_000),
    status: "Go",
    padId: 235,
    padLocationId: 143,
    observerLightState: "twilight",
    padLightState: "night",
    rangeTier: "near",
    knownOrbital: true,
    whereToLook: { bearingDeg: 349, line: "bearing 349° (nearly due north)" },
    rating: null,
    source: freshSource({ feedGeneratedAt: iso(NOW - 5 * 60_000) }),
    ...over,
  };
}

function card(...events: SkyEvent[]): readonly SkyEvent[] {
  return events;
}

describe("selectComingUpEvent — priority (§10)", () => {
  it("picks eclipse over everything else when all five are eligible at once", () => {
    const c = card(eclipse(), tide(), meteor(), supermoon(), launch());
    expect(selectComingUpEvent(c, NOW, WINDOW_START, WINDOW_END)?.eventType).toBe("eclipse");
  });

  it("picks the validated tide crossing over meteor/supermoon/launch when there's no eclipse", () => {
    const c = card(tide(), meteor(), supermoon(), launch());
    expect(selectComingUpEvent(c, NOW, WINDOW_START, WINDOW_END)?.eventType).toBe("tide");
  });

  it("picks the meteor peak over supermoon/launch when there's no eclipse or tide", () => {
    const c = card(meteor(), supermoon(), launch());
    expect(selectComingUpEvent(c, NOW, WINDOW_START, WINDOW_END)?.eventType).toBe("meteor");
  });

  it("picks the supermoon over launch when nothing higher-priority is eligible", () => {
    const c = card(supermoon(), launch());
    expect(selectComingUpEvent(c, NOW, WINDOW_START, WINDOW_END)?.eventType).toBe("supermoon");
  });

  it("falls back to launch when it's the only eligible event", () => {
    const c = card(launch());
    expect(selectComingUpEvent(c, NOW, WINDOW_START, WINDOW_END)?.eventType).toBe("launch");
  });

  it("returns null when there are no eligible events at all", () => {
    expect(selectComingUpEvent(card(), NOW, WINDOW_START, WINDOW_END)).toBeNull();
    expect(selectComingUpEvent(null, NOW, WINDOW_START, WINDOW_END)).toBeNull();
    expect(selectComingUpEvent(undefined, NOW, WINDOW_START, WINDOW_END)).toBeNull();
  });

  it("never selects a plain (non-super) full moon — only 'moon' events with isSupermoon are alert-eligible", () => {
    const c = card(supermoon({ isSupermoon: false, supermoonRank: undefined }));
    expect(selectComingUpEvent(c, NOW, WINDOW_START, WINDOW_END)).toBeNull();
  });

  it("never selects a very-high (card-only) tide tier, only the validated flood-threshold tier", () => {
    const c = card(tide({ tier: "very-high" }));
    expect(selectComingUpEvent(c, NOW, WINDOW_START, WINDOW_END)).toBeNull();
  });
});

describe("selectComingUpEvent — windows (§10)", () => {
  it("eclipse: eligible when its visible interval overlaps the run window at all (already under way at 8:00)", () => {
    const e = eclipse({
      visible: { start: iso(WINDOW_START - HOUR), end: iso(WINDOW_START + HOUR) },
      peak: iso(WINDOW_START - 30 * 60_000),
      peakIsVisible: false,
    });
    expect(selectComingUpEvent(card(e), NOW, WINDOW_START, WINDOW_END)?.eventType).toBe("eclipse");
  });

  it("eclipse: NOT eligible when its visible interval is entirely outside the run window", () => {
    const e = eclipse({ visible: { start: iso(WINDOW_END + HOUR), end: iso(WINDOW_END + 2 * HOUR) } });
    expect(selectComingUpEvent(card(e), NOW, WINDOW_START, WINDOW_END)).toBeNull();
  });

  it("eclipse: an already-ended event (visible.end in the past) never qualifies, even if it 'overlaps' on paper", () => {
    const e = eclipse({ visible: { start: iso(NOW - 2 * HOUR), end: iso(NOW - HOUR) } });
    expect(selectComingUpEvent(card(e), NOW, WINDOW_START, WINDOW_END)).toBeNull();
  });

  it("tide: eligible right at the 6h lower bound and the 30h upper bound", () => {
    const low = tide({ episode: { start: iso(WINDOW_START + 6 * HOUR), end: iso(WINDOW_START + 7 * HOUR) } });
    expect(selectComingUpEvent(card(low), NOW, WINDOW_START, WINDOW_END)?.eventType).toBe("tide");
    const high = tide({ episode: { start: iso(WINDOW_START + 30 * HOUR), end: iso(WINDOW_START + 31 * HOUR) } });
    expect(selectComingUpEvent(card(high), NOW, WINDOW_START, WINDOW_END)?.eventType).toBe("tide");
  });

  it("tide: NOT eligible just under 6h ahead or just over 30h ahead", () => {
    const tooSoon = tide({ episode: { start: iso(WINDOW_START + 6 * HOUR - 60_000), end: iso(WINDOW_START + 7 * HOUR) } });
    expect(selectComingUpEvent(card(tooSoon), NOW, WINDOW_START, WINDOW_END)).toBeNull();
    const tooLate = tide({ episode: { start: iso(WINDOW_START + 30 * HOUR + 60_000), end: iso(WINDOW_START + 31 * HOUR) } });
    expect(selectComingUpEvent(card(tooLate), NOW, WINDOW_START, WINDOW_END)).toBeNull();
  });

  it("tide: a feed older than 14 days is never alert-eligible even though the crossing itself is well-timed", () => {
    const stale = tide({ source: freshSource({ feedGeneratedAt: iso(NOW - TIDE_ALERT_MAX_FEED_AGE_MS - HOUR) }) });
    expect(selectComingUpEvent(card(stale), NOW, WINDOW_START, WINDOW_END)).toBeNull();
  });

  it("tide: a feedGeneratedAt implausibly far in the future (>10 min skew) is never alert-eligible, not treated as extra-fresh", () => {
    const futureSkewed = tide({ source: freshSource({ feedGeneratedAt: iso(NOW + 11 * 60_000) }) });
    expect(selectComingUpEvent(card(futureSkewed), NOW, WINDOW_START, WINDOW_END)).toBeNull();
    const withinSkew = tide({ source: freshSource({ feedGeneratedAt: iso(NOW + 9 * 60_000) }) });
    expect(selectComingUpEvent(card(withinSkew), NOW, WINDOW_START, WINDOW_END)?.eventType).toBe("tide");
  });

  it("meteor: eligible only when the best local window STARTS inside the run window", () => {
    const before = meteor({ bestLocalWindow: { start: iso(WINDOW_START - HOUR), end: iso(WINDOW_START + HOUR) } });
    expect(selectComingUpEvent(card(before), NOW, WINDOW_START, WINDOW_END)).toBeNull();
    const inside = meteor({ bestLocalWindow: { start: iso(WINDOW_START + HOUR), end: iso(WINDOW_START + 2 * HOUR) } });
    expect(selectComingUpEvent(card(inside), NOW, WINDOW_START, WINDOW_END)?.eventType).toBe("meteor");
    const after = meteor({ bestLocalWindow: { start: iso(WINDOW_END + HOUR), end: iso(WINDOW_END + 2 * HOUR) } });
    expect(selectComingUpEvent(card(after), NOW, WINDOW_START, WINDOW_END)).toBeNull();
  });

  it("meteor: an already-ended best window never qualifies", () => {
    const ended = meteor({ bestLocalWindow: { start: iso(NOW - 2 * HOUR), end: iso(NOW - HOUR) } });
    expect(selectComingUpEvent(card(ended), NOW, WINDOW_START, WINDOW_END)).toBeNull();
  });

  it("supermoon: eligible only when the viewing window STARTS inside the run window", () => {
    const before = supermoon({ viewingWindow: { start: iso(WINDOW_START - HOUR), end: iso(WINDOW_START + HOUR) } });
    expect(selectComingUpEvent(card(before), NOW, WINDOW_START, WINDOW_END)).toBeNull();
    const inside = supermoon({ viewingWindow: { start: iso(WINDOW_START + HOUR), end: iso(WINDOW_START + 5 * HOUR) } });
    expect(selectComingUpEvent(card(inside), NOW, WINDOW_START, WINDOW_END)?.eventType).toBe("supermoon");
  });

  it("launch: eligible only 2-12h ahead of now, Go + Minute precision + a fresh (≤45min) feed", () => {
    expect(selectComingUpEvent(card(launch({ net: iso(NOW + HOUR) })), NOW, WINDOW_START, WINDOW_END)).toBeNull(); // too soon
    expect(selectComingUpEvent(card(launch({ net: iso(NOW + 13 * HOUR) })), NOW, WINDOW_START, WINDOW_END)).toBeNull(); // too far
    expect(selectComingUpEvent(card(launch({ status: "TBD" })), NOW, WINDOW_START, WINDOW_END)).toBeNull();
    expect(selectComingUpEvent(card(launch({ netPrecision: "Hour" })), NOW, WINDOW_START, WINDOW_END)).toBeNull();
    expect(
      selectComingUpEvent(
        card(launch({ source: freshSource({ feedGeneratedAt: iso(NOW - 46 * 60_000) }) })),
        NOW,
        WINDOW_START,
        WINDOW_END,
      ),
    ).toBeNull(); // stale feed — the tighter §8 alert gate, not the card's own looser one
    expect(selectComingUpEvent(card(launch()), NOW, WINDOW_START, WINDOW_END)?.eventType).toBe("launch");
  });
});

describe("selectComingUpEvent — determinism", () => {
  it("picks the soonest eligible candidate of a type when more than one qualifies", () => {
    const later = meteor({ showerId: "later", bestLocalWindow: { start: iso(WINDOW_START + 5 * HOUR), end: iso(WINDOW_START + 6 * HOUR) } });
    const sooner = meteor({ showerId: "sooner", bestLocalWindow: { start: iso(WINDOW_START + HOUR), end: iso(WINDOW_START + 2 * HOUR) } });
    const selection = selectComingUpEvent(card(later, sooner), NOW, WINDOW_START, WINDOW_END);
    expect(selection?.eventType).toBe("meteor");
    expect(selection?.eventType === "meteor" && selection.event.showerId).toBe("sooner");
  });
});

describe("selectComingUpEvent — dedupe keys (§10)", () => {
  it("builds each of the five exact key shapes", () => {
    expect(selectComingUpEvent(card(eclipse()), NOW, WINDOW_START, WINDOW_END)?.eventKey).toBe(
      `eclipse:${eclipse().peak}`,
    );
    expect(selectComingUpEvent(card(tide()), NOW, WINDOW_START, WINDOW_END)?.eventKey).toBe(
      `tide:8722670:${tide().episode.start}`,
    );
    expect(selectComingUpEvent(card(meteor()), NOW, WINDOW_START, WINDOW_END)?.eventKey).toBe("meteor:perseids:2027");
    expect(selectComingUpEvent(card(supermoon()), NOW, WINDOW_START, WINDOW_END)?.eventKey).toBe(
      `supermoon:${supermoon().fullMoonInstant}`,
    );
    expect(selectComingUpEvent(card(launch()), NOW, WINDOW_START, WINDOW_END)?.eventKey).toBe("launch:uuid-1");
  });
});

describe("buildComingUpSubject — copy (§12)", () => {
  const TZ = "America/New_York";

  it("eclipse, peak visible", () => {
    const selection = selectComingUpEvent(card(eclipse()), NOW, WINDOW_START, WINDOW_END);
    const subject = buildComingUpSubject(selection!, TZ);
    if (subject.eventType !== "eclipse") throw new Error("expected eclipse");
    expect(subject.kindLabel).toBe("Total");
    expect(subject.peakTimeLabel).toBeTruthy();
    expect(subject.visibleRangeLabel).toBeUndefined();
    expect(subject.whenLabel).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2}$/);
  });

  it("eclipse, peak not visible → the 'visible here from …' range form", () => {
    const e = eclipse({ peakIsVisible: false, visible: { start: iso(WINDOW_START + 5 * HOUR), end: iso(WINDOW_START + 5 * HOUR + 32 * 60_000) } });
    const selection = selectComingUpEvent(card(e), NOW, WINDOW_START, WINDOW_END);
    const subject = buildComingUpSubject(selection!, TZ);
    if (subject.eventType !== "eclipse") throw new Error("expected eclipse");
    expect(subject.peakTimeLabel).toBeUndefined();
    expect(subject.visibleRangeLabel).toMatch(/-/);
  });

  it("tide: weekday+date, comma, time", () => {
    const selection = selectComingUpEvent(card(tide()), NOW, WINDOW_START, WINDOW_END);
    const subject = buildComingUpSubject(selection!, TZ);
    if (subject.eventType !== "tide") throw new Error("expected tide");
    expect(subject.whenLabel).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} (AM|PM)$/);
  });

  it("meteor: carries the shower's display name", () => {
    const selection = selectComingUpEvent(card(meteor()), NOW, WINDOW_START, WINDOW_END);
    const subject = buildComingUpSubject(selection!, TZ);
    if (subject.eventType !== "meteor") throw new Error("expected meteor");
    expect(subject.showerName).toBe("Perseids");
  });

  it("supermoon: only rank #1 gets isClosestOfYear, and overWaterLine passes through the event's own line", () => {
    const rank1 = selectComingUpEvent(card(supermoon({ supermoonRank: 1 })), NOW, WINDOW_START, WINDOW_END);
    const subject1 = buildComingUpSubject(rank1!, TZ);
    if (subject1.eventType !== "supermoon") throw new Error("expected supermoon");
    expect(subject1.isClosestOfYear).toBe(true);
    expect(subject1.overWaterLine).toBe("rises over the water at 7:12 PM");

    const rank2 = selectComingUpEvent(card(supermoon({ supermoonRank: 2 })), NOW, WINDOW_START, WINDOW_END);
    const subject2 = buildComingUpSubject(rank2!, TZ);
    if (subject2.eventType !== "supermoon") throw new Error("expected supermoon");
    expect(subject2.isClosestOfYear).toBe(false);
  });

  it("supermoon: no overWaterLine at a non-curated beach (no overWater on the event)", () => {
    const selection = selectComingUpEvent(card(supermoon({ overWater: undefined })), NOW, WINDOW_START, WINDOW_END);
    const subject = buildComingUpSubject(selection!, TZ);
    if (subject.eventType !== "supermoon") throw new Error("expected supermoon");
    expect(subject.overWaterLine).toBeUndefined();
  });

  it("launch: time first, then weekday + date, and the mission name passes through", () => {
    const selection = selectComingUpEvent(card(launch({ name: "ULA Vulcan" })), NOW, WINDOW_START, WINDOW_END);
    const subject = buildComingUpSubject(selection!, TZ);
    if (subject.eventType !== "launch") throw new Error("expected launch");
    expect(subject.name).toBe("ULA Vulcan");
    expect(subject.whenLabel).toMatch(/^\d{1,2}:\d{2} (AM|PM) [A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2}$/);
  });
});

describe("readSkyAlertCandidates (HIGH #2)", () => {
  it("reads the real array off snapshot.skyAlertCandidates", () => {
    const events = [launch()];
    expect(readSkyAlertCandidates({ skyAlertCandidates: events })).toBe(events);
  });

  it("falls back to an empty list — never null — for null/undefined at any level", () => {
    expect(readSkyAlertCandidates({ skyAlertCandidates: null })).toEqual([]);
    expect(readSkyAlertCandidates({})).toEqual([]);
    expect(readSkyAlertCandidates(null)).toEqual([]);
    expect(readSkyAlertCandidates(undefined)).toEqual([]);
  });
});

// --- beachLocal8amWindow — DST-aware [current 8AM, next 8AM) (HIGH #5) -----
describe("beachLocal8amWindow", () => {
  const TZ = "America/New_York";

  /** The first day in `year-month` (both 1-based) where `tz`'s own UTC
   *  offset differs from the previous day's — i.e. the real DST transition
   *  date for that month/zone/year, found by scanning with the SAME
   *  DST-aware helper (`localHourParts`) this module's window math itself
   *  relies on, so this test never hardcodes a rule that could later shift. */
  function findTransitionDate(tz: string, year: number, month: number): string {
    let prevOffset: number | null = null;
    for (let day = 1; day <= 31; day++) {
      const probe = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
      if (probe.getUTCMonth() !== month - 1) break;
      const { offsetMinutes } = localHourParts(tz, probe.getTime());
      if (prevOffset !== null && offsetMinutes !== prevOffset) {
        return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      }
      prevOffset = offsetMinutes;
    }
    throw new Error(`no DST transition found in ${year}-${month} for ${tz}`);
  }

  it("is exactly 24h on an ordinary day", () => {
    const noonUtc = Date.UTC(2027, 5, 15, 12, 0, 0); // mid-June — nowhere near a transition
    const { windowStart, windowEnd } = beachLocal8amWindow(noonUtc, TZ);
    expect(windowEnd - windowStart).toBe(24 * 3600 * 1000);
  });

  /** `findTransitionDate` returns the FIRST day already on the new offset —
   *  the transition itself happens overnight (2 AM) at the start of that
   *  day, so that day's own 8 AM is already on the new offset. The short/
   *  long 23h/25h day is the span ENDING there: from the PREVIOUS day's 8
   *  AM (still the old offset) to this day's 8 AM. */
  function noonUtcTheDayBefore(date: string): number {
    const [y, m, d] = date.split("-").map(Number);
    const prev = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    prev.setUTCDate(prev.getUTCDate() - 1);
    return prev.getTime();
  }

  it("spring-forward: the gap from the day before to the transition day's 8AM is 23h, not 24h", () => {
    const date = findTransitionDate(TZ, 2027, 3); // US spring-forward is always in March
    const { windowStart, windowEnd } = beachLocal8amWindow(noonUtcTheDayBefore(date), TZ);
    expect(windowEnd - windowStart).toBe(23 * 3600 * 1000);
  });

  it("fall-back: the gap from the day before to the transition day's 8AM is 25h, not 24h", () => {
    const date = findTransitionDate(TZ, 2027, 11); // US fall-back is always in November
    const { windowStart, windowEnd } = beachLocal8amWindow(noonUtcTheDayBefore(date), TZ);
    expect(windowEnd - windowStart).toBe(25 * 3600 * 1000);
  });

  it("a run at 8:35 (not exactly 8:00:00) still pins the SAME window as a run right at 8:00", () => {
    const noonUtc = Date.UTC(2027, 5, 15, 12, 0, 0);
    const atEightSharp = beachLocal8amWindow(noonUtc, TZ);
    const at835 = beachLocal8amWindow(atEightSharp.windowStart + 35 * 60_000, TZ);
    expect(at835).toEqual(atEightSharp);
  });

  it("windowStart itself reads as exactly 8:00:00 local, and windowEnd as the next day's", () => {
    const noonUtc = Date.UTC(2027, 5, 15, 12, 0, 0);
    const { windowStart, windowEnd } = beachLocal8amWindow(noonUtc, TZ);
    const start = localHourParts(TZ, windowStart);
    const end = localHourParts(TZ, windowEnd);
    expect(start.hour).toBe(8);
    expect(end.hour).toBe(8);
    expect(end.date > start.date).toBe(true);
  });
});
