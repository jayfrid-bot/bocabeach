import { describe, it, expect } from "vitest";
import {
  fetchMeteorShowers,
  findBestObservingWindow,
  solarAltitudeDeg,
  radiantAltitudeDeg,
  type MeteorShowerBeachInput,
} from "@/lib/sources/meteorShowers";
import { computeSunTimes } from "@/lib/sources/sun";
import { METEOR_SHOWERS } from "@/config/meteorShowers";

// Fixture beaches spanning the app's actual timezone spread
// (config/locations.ts + config/locations.generated.json coordinates).
const BOCA: MeteorShowerBeachInput = { lat: 26.3587, lon: -80.0686, timezone: "America/New_York" };
const WAIKIKI: MeteorShowerBeachInput = { lat: 21.281457, lon: -157.838741, timezone: "Pacific/Honolulu" };
const SANTA_MONICA: MeteorShowerBeachInput = {
  lat: 34.023343,
  lon: -118.513136,
  timezone: "America/Los_Angeles",
};

const PERSEIDS_2026_PEAK_MS = Date.parse(
  METEOR_SHOWERS.find((s) => s.showerId === "perseids")!.peaks.find((p) => p.year === 2026)!.peak,
);
const QUADRANTIDS_2027_PEAK_MS = Date.parse(
  METEOR_SHOWERS.find((s) => s.showerId === "quadrantids")!.peaks.find((p) => p.year === 2027)!.peak,
);

// --- Astronomy helper correctness -------------------------------------------

describe("solarAltitudeDeg — cross-checked against lib/sources/sun.ts", () => {
  it("matches computeSunTimes' maxAltitudeDeg at solar noon", () => {
    const t = computeSunTimes(BOCA.lat, BOCA.lon, 2026, 6, 1);
    const altAtNoon = solarAltitudeDeg(BOCA.lat, BOCA.lon, t.solarNoon!.getTime());
    expect(altAtNoon).toBeCloseTo(t.maxAltitudeDeg, 0);
  });

  it("is close to 0deg (within refraction's ~0.83deg) at computeSunTimes' own sunrise/sunset", () => {
    const t = computeSunTimes(BOCA.lat, BOCA.lon, 2026, 6, 1);
    expect(solarAltitudeDeg(BOCA.lat, BOCA.lon, t.sunrise!.getTime())).toBeCloseTo(-0.83, 0.5);
    expect(solarAltitudeDeg(BOCA.lat, BOCA.lon, t.sunset!.getTime())).toBeCloseTo(-0.83, 0.5);
  });

  it("agrees with computeSunTimes at a second beach/date (Waikiki, winter)", () => {
    const t = computeSunTimes(WAIKIKI.lat, WAIKIKI.lon, 2026, 12, 21);
    const altAtNoon = solarAltitudeDeg(WAIKIKI.lat, WAIKIKI.lon, t.solarNoon!.getTime());
    expect(altAtNoon).toBeCloseTo(t.maxAltitudeDeg, 0);
  });
});

describe("radiantAltitudeDeg", () => {
  it("puts a near-celestial-pole radiant (Polaris-like, dec ~89.26deg) at ~observer latitude, any time/RA", () => {
    // cos(dec) ~ 0 makes the hour-angle term negligible, so altitude ~ lat
    // regardless of time or RA — a check that's independent of this file's
    // own GMST derivation.
    const decNearPole = 89.26;
    const anyRa = 37.95; // Polaris' approx RA, but the point is it shouldn't matter much
    for (const ms of [Date.parse("2026-01-01T00:00:00Z"), Date.parse("2026-07-15T13:00:00Z")]) {
      const alt = radiantAltitudeDeg(BOCA.lat, BOCA.lon, anyRa, decNearPole, ms);
      // At dec=89.26deg (0.74deg from the true pole) the hour-angle term isn't
      // fully zero — altitude genuinely swings a bit less than +/-1deg around
      // latitude over the day, a real, well-known property of Polaris (not a
      // bug in the formula), so the tolerance here is intentionally looser
      // than a true-pole radiant would need.
      expect(Math.abs(alt - BOCA.lat)).toBeLessThan(1);
    }
  });

  it("reaches ~90deg (zenith) at its own meridian transit for a lat=0/dec=0 radiant", () => {
    // Scan a day at lat=0 for a dec=0 radiant and confirm the observed peak
    // altitude is ~90deg — this exercises the full GMST -> hour-angle pipeline
    // without the test needing to know the GMST formula itself.
    const ra = 180;
    const dec = 0;
    let maxAlt = -90;
    const dayStart = Date.parse("2026-06-01T00:00:00Z");
    for (let m = 0; m < 24 * 60; m += 2) {
      const alt = radiantAltitudeDeg(0, 0, ra, dec, dayStart + m * 60_000);
      if (alt > maxAlt) maxAlt = alt;
    }
    expect(maxAlt).toBeGreaterThan(89.5);
  });

  it("varies over 24h (isn't accidentally time-invariant)", () => {
    const a1 = radiantAltitudeDeg(BOCA.lat, BOCA.lon, 48.0, 58, Date.parse("2026-08-13T00:00:00Z"));
    const a2 = radiantAltitudeDeg(BOCA.lat, BOCA.lon, 48.0, 58, Date.parse("2026-08-13T12:00:00Z"));
    expect(Math.abs(a1 - a2)).toBeGreaterThan(5);
  });
});

// --- findBestObservingWindow --------------------------------------------------

describe("findBestObservingWindow", () => {
  it("returns a window where BOTH conditions hold at start, mid, and end", () => {
    const win = findBestObservingWindow(BOCA.lat, BOCA.lon, 48.0, 58, PERSEIDS_2026_PEAK_MS);
    expect(win).not.toBeNull();
    const startMs = Date.parse(win!.start);
    const endMs = Date.parse(win!.end);
    expect(startMs).toBeLessThan(endMs);
    // `end` is the first NON-qualifying 5-minute sample past the interval (by
    // construction — see findBestObservingWindow), so check `start` (the
    // first qualifying sample), the midpoint, and a point safely inside the
    // interval near its end (one search step back), not the boundary itself.
    const SEARCH_STEP_MS = 5 * 60_000;
    for (const ms of [startMs, (startMs + endMs) / 2, endMs - SEARCH_STEP_MS]) {
      expect(solarAltitudeDeg(BOCA.lat, BOCA.lon, ms)).toBeLessThan(-18);
      expect(radiantAltitudeDeg(BOCA.lat, BOCA.lon, 48.0, 58, ms)).toBeGreaterThanOrEqual(20);
    }
  });

  it("returns null when the radiant never clears 20deg during any dark window near peak", () => {
    // A radiant permanently below the horizon at this latitude (far southern
    // dec, northern beach) — dark sky alone can't satisfy the radiant-altitude
    // half of the rule.
    const win = findBestObservingWindow(BOCA.lat, BOCA.lon, 0, -75, PERSEIDS_2026_PEAK_MS);
    expect(win).toBeNull();
  });

  it("returns null at high latitude near summer solstice when the sky never reaches -18deg (astronomical twilight persists all night)", () => {
    const summerSolsticeMs = Date.parse("2026-06-21T12:00:00Z");
    const win = findBestObservingWindow(65, -20, 48.0, 58, summerSolsticeMs);
    expect(win).toBeNull();
  });

  it("handles a peak instant sitting exactly on a US DST transition without special-casing (UTC-native math)", () => {
    // 2026-03-08 is US spring-forward (2am -> 3am America/New_York, i.e. the
    // UTC offset itself changes at 2026-03-08T07:00:00Z). The search window
    // straddles it; nothing here does local-clock arithmetic, so it should
    // just produce a valid interval like any other night.
    const dstPeakMs = Date.parse("2026-03-08T09:00:00Z");
    const win = findBestObservingWindow(BOCA.lat, BOCA.lon, 271.5, 34, dstPeakMs);
    expect(win).not.toBeNull();
    const startMs = Date.parse(win!.start);
    const endMs = Date.parse(win!.end);
    expect(startMs).toBeLessThan(endMs);
    expect(solarAltitudeDeg(BOCA.lat, BOCA.lon, (startMs + endMs) / 2)).toBeLessThan(-18);
    expect(radiantAltitudeDeg(BOCA.lat, BOCA.lon, 271.5, 34, (startMs + endMs) / 2)).toBeGreaterThanOrEqual(
      20,
    );
  });
});

// --- fetchMeteorShowers (the public adapter) ---------------------------------

describe("fetchMeteorShowers", () => {
  it("includes a shower whose peak is within the next 14 days, with rating left null for Phase 2", () => {
    const nowMs = PERSEIDS_2026_PEAK_MS - 8 * 24 * 60 * 60 * 1000; // 8 days before peak
    const result = fetchMeteorShowers(BOCA, nowMs);
    expect(result.status).toBe("ok");
    const perseids = result.data!.find((e) => e.showerId === "perseids");
    expect(perseids).toBeDefined();
    expect(perseids!.rating).toBeNull();
    expect(perseids!.zhr).toBe(100);
    expect(perseids!.activityWindow.start.endsWith("Z")).toBe(true);
  });

  it("excludes a shower whose peak already passed", () => {
    const nowMs = PERSEIDS_2026_PEAK_MS + 24 * 60 * 60 * 1000; // 1 day after peak
    const result = fetchMeteorShowers(BOCA, nowMs);
    expect(result.data!.some((e) => e.showerId === "perseids")).toBe(false);
  });

  it("excludes a shower whose peak is more than 14 days out", () => {
    const nowMs = PERSEIDS_2026_PEAK_MS - 20 * 24 * 60 * 60 * 1000;
    const result = fetchMeteorShowers(BOCA, nowMs);
    expect(result.data!.some((e) => e.showerId === "perseids")).toBe(false);
  });

  it("year rollover: a late-December `now` picks up next year's Quadrantids from the 2027 config entry", () => {
    const nowMs = Date.parse("2026-12-28T12:00:00Z"); // < 14 days before the 2027-01-04 peak
    const result = fetchMeteorShowers(BOCA, nowMs);
    const quad = result.data!.find((e) => e.showerId === "quadrantids");
    expect(quad).toBeDefined();
    expect(Date.parse(quad!.peak)).toBe(QUADRANTIDS_2027_PEAK_MS);
    // and its activity window correctly starts in the PRIOR (2026) December.
    expect(new Date(quad!.activityWindow.start).getUTCFullYear()).toBe(2026);
  });

  it("Hawaii / Pacific / Eastern beaches each get their own valid, differing best-local-window", () => {
    const nowMs = PERSEIDS_2026_PEAK_MS - 3 * 24 * 60 * 60 * 1000;
    const results = [BOCA, WAIKIKI, SANTA_MONICA].map((beach) => ({
      beach,
      event: fetchMeteorShowers(beach, nowMs).data!.find((e) => e.showerId === "perseids"),
    }));
    for (const { beach, event } of results) {
      expect(event, `expected a Perseids event for ${beach.timezone}`).toBeDefined();
      const startMs = Date.parse(event!.bestLocalWindow.start);
      const endMs = Date.parse(event!.bestLocalWindow.end);
      expect(startMs).toBeLessThan(endMs);
      const midMs = (startMs + endMs) / 2;
      expect(solarAltitudeDeg(beach.lat, beach.lon, midMs)).toBeLessThan(-18);
      expect(radiantAltitudeDeg(beach.lat, beach.lon, 48.0, 58, midMs)).toBeGreaterThanOrEqual(20);
    }
    // Different longitudes/latitudes must not all resolve to the identical window.
    const windows = results.map((r) => r.event!.bestLocalWindow.start);
    expect(new Set(windows).size).toBeGreaterThan(1);
  });

  it("missing-year omission: a `now` far outside the supported table yields an empty, non-error result", () => {
    const nowMs = Date.parse("2031-06-01T00:00:00Z");
    const result = fetchMeteorShowers(BOCA, nowMs);
    expect(result.status).toBe("ok");
    expect(result.data).toEqual([]);
  });

  it("every returned event has a well-formed, non-degenerate bestLocalWindow", () => {
    // Sweep a `now` across each configured peak's approach window and check
    // invariants hold for whatever gets returned.
    for (const shower of METEOR_SHOWERS) {
      for (const p of shower.peaks) {
        const nowMs = Date.parse(p.peak) - 5 * 24 * 60 * 60 * 1000;
        const result = fetchMeteorShowers(BOCA, nowMs);
        for (const e of result.data ?? []) {
          expect(Date.parse(e.bestLocalWindow.start)).toBeLessThan(Date.parse(e.bestLocalWindow.end));
        }
      }
    }
  });
});
