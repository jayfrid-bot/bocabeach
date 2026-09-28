import { describe, it, expect } from "vitest";
import { buildComingUp, type BuildComingUpInput } from "@/lib/skyEvents";
import type {
  EclipseSkyEvent,
  LaunchSkyEvent,
  MeteorSkyEvent,
  MoonSkyEvent,
  SkyEventSource,
  TideSkyEvent,
  WrappedLaunchEvents,
  WrappedMeteorEvents,
  WrappedMoonEvents,
  WrappedTideEvents,
} from "@/lib/skyEventsTypes";
import type { SkyHourlyPoint } from "@/lib/skyVisibilityQuality";
import type { Wrapped } from "@/lib/types";

const TZ = "America/New_York";
const NOW_ISO = "2026-10-01T00:00:00Z";
const NOW_MS = Date.parse(NOW_ISO);
// Boca Raton-ish coordinates — used everywhere a real astronomy-engine Moon
// sweep runs (§5's moonlight penalty). Every fixture below not specifically
// about the moonlight penalty was verified live (a one-off script against
// astronomy-engine itself) to have the Moon either below the horizon or too
// dim to matter at this lat/lon during its window, so those tests' rating
// assertions aren't incidentally at the mercy of real ephemeris.
const LAT = 26.3;
const LON = -80.08;

function wrap<T>(data: T | null, overrides: Partial<Wrapped<T>> = {}): Wrapped<T> {
  return {
    source: "test",
    status: "ok",
    fetchedAt: NOW_ISO,
    attribution: "test",
    data,
    ...overrides,
  };
}

function src(validThrough: string): SkyEventSource {
  return { feedGeneratedAt: NOW_ISO, validThrough };
}

function tideEvent(overrides: Partial<TideSkyEvent> = {}): TideSkyEvent {
  return {
    eventType: "tide",
    tier: "validated",
    stationId: "8722670",
    datum: "STND",
    episode: { start: "2026-10-02T00:00:00Z", end: "2026-10-02T00:00:00Z" },
    heightFt: 34.5,
    rating: null,
    source: src("2026-10-29T00:00:00Z"),
    ...overrides,
  };
}

function eclipseEvent(overrides: Partial<EclipseSkyEvent> = {}): EclipseSkyEvent {
  return {
    eventType: "eclipse",
    kind: "total",
    peak: "2026-11-08T05:58:00Z",
    peakIsVisible: true,
    visible: { start: "2026-11-08T05:10:00Z", end: "2026-11-08T06:42:00Z" },
    rating: null,
    source: src("2026-11-09T00:00:00Z"),
    ...overrides,
  };
}

function moonEvent(overrides: Partial<MoonSkyEvent> = {}): MoonSkyEvent {
  return {
    eventType: "moon",
    fullMoonInstant: "2026-11-08T06:00:00Z",
    closeness: 0.5,
    isSupermoon: false,
    viewingWindow: { start: "2026-11-08T02:00:00Z", end: "2026-11-08T10:00:00Z" },
    moonriseLocal: "2026-11-08T00:12:00Z",
    rating: null,
    source: src("2026-11-09T00:00:00Z"),
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
    bestLocalWindow: { start: "2026-10-05T05:00:00Z", end: "2026-10-05T06:00:00Z" },
    radiantRaDeg: 46,
    radiantDecDeg: 58,
    zhr: 100,
    sourceEdition: "IMO 2026",
    rating: null,
    ...overrides,
  };
}

function launchEvent(overrides: Partial<LaunchSkyEvent> = {}): LaunchSkyEvent {
  return {
    eventType: "launch",
    ll2Id: "abc-123",
    name: "SpaceX Falcon 9",
    net: "2026-10-12T21:15:00Z",
    netPrecision: "Minute",
    windowStart: "2026-10-12T21:15:00Z",
    windowEnd: "2026-10-12T22:30:00Z",
    status: "Go",
    padId: 235,
    padLocationId: 143,
    observerLightState: "twilight",
    padLightState: "twilight",
    rangeTier: "near",
    knownOrbital: true,
    whereToLook: { bearingDeg: 349, line: "Look north (349°)." },
    rating: null,
    source: src("2026-10-12T22:00:00Z"),
    ...overrides,
  };
}

function hourlyRun(startIso: string, count: number): SkyHourlyPoint[] {
  const startMs = Date.parse(startIso);
  return Array.from({ length: count }, (_, i) => ({
    time: new Date(startMs + i * 3_600_000).toISOString(),
    cloudCoverPct: 0,
    cloudCoverLowPct: 0,
    cloudCoverMidPct: 0,
    cloudCoverHighPct: 0,
    precipProbability: 0,
    precipIn: 0,
  }));
}

const EMPTY_TIDE: WrappedTideEvents = wrap<TideSkyEvent[]>([]);
const EMPTY_MOON: WrappedMoonEvents = wrap<(EclipseSkyEvent | MoonSkyEvent)[]>([]);
const EMPTY_METEOR: WrappedMeteorEvents = wrap<MeteorSkyEvent[]>([]);
const EMPTY_LAUNCH: WrappedLaunchEvents = wrap<LaunchSkyEvent[]>([]);

function baseInput(overrides: Partial<BuildComingUpInput> = {}): BuildComingUpInput {
  return {
    tide: EMPTY_TIDE,
    moon: EMPTY_MOON,
    meteor: EMPTY_METEOR,
    launch: EMPTY_LAUNCH,
    hourly: hourlyRun("2026-10-01T00:00:00Z", 24 * 20),
    nowMs: NOW_MS,
    tz: TZ,
    lat: LAT,
    lon: LON,
    ...overrides,
  };
}

describe("buildComingUp — empty state", () => {
  it("returns a null card and empty alertCandidates when there are no genuine events", () => {
    const result = buildComingUp(baseInput());
    expect(result.card).toBeNull();
    expect(result.alertCandidates).toEqual([]);
  });

  it("returns a null card when every source is a failed/errored feed", () => {
    const input = baseInput({
      tide: wrap<TideSkyEvent[]>([tideEvent()], { status: "error" }),
      launch: wrap<LaunchSkyEvent[]>([launchEvent()], { status: "error" }),
    });
    const result = buildComingUp(input);
    expect(result.card).toBeNull();
    expect(result.alertCandidates).toEqual([]);
  });
});

describe("buildComingUp — merging (§1)", () => {
  it("merges a same-night eclipse with its full moon into one row", () => {
    const eclipse = eclipseEvent();
    const moon = moonEvent();
    const input = baseInput({
      moon: wrap<(EclipseSkyEvent | MoonSkyEvent)[]>([eclipse, moon]),
    });
    const result = buildComingUp(input);
    expect(result.card).not.toBeNull();
    expect(result.card!.rows).toHaveLength(1);
    expect(result.card!.rows[0].events).toHaveLength(2);
    expect(result.card!.rows[0].events[0].eventType).toBe("eclipse");
    expect(result.card!.rows[0].events[1].eventType).toBe("moon");
    expect(result.alertCandidates).toHaveLength(2);
  });

  it("an eclipse or moon with no same-night match still gets its own row", () => {
    const eclipse = eclipseEvent({ peak: "2026-11-08T05:58:00Z", visible: { start: "2026-11-08T05:10:00Z", end: "2026-11-08T06:42:00Z" } });
    // A full moon a week later — not the same event, must not be paired.
    const farMoon = moonEvent({
      fullMoonInstant: "2026-11-15T06:00:00Z",
      viewingWindow: { start: "2026-11-15T02:00:00Z", end: "2026-11-15T10:00:00Z" },
    });
    const input = baseInput({
      moon: wrap<(EclipseSkyEvent | MoonSkyEvent)[]>([eclipse, farMoon]),
    });
    const result = buildComingUp(input);
    expect(result.card!.rows).toHaveLength(2);
    for (const row of result.card!.rows) expect(row.events).toHaveLength(1);
  });
});

describe("buildComingUp — 3-row cap with a reserved rare row (§1) and the uncapped alertCandidates pool (Codex round-2 review HIGH #2)", () => {
  it("keeps every eclipse/launch row even when it's chronologically last, bumping routine rows instead", () => {
    const tideA = tideEvent({ stationId: "A", episode: { start: "2026-10-02T00:00:00Z", end: "2026-10-02T00:00:00Z" } });
    const tideB = tideEvent({ stationId: "B", episode: { start: "2026-10-05T00:00:00Z", end: "2026-10-05T00:00:00Z" } });
    const tideC = tideEvent({ stationId: "C", episode: { start: "2026-10-06T00:00:00Z", end: "2026-10-06T00:00:00Z" } });

    const eclipse = eclipseEvent({
      peak: "2026-10-10T05:58:00Z",
      visible: { start: "2026-10-10T05:10:00Z", end: "2026-10-10T06:42:00Z" },
    });
    const moon = moonEvent({
      fullMoonInstant: "2026-10-10T06:00:00Z",
      viewingWindow: { start: "2026-10-10T02:00:00Z", end: "2026-10-10T10:00:00Z" },
    });
    const launch = launchEvent({
      net: "2026-10-12T21:15:00Z",
      windowStart: "2026-10-12T21:15:00Z",
      windowEnd: "2026-10-12T22:30:00Z",
    });

    const input = baseInput({
      tide: wrap<TideSkyEvent[]>([tideA, tideB, tideC]),
      moon: wrap<(EclipseSkyEvent | MoonSkyEvent)[]>([eclipse, moon]),
      launch: wrap<LaunchSkyEvent[]>([launch]),
      hourly: hourlyRun("2026-10-01T00:00:00Z", 24 * 20),
    });

    const result = buildComingUp(input);
    expect(result.card!.rows).toHaveLength(3);

    const kinds = result.card!.rows.map((r) => r.events.map((e) => e.eventType).join("+"));
    expect(kinds).toContain("eclipse+moon");
    expect(kinds).toContain("launch");
    // Only the nearest routine (tide) row survives on the CARD; tideB/tideC
    // are bumped by the 3-row cap.
    const cardTideStationIds = result.card!.rows
      .flatMap((r) => r.events)
      .filter((e) => e.eventType === "tide")
      .map((e) => (e as TideSkyEvent).stationId);
    expect(cardTideStationIds).toEqual(["A"]);

    // Still chronological, nearest first.
    expect(result.card!.rows[0].sortInstant.startsWith("2026-10-02")).toBe(true);
    expect(result.card!.rows[2].sortInstant.startsWith("2026-10-12")).toBe(true);

    // HIGH #2: tideB and tideC were bumped off the visible card, but they're
    // still genuinely eligible upcoming events — alert selection must be
    // able to see them. alertCandidates is the full, uncapped pool: all 6
    // underlying events (3 tides + eclipse + moon + launch), never trimmed.
    expect(result.alertCandidates).toHaveLength(6);
    const alertTideStationIds = result.alertCandidates
      .filter((e) => e.eventType === "tide")
      .map((e) => (e as TideSkyEvent).stationId);
    expect(alertTideStationIds.sort()).toEqual(["A", "B", "C"]);
    expect(result.alertCandidates.some((e) => e.eventType === "eclipse")).toBe(true);
    expect(result.alertCandidates.some((e) => e.eventType === "launch")).toBe(true);
  });
});

describe("buildComingUp — freshness (§3, §8)", () => {
  it("drops an event whose own validThrough has already passed, even when the feed status is ok", () => {
    const expiredLaunch = launchEvent({ source: src("2026-09-30T00:00:00Z") }); // before NOW_ISO
    const input = baseInput({ launch: wrap<LaunchSkyEvent[]>([expiredLaunch]) });
    const result = buildComingUp(input);
    expect(result.card).toBeNull();
    expect(result.alertCandidates).toEqual([]);
  });

  it("drops an entire source whose feed status is error, regardless of individual validThrough", () => {
    const input = baseInput({
      tide: wrap<TideSkyEvent[]>([tideEvent()], { status: "error" }),
    });
    const result = buildComingUp(input);
    expect(result.card).toBeNull();
  });

  // Defense in depth (§7): the adapter already rejects terminal launches, but a
  // feed can outlive a status change — the merge layer must drop them too.
  it.each(["Cancelled", "Success", "Failure"] as const)(
    "drops a %s launch at the merge layer even when the feed is fresh",
    (status) => {
      const input = baseInput({ launch: wrap<LaunchSkyEvent[]>([launchEvent({ status })]) });
      const result = buildComingUp(input);
      expect(result.card).toBeNull();
      expect(result.alertCandidates).toEqual([]);
    },
  );

  it("keeps a Go launch at the merge layer (control for the terminal-status filter)", () => {
    const input = baseInput({ launch: wrap<LaunchSkyEvent[]>([launchEvent({ status: "Go" })]) });
    const result = buildComingUp(input);
    expect(result.alertCandidates.some((e) => e.eventType === "launch")).toBe(true);
  });

  it("drops a tide episode that has already fully ended", () => {
    const pastEpisode = tideEvent({ episode: { start: "2026-09-25T00:00:00Z", end: "2026-09-25T06:00:00Z" } });
    const input = baseInput({ tide: wrap<TideSkyEvent[]>([pastEpisode]) });
    const result = buildComingUp(input);
    expect(result.card).toBeNull();
  });
});

describe("buildComingUp — rating (§5)", () => {
  it("a missing forecast leaves the event's rating null — no badge is ever guessed", () => {
    const meteor = meteorEvent({
      bestLocalWindow: { start: "2026-12-25T05:00:00Z", end: "2026-12-25T09:00:00Z" }, // far outside the hourly array below
    });
    const input = baseInput({
      meteor: wrap<MeteorSkyEvent[]>([meteor]),
      hourly: hourlyRun("2026-10-01T00:00:00Z", 24 * 7), // only covers ~a week from nowMs
    });
    const result = buildComingUp(input);
    expect(result.card!.rows).toHaveLength(1);
    const [event] = result.card!.rows[0].events;
    expect(event.rating).toBeNull();
  });

  it("a clear-sky window with the Moon down (verified live) gets a real, uncapped rating", () => {
    const meteor = meteorEvent({
      bestLocalWindow: { start: "2026-10-05T05:00:00Z", end: "2026-10-05T06:00:00Z" },
    });
    const input = baseInput({
      meteor: wrap<MeteorSkyEvent[]>([meteor]),
    });
    const result = buildComingUp(input);
    const [event] = result.card!.rows[0].events;
    expect(event.rating).not.toBeNull();
    expect(event.rating!.label).toBe("Amazing");
  });

  it("tide events are never sky-rated, even with a full forecast available", () => {
    const input = baseInput({ tide: wrap<TideSkyEvent[]>([tideEvent()]) });
    const result = buildComingUp(input);
    expect(result.card!.rows[0].events[0].rating).toBeNull();
  });
});

describe("buildComingUp — real Moon altitude/illumination via astronomy-engine (§5, Codex round-2 review HIGH #6)", () => {
  // Verified live against astronomy-engine itself at (LAT, LON): the Moon
  // sits at roughly 35-47° altitude and ~86% illuminated throughout
  // BRIGHT_MOON_UP, and sits well below the horizon (altitude well under
  // -30°) throughout MOON_DOWN, a few hours later the same UTC day — same
  // lunar phase, different horizon geometry.
  const BRIGHT_MOON_UP = { start: "2026-02-05T10:30:00Z", end: "2026-02-05T11:30:00Z" };
  const MOON_DOWN = { start: "2026-02-05T18:00:00Z", end: "2026-02-05T21:00:00Z" };
  const FEB_NOW_MS = Date.parse("2026-02-01T00:00:00Z");
  const FEB_HOURLY = hourlyRun("2026-02-01T00:00:00Z", 24 * 10);

  it("a meteor shower under an ~86%-lit Moon above the horizon is capped at Fair, even under an otherwise clear sky", () => {
    const meteor = meteorEvent({ bestLocalWindow: BRIGHT_MOON_UP });
    const input = baseInput({
      meteor: wrap<MeteorSkyEvent[]>([meteor]),
      hourly: FEB_HOURLY,
      nowMs: FEB_NOW_MS,
    });
    const result = buildComingUp(input);
    const [event] = result.card!.rows[0].events;
    expect(event.rating).not.toBeNull();
    expect(event.rating!.label).toBe("Fair");
  });

  it("the identical bright lunar phase applies NO penalty once the Moon is below the horizon", () => {
    const meteor = meteorEvent({ bestLocalWindow: MOON_DOWN });
    const input = baseInput({
      meteor: wrap<MeteorSkyEvent[]>([meteor]),
      hourly: FEB_HOURLY,
      nowMs: FEB_NOW_MS,
    });
    const result = buildComingUp(input);
    const [event] = result.card!.rows[0].events;
    expect(event.rating).not.toBeNull();
    expect(event.rating!.label).toBe("Amazing");
  });

  it("applies the same real-Moon check to a launch window, not just meteors", () => {
    const launch = launchEvent({
      net: "2026-02-05T11:00:00Z",
      windowStart: BRIGHT_MOON_UP.start,
      windowEnd: BRIGHT_MOON_UP.end,
      source: src("2026-02-06T00:00:00Z"),
    });
    const input = baseInput({
      launch: wrap<LaunchSkyEvent[]>([launch]),
      hourly: FEB_HOURLY,
      nowMs: FEB_NOW_MS,
    });
    const result = buildComingUp(input);
    const [event] = result.card!.rows[0].events;
    expect(event.rating).not.toBeNull();
    expect(event.rating!.label).toBe("Fair");
  });

  it("never applies a moonlight penalty to the Moon's own full-moon/eclipse rating", () => {
    // The full-moon event's own viewingWindow deliberately overlaps
    // BRIGHT_MOON_UP — rating "the Moon washes out the Moon" would be
    // nonsensical, so this must stay uncapped (a clear-sky forecast here
    // rates Amazing, never forced down to Fair).
    const moon = moonEvent({
      fullMoonInstant: "2026-02-05T11:00:00Z",
      viewingWindow: BRIGHT_MOON_UP,
      source: src("2026-02-06T00:00:00Z"),
    });
    const input = baseInput({
      moon: wrap<(EclipseSkyEvent | MoonSkyEvent)[]>([moon]),
      hourly: FEB_HOURLY,
      nowMs: FEB_NOW_MS,
    });
    const result = buildComingUp(input);
    const [event] = result.card!.rows[0].events;
    expect(event.rating).not.toBeNull();
    expect(event.rating!.label).toBe("Amazing");
  });
});
