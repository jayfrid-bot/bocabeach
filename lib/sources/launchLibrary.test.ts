import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LAUNCH_ALERT_MAX_FEED_AGE_MS,
  LAUNCH_CARD_MAX_FEED_AGE_MS,
  buildLaunchSkyEvent,
  describeBearing,
  distanceTier,
  isLaunchFeedFreshForAlerts,
  launchLibraryFeedUrl,
  lightStateForAltitude,
  resolvePadCoordinate,
  solarAltitudeDeg,
} from "@/lib/sources/launchLibrary";
import { computeSunTimes } from "@/lib/sources/sun";
import type { LaunchFeedEntry } from "@/lib/skyEventsTypes";

// Real coordinates, cross-checked live 2026-09-28 (SKY_EVENTS_PLAN.md §7,
// config/launchPads.ts's header).
const BOCA = { lat: 26.3587, lon: -80.0686 };
const CAPE_SLC40 = { lat: 28.56194122, lon: -80.57735736 }; // pad id 80
const VANDENBERG_LOCATION_ID = 11;

function entry(overrides: Partial<LaunchFeedEntry> = {}): LaunchFeedEntry {
  return {
    id: "7d1afb26-6f9c-429b-9ccf-29012fd1e519",
    name: "Falcon 9 | Example",
    net: "2026-10-08T15:00:00Z", // daytime for both Boca and the Cape (see solar-altitude fixtures below)
    netPrecision: "Minute",
    windowStart: "2026-10-08T15:00:00Z",
    windowEnd: "2026-10-08T16:00:00Z",
    status: "Go",
    padId: 80, // Space Launch Complex 40
    padLocationId: 12,
    orbitAbbrev: "LEO",
    lastUpdated: "2026-09-28T03:40:54Z",
    ...overrides,
  };
}

describe("launchLibraryFeedUrl", () => {
  it("points at launch_data.json on its OWN launch-data branch", () => {
    expect(launchLibraryFeedUrl()).toBe("https://raw.githubusercontent.com/jayfrid-bot/bocabeach/launch-data/launch_data.json");
  });
});

describe("solarAltitudeDeg — cross-checked against lib/sources/sun.ts's computeSunTimes", () => {
  it("matches computeSunTimes's own maxAltitudeDeg at solar noon", () => {
    const t = computeSunTimes(BOCA.lat, BOCA.lon, 2026, 10, 8);
    const noonAlt = solarAltitudeDeg(BOCA.lat, BOCA.lon, t.solarNoon!);
    expect(noonAlt).toBeCloseTo(t.maxAltitudeDeg, 0);
  });

  it("reads ~ -0.833° (the standard refraction-corrected horizon) at computeSunTimes's own sunrise instant", () => {
    const t = computeSunTimes(BOCA.lat, BOCA.lon, 2026, 10, 8);
    const altAtSunrise = solarAltitudeDeg(BOCA.lat, BOCA.lon, t.sunrise!);
    expect(altAtSunrise).toBeCloseTo(-0.833, 1);
  });

  it("is DST-safe by construction: a UTC instant correctly representing 6:45 AM EDT reads twilight; the same LOCAL clock time mis-mapped through EST's offset would wrongly read as day", () => {
    // 2026-10-08 is under EDT (UTC-4) in America/New_York. 6:45 AM EDT is
    // correctly 10:45 UTC. A bug that assumed EST (UTC-5) year-round would
    // instead evaluate 11:45 UTC — a full hour later, which is already
    // daylight at this date/location. Both instants are passed here as
    // explicit UTC ISO strings (this module never reads a local clock or
    // timezone, §9), so this test demonstrates the correct-vs-buggy split
    // rather than exercising any DST-handling code path directly.
    const correct = solarAltitudeDeg(BOCA.lat, BOCA.lon, new Date("2026-10-08T10:45:00Z"));
    const wouldBeABugIfUsed = solarAltitudeDeg(BOCA.lat, BOCA.lon, new Date("2026-10-08T11:45:00Z"));
    expect(lightStateForAltitude(correct)).toBe("twilight");
    expect(lightStateForAltitude(wouldBeABugIfUsed)).toBe("day");
  });
});

describe("lightStateForAltitude — day/twilight/night boundaries (§7)", () => {
  it("day: altitude >= 0°", () => {
    expect(lightStateForAltitude(0)).toBe("day");
    expect(lightStateForAltitude(45)).toBe("day");
  });
  it("twilight: -18° <= altitude < 0°", () => {
    expect(lightStateForAltitude(-0.01)).toBe("twilight");
    expect(lightStateForAltitude(-17.99)).toBe("twilight");
    expect(lightStateForAltitude(-18)).toBe("twilight");
  });
  it("night: altitude < -18°", () => {
    expect(lightStateForAltitude(-18.01)).toBe("night");
    expect(lightStateForAltitude(-60)).toBe("night");
  });
});

describe("distanceTier — §7's range-tier boundaries", () => {
  it("near: <= 50 miles", () => {
    expect(distanceTier(0)).toBe("near");
    expect(distanceTier(49.99)).toBe("near");
    expect(distanceTier(50)).toBe("near");
  });
  it("mid: 50-200 miles", () => {
    expect(distanceTier(50.01)).toBe("mid");
    expect(distanceTier(200)).toBe("mid");
  });
  it("far (omitted): > 200 miles", () => {
    expect(distanceTier(200.01)).toBeNull();
    expect(distanceTier(3000)).toBeNull();
  });
});

describe("describeBearing — plain-English where-to-look copy (§7, §12)", () => {
  it('matches the plan\'s own citation: Boca Raton -> Cape Canaveral SLC-40 reads "bearing 349° (nearly due north)"', () => {
    // Live-verified 2026-09-28: bearingDeg(Boca, SLC-40) = 348.5..348.8°,
    // which Math.round takes to 349° — matching SKY_EVENTS_PLAN.md §7's own
    // "Boca -> Cape ≈349°" citation exactly.
    expect(describeBearing(348.5)).toBe("bearing 349° (nearly due north)");
  });
  it("says \"due X\" for an exact primary bearing", () => {
    expect(describeBearing(90)).toBe("bearing 90° (due east)");
    expect(describeBearing(180)).toBe("bearing 180° (due south)");
  });
  it("names the plain compass word for a non-primary bearing", () => {
    expect(describeBearing(45)).toBe("bearing 45° (northeast)");
  });
});

describe("resolvePadCoordinate", () => {
  it("resolves a catalogued pad id to its own coordinate", () => {
    const coord = resolvePadCoordinate(80, 12); // SLC-40
    expect(coord).toEqual({ lat: 28.56194122, lon: -80.57735736 });
  });
  it("falls back to the range's centroid for an uncatalogued pad id at a known location", () => {
    const coord = resolvePadCoordinate(999999, 12); // unknown pad, but Cape Canaveral SFS location
    expect(coord).not.toBeNull();
    expect(coord!.lat).toBeCloseTo(28.49, 1);
  });
  it("returns null when the location itself isn't one of the 4 ranges", () => {
    expect(resolvePadCoordinate(999999, 6)).toBeNull(); // location 6 = Plesetsk, not a covered range
  });

  it("review item b: a catalogued pad id whose claimed padLocationId disagrees with config is dropped, never trusted", () => {
    // Pad 80 (SLC-40) is catalogued at locationId 12 (Cape Canaveral SFS) —
    // an entry claiming it's at location 6 (Plesetsk) is internally
    // inconsistent (corrupted feed, or a future LL2 reassignment) and must
    // be dropped rather than silently resolved to SLC-40's real coordinate.
    expect(resolvePadCoordinate(80, 6)).toBeNull();
  });
});

describe("buildLaunchSkyEvent — per-beach eligibility (§7)", () => {
  const FEED_GENERATED_AT = "2026-10-08T14:00:00Z";

  it("near tier (<=50mi): shown regardless of orbit/light state", () => {
    // A synthetic observer 18mi from SLC-40 (well within "near"), daytime,
    // NOT known-orbital — near tier ignores both gates.
    const nearBeach = { lat: 28.3, lon: -80.6 };
    const e = buildLaunchSkyEvent(entry({ orbitAbbrev: null }), nearBeach, FEED_GENERATED_AT);
    expect(e).not.toBeNull();
    expect(e!.rangeTier).toBe("near");
    expect(e!.knownOrbital).toBe(false);
  });

  it("mid tier (50-200mi): shown when known-orbital AND observer is below the day/twilight line at net", () => {
    const e = buildLaunchSkyEvent(entry({ net: "2026-10-08T02:00:00Z", windowStart: "2026-10-08T02:00:00Z", windowEnd: "2026-10-08T03:00:00Z" }), BOCA, FEED_GENERATED_AT);
    expect(e).not.toBeNull();
    expect(e!.rangeTier).toBe("mid");
    expect(e!.observerLightState).toBe("night");
    expect(e!.knownOrbital).toBe(true);
  });

  it("mid tier: omitted when the observer is in daylight at net, even if known-orbital", () => {
    // entry()'s default net (15:00Z) is Boca daytime (see solar-altitude fixtures).
    const e = buildLaunchSkyEvent(entry(), BOCA, FEED_GENERATED_AT);
    expect(e).toBeNull();
  });

  it("mid tier: omitted when NOT known-orbital, even at night", () => {
    const e = buildLaunchSkyEvent(
      entry({ orbitAbbrev: null, net: "2026-10-08T02:00:00Z", windowStart: "2026-10-08T02:00:00Z", windowEnd: "2026-10-08T03:00:00Z" }),
      BOCA,
      FEED_GENERATED_AT,
    );
    expect(e).toBeNull();
  });

  it("far tier (>200mi): always omitted, never becomes an event", () => {
    const e = buildLaunchSkyEvent(entry({ padLocationId: VANDENBERG_LOCATION_ID, padId: 999999 }), BOCA, FEED_GENERATED_AT);
    expect(e).toBeNull();
  });

  it("carries the feed's generatedAt and sets validThrough to the launch's own windowEnd", () => {
    const e = buildLaunchSkyEvent(entry({ net: "2026-10-08T02:00:00Z", windowStart: "2026-10-08T02:00:00Z", windowEnd: "2026-10-08T03:00:00Z" }), BOCA, FEED_GENERATED_AT);
    expect(e!.source.feedGeneratedAt).toBe(FEED_GENERATED_AT);
    expect(e!.source.validThrough).toBe("2026-10-08T03:00:00Z");
  });

  it("rating is always null at this Phase 1 layer — Phase 2B fills it in later", () => {
    const e = buildLaunchSkyEvent(entry({ net: "2026-10-08T02:00:00Z", windowStart: "2026-10-08T02:00:00Z", windowEnd: "2026-10-08T03:00:00Z" }), BOCA, FEED_GENERATED_AT);
    expect(e!.rating).toBeNull();
  });
});

describe("isLaunchFeedFreshForAlerts — §7/§10's 45-min alert gate", () => {
  it("fresh (<=45 min old) is alert-eligible", () => {
    const generatedAt = "2026-10-08T14:00:00Z";
    const now = Date.parse(generatedAt) + LAUNCH_ALERT_MAX_FEED_AGE_MS;
    expect(isLaunchFeedFreshForAlerts(generatedAt, now)).toBe(true);
  });
  it("just over 45 min old is not alert-eligible", () => {
    const generatedAt = "2026-10-08T14:00:00Z";
    const now = Date.parse(generatedAt) + LAUNCH_ALERT_MAX_FEED_AGE_MS + 1;
    expect(isLaunchFeedFreshForAlerts(generatedAt, now)).toBe(false);
  });
  it("review item d: an implausibly-future generatedAt (clock skew/corruption) is never treated as fresh", () => {
    const now = Date.parse("2026-10-08T14:00:00Z");
    const generatedAt = new Date(now + 20 * 60_000).toISOString(); // 20 min in the future
    expect(isLaunchFeedFreshForAlerts(generatedAt, now)).toBe(false);
  });
  it("a generatedAt only slightly ahead of now (ordinary clock skew, <=10 min) is still fresh", () => {
    const now = Date.parse("2026-10-08T14:00:00Z");
    const generatedAt = new Date(now + 5 * 60_000).toISOString();
    expect(isLaunchFeedFreshForAlerts(generatedAt, now)).toBe(true);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const FEED_PAYLOAD = {
  schemaVersion: 1,
  generatedAt: "2026-10-08T14:00:00Z",
  // 02:00Z is nighttime for Boca on this date (see the solar-altitude
  // fixtures above, alt ~ -40.8°) — needed so the SLC-40 mid-tier gate
  // (known-orbital AND observer below the horizon) actually passes here.
  launches: [entry({ net: "2026-10-09T02:00:00Z", windowStart: "2026-10-09T02:00:00Z", windowEnd: "2026-10-09T03:00:00Z" })],
};

describe("fetchLaunchEvents", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns events for a fresh feed", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(FEED_PAYLOAD));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchLaunchEvents } = await import("@/lib/sources/launchLibrary");
    const now = new Date(Date.parse(FEED_PAYLOAD.generatedAt) + 10 * 60_000); // 10 min after generatedAt
    const r = await fetchLaunchEvents(BOCA, now);
    expect(r.status).toBe("ok");
    expect(r.data).toHaveLength(1);
  });

  it("a feed older than 6h publishes NO launches, even though the feed itself loaded fine (§8)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(FEED_PAYLOAD));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchLaunchEvents } = await import("@/lib/sources/launchLibrary");
    const now = new Date(Date.parse(FEED_PAYLOAD.generatedAt) + LAUNCH_CARD_MAX_FEED_AGE_MS + 60_000);
    const r = await fetchLaunchEvents(BOCA, now);
    expect(r.status).toBe("best-effort");
    expect(r.data).toEqual([]);
    expect(r.note).toMatch(/stale/i);
  });

  it("an unreachable feed is honestly unavailable (data: null), not an empty list", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchLaunchEvents } = await import("@/lib/sources/launchLibrary");
    const r = await fetchLaunchEvents(BOCA, new Date());
    expect(r.status).toBe("best-effort");
    expect(r.data).toBeNull();
  });

  it("defense-in-depth: a published entry with a terminal status is dropped even though the script should never have published it", async () => {
    const badPayload = {
      schemaVersion: 1,
      generatedAt: "2026-10-08T14:00:00Z",
      launches: [{ ...FEED_PAYLOAD.launches[0], status: "Success" }],
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(badPayload));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchLaunchEvents } = await import("@/lib/sources/launchLibrary");
    const now = new Date(Date.parse(FEED_PAYLOAD.generatedAt) + 60_000);
    const r = await fetchLaunchEvents(BOCA, now);
    expect(r.status).toBe("ok");
    expect(r.data).toEqual([]);
  });

  it("defense-in-depth: rejects a payload with the wrong schemaVersion", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ ...FEED_PAYLOAD, schemaVersion: 2 }));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchLaunchEvents } = await import("@/lib/sources/launchLibrary");
    const r = await fetchLaunchEvents(BOCA, new Date());
    expect(r.data).toBeNull();
  });

  it("review item a: a published entry with a corrupted, non-allowlisted orbitAbbrev (e.g. \"Sub\") is never treated as known-orbital", async () => {
    // Near-tier (<=50mi) so the event is still CONSTRUCTED regardless of
    // orbital status — this isolates whether knownOrbital itself is
    // computed correctly from a re-validated field, not just whether a
    // mid-tier launch happens to get excluded for an unrelated reason.
    const nearBeach = { lat: 28.3, lon: -80.6 }; // ~18mi from SLC-40
    const badPayload = {
      schemaVersion: 1,
      generatedAt: "2026-10-08T14:00:00Z",
      launches: [{ ...FEED_PAYLOAD.launches[0], orbitAbbrev: "Sub" }],
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(badPayload));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchLaunchEvents } = await import("@/lib/sources/launchLibrary");
    const now = new Date(Date.parse(badPayload.generatedAt) + 60_000);
    const r = await fetchLaunchEvents(nearBeach, now);
    expect(r.status).toBe("ok");
    expect(r.data).toHaveLength(1);
    expect(r.data![0].knownOrbital).toBe(false); // "Sub" is not in the allowlist — never trusted at face value
  });

  it("review item b: an entry whose padId/padLocationId disagree with config/launchPads.ts is dropped", async () => {
    const badPayload = {
      schemaVersion: 1,
      generatedAt: "2026-10-08T14:00:00Z",
      // padId 80 is really Cape Canaveral (locationId 12) — claiming
      // location 6 (Plesetsk) is internally inconsistent.
      launches: [{ ...FEED_PAYLOAD.launches[0], padId: 80, padLocationId: 6 }],
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(badPayload));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchLaunchEvents } = await import("@/lib/sources/launchLibrary");
    const now = new Date(Date.parse(badPayload.generatedAt) + 60_000);
    const r = await fetchLaunchEvents(BOCA, now);
    // The entry-level sanitizer only checks that padId/padLocationId are
    // well-formed integers; the pad<->location CONSISTENCY check lives in
    // resolvePadCoordinate (called from buildLaunchSkyEvent) — either way,
    // the launch must never surface as a usable event.
    expect(r.data).toEqual([]);
  });

  it("review item c: a missing `launches` field is a MALFORMED feed (data: null), never a silent empty success", async () => {
    const malformed = { schemaVersion: 1, generatedAt: "2026-10-08T14:00:00Z" }; // no `launches` at all
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(malformed));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchLaunchEvents } = await import("@/lib/sources/launchLibrary");
    const r = await fetchLaunchEvents(BOCA, new Date());
    expect(r.data).toBeNull();
  });

  it("review item c: a non-array `launches` field is also malformed (data: null)", async () => {
    const malformed = { schemaVersion: 1, generatedAt: "2026-10-08T14:00:00Z", launches: "not-an-array" };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(malformed));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchLaunchEvents } = await import("@/lib/sources/launchLibrary");
    const r = await fetchLaunchEvents(BOCA, new Date());
    expect(r.data).toBeNull();
  });

  it("review item c: a genuinely empty `launches: []` remains a valid, publishable empty success", async () => {
    const empty = { schemaVersion: 1, generatedAt: "2026-10-08T14:00:00Z", launches: [] };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(empty));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchLaunchEvents } = await import("@/lib/sources/launchLibrary");
    const now = new Date(Date.parse(empty.generatedAt) + 60_000);
    const r = await fetchLaunchEvents(BOCA, now);
    expect(r.status).toBe("ok");
    expect(r.data).toEqual([]);
  });

  it("review item d: an implausibly-future feed generatedAt publishes NO launches, with a distinct note from plain staleness", async () => {
    const futurePayload = { ...FEED_PAYLOAD, generatedAt: "2026-10-08T14:30:00Z" };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(futurePayload));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchLaunchEvents } = await import("@/lib/sources/launchLibrary");
    // "now" is 20 minutes BEFORE the feed's own generatedAt — implausible
    // clock skew/corruption, not "very fresh".
    const now = new Date(Date.parse(futurePayload.generatedAt) - 20 * 60_000);
    const r = await fetchLaunchEvents(BOCA, now);
    expect(r.status).toBe("best-effort");
    expect(r.data).toEqual([]);
    expect(r.note).toMatch(/implausible/i);
    expect(r.note).not.toMatch(/stale/i);
  });
});
