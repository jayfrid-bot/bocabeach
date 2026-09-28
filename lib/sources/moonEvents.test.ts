import { describe, it, expect } from "vitest";
import { fetchMoonEvents, isOverWater, type MoonEventsLocation } from "@/lib/sources/moonEvents";
import { listLocations } from "@/config/locations";
import type { EclipseSkyEvent, MoonSkyEvent } from "@/lib/skyEventsTypes";

// --- Fixture beaches (real coordinates from config/locations.ts /
// config/locations.generated.json) covering Eastern, Pacific and Hawaii —
// SKY_EVENTS_PLAN.md §13's required test spread for this crew. -------------

const BOCA: MoonEventsLocation = {
  lat: 26.3587,
  lon: -80.0686,
  timezone: "America/New_York",
  coastNormalDeg: 90, // due-east Atlantic shoreline (config/locations.ts)
};
const LA_JOLLA: MoonEventsLocation = { lat: 32.861436, lon: -117.255315, timezone: "America/Los_Angeles" };
const WAIKIKI: MoonEventsLocation = { lat: 21.281457, lon: -157.838741, timezone: "Pacific/Honolulu" };
// A second Eastern beach (~1.4° south of Boca) — used for the "visible only
// before peak" eclipse case below, where Boca's own window is real but only
// ~13 minutes, under the §4 15-minute floor; Naples' slightly different
// geometry gives the same real eclipse a robust ~20-minute window instead.
const NAPLES: MoonEventsLocation = { lat: 26.14234, lon: -81.79596, timezone: "America/New_York" };

function isMoon(e: EclipseSkyEvent | MoonSkyEvent): e is MoonSkyEvent {
  return e.eventType === "moon";
}
function isEclipse(e: EclipseSkyEvent | MoonSkyEvent): e is EclipseSkyEvent {
  return e.eventType === "eclipse";
}

describe("isOverWater — circular bearing difference (SKY_EVENTS_PLAN.md §4)", () => {
  it("is true when the moonrise azimuth is within 30° of the coast normal", () => {
    expect(isOverWater(90, 90)).toBe(true);
    expect(isOverWater(65, 90)).toBe(true); // 25° away
    expect(isOverWater(120, 90)).toBe(true); // exactly 30°
  });

  it("is false past 30°", () => {
    expect(isOverWater(59, 90)).toBe(false); // 31° away
    expect(isOverWater(0, 90)).toBe(false);
  });

  it("wraps correctly across the 0/360 seam — a naive abs-difference would wrongly reject this", () => {
    // 350° vs 10° coast normal is really only 20° apart the short way around.
    expect(isOverWater(350, 10)).toBe(true);
    expect(isOverWater(10, 350)).toBe(true);
    // 340° vs 10° is 30° apart (boundary, still true).
    expect(isOverWater(340, 10)).toBe(true);
    // 330° vs 10° is 40° apart the short way — false.
    expect(isOverWater(330, 10)).toBe(false);
  });
});

describe("fetchMoonEvents — basic shape and purity", () => {
  it("is a pure function of the injected `now` — same inputs, same outputs", () => {
    const now = new Date("2025-10-01T00:00:00Z");
    const a = fetchMoonEvents(BOCA, now, 14);
    const b = fetchMoonEvents({ ...BOCA }, new Date(now.getTime()), 14);
    expect(a.data).toEqual(b.data);
  });

  it("returns status ok with an empty array, not an error, when there's genuinely nothing in the window", () => {
    // Pick a 3-day window guaranteed to miss both quarter moons (full moons
    // are ~29.5 days apart) and any nearby eclipse.
    const now = new Date("2025-10-15T00:00:00Z"); // well clear of Oct 7 / Nov 5 full moons
    const result = fetchMoonEvents(BOCA, now, 3);
    expect(result.status).toBe("ok");
    expect(result.data).toEqual([]);
  });

  it("finds the next full moon within a 14-day window and omits it once the window has passed", () => {
    const before = fetchMoonEvents(BOCA, new Date("2025-10-01T00:00:00Z"), 14);
    const moons = (before.data ?? []).filter(isMoon);
    expect(moons).toHaveLength(1);
    expect(moons[0].fullMoonInstant).toBe("2025-10-07T03:48:03.710Z");
    expect(moons[0].rating).toBeNull(); // Phase 2's job — always null from this adapter

    const after = fetchMoonEvents(BOCA, new Date("2025-10-20T00:00:00Z"), 14);
    expect((after.data ?? []).filter(isMoon)).toHaveLength(0);
  });

  it("never reads the system clock — the only time input is the injected `now`", () => {
    // No Date.now()/bare `new Date()` in the module means results 100ms
    // apart in wall-clock time are byte-identical for the same `now`.
    const now = new Date("2026-03-01T00:00:00Z");
    const first = fetchMoonEvents({ ...LA_JOLLA }, new Date(now.getTime()), 14).data;
    const second = fetchMoonEvents({ ...LA_JOLLA }, new Date(now.getTime()), 14).data;
    expect(first).toEqual(second);
  });
});

describe("Supermoon Nolle-ratio cross-check against published dates (2025-2027)", () => {
  // Distances/dates verified live (timeanddate.com-sourced coverage via
  // earthsky.org and secondary press roundups, 2026-09-28) against this
  // module's own geocentric-distance computation — every cited distance
  // below landed within ~15 km of this module's own GeoVector-based figure,
  // which cross-validates both the ephemeris and the "closest of the year"
  // ranking, not just internal self-consistency (SKY_EVENTS_PLAN.md §4).
  const CITED_SUPERMOONS = [
    { date: "2025-10-07T03:48:03.710Z", citedKm: 361457, rank1: false },
    { date: "2025-11-05T13:19:46.227Z", citedKm: 356980, rank1: true }, // "closest full supermoon of 2025"
    { date: "2025-12-04T23:14:34.291Z", citedKm: 357218, rank1: false },
    { date: "2026-01-03T10:03:26.043Z", citedKm: 362312, rank1: false },
    { date: "2026-11-24T14:54:04.191Z", citedKm: 360768, rank1: false },
    { date: "2026-12-24T01:28:45.040Z", citedKm: 356740, rank1: true }, // "closest full supermoon of 2026"
    { date: "2027-01-22T12:17:50.281Z", citedKm: 357644, rank1: true }, // "closest full supermoon of 2027"
  ];

  for (const { date, rank1 } of CITED_SUPERMOONS) {
    it(`${date} is classified as a supermoon (closeness ≥ 0.90), rank1=${rank1}`, () => {
      const now = new Date(Date.parse(date) - 5 * 86_400_000); // 5 days before, inside a 14-day window
      const result = fetchMoonEvents(WAIKIKI, now, 14); // Waikiki: Moon is always well above 5° there for these
      const moon = (result.data ?? []).filter(isMoon).find((m) => m.fullMoonInstant === date);
      expect(moon, `expected a MoonSkyEvent for ${date}`).toBeDefined();
      expect(moon!.isSupermoon).toBe(true);
      expect(moon!.closeness).toBeGreaterThanOrEqual(0.9);
      if (rank1) {
        expect(moon!.supermoonRank).toBe(1);
      } else {
        expect(moon!.supermoonRank).toBeUndefined();
      }
    });
  }

  it("a full moon near apogee (a 'micromoon') is never flagged a supermoon", () => {
    // April 13, 2025 — widely reported as 2025's micromoon, full ~22h before
    // apogee (~406,000 km); May 31, 2026's full moon sits almost exactly at
    // apogee too (406,126 km, computed) — both should read near-zero closeness.
    for (const date of ["2025-04-13T00:22:55.612Z", "2026-05-31T08:45:48.291Z"]) {
      const now = new Date(Date.parse(date) - 5 * 86_400_000);
      const result = fetchMoonEvents(WAIKIKI, now, 14);
      const moon = (result.data ?? []).filter(isMoon).find((m) => m.fullMoonInstant === date);
      expect(moon, `expected a MoonSkyEvent for ${date}`).toBeDefined();
      expect(moon!.isSupermoon).toBe(false);
      expect(moon!.closeness).toBeLessThan(0.1);
      expect(moon!.supermoonRank).toBeUndefined();
    }
  });

  it("ranks only the single closest supermoon of a year — a non-#1 supermoon never gets rank 1", () => {
    // 2025's three supermoons (Oct/Nov/Dec) — only November is closest.
    const now = new Date("2025-09-25T00:00:00Z");
    const oct = fetchMoonEvents(WAIKIKI, now, 14);
    const octMoon = (oct.data ?? []).filter(isMoon)[0];
    expect(octMoon.fullMoonInstant).toBe("2025-10-07T03:48:03.710Z");
    expect(octMoon.isSupermoon).toBe(true);
    expect(octMoon.supermoonRank).toBeUndefined();
  });
});

describe("Full-moon viewing window and 'over the water' gating (§4)", () => {
  it("computes a viewing window bounded by moonrise/dusk..moonset/dawn, Moon ≥5° throughout", () => {
    const now = new Date("2025-10-01T00:00:00Z");
    const moon = (fetchMoonEvents(BOCA, now, 14).data ?? []).filter(isMoon)[0];
    expect(moon).toBeDefined();
    const start = Date.parse(moon.viewingWindow.start);
    const end = Date.parse(moon.viewingWindow.end);
    expect(end).toBeGreaterThan(start);
    // The window should sit the same UTC evening/morning as the moonrise.
    const moonriseMs = Date.parse(moon.moonriseLocal);
    expect(start).toBeGreaterThanOrEqual(moonriseMs);
    expect(end - moonriseMs).toBeLessThan(20 * 3600_000); // well under 20h — one night, not multiple
    expect(Date.parse(moon.source.validThrough)).toBe(end);
  });

  it("sets overWater only for a curated beach whose moonrise azimuth lands seaward (≤30° of coastNormalDeg)", () => {
    // Boca (coastNormalDeg 90°, due-east shoreline): Oct 7, 2025's moonrise
    // azimuth computes to ~83° — 7° off-normal, well inside the 30° gate.
    const withWater = (fetchMoonEvents(BOCA, new Date("2025-10-01T00:00:00Z"), 14).data ?? []).filter(isMoon)[0];
    expect(withWater.overWater).toBeDefined();
    expect(withWater.overWater!.line).toBe("over the water");
    expect(withWater.overWater!.bearingDeg).toBeGreaterThan(60);
    expect(withWater.overWater!.bearingDeg).toBeLessThan(120);

    // Jan 3, 2026's moonrise azimuth computes to ~58.6° — 31.4° off-normal,
    // just outside the gate: the event still shows (§4), just without the line.
    const withoutWater = (fetchMoonEvents(BOCA, new Date("2025-12-25T00:00:00Z"), 14).data ?? []).filter(isMoon)[0];
    expect(withoutWater.fullMoonInstant).toBe("2026-01-03T10:03:26.043Z");
    expect(withoutWater.overWater).toBeUndefined();
  });

  it("still computes the viewing window for the other 36 beaches with no reviewed shore normal — never required for the event to show", () => {
    const noNormal: MoonEventsLocation = { ...LA_JOLLA };
    expect(noNormal.coastNormalDeg).toBeUndefined();
    const moon = (fetchMoonEvents(noNormal, new Date("2025-10-01T00:00:00Z"), 14).data ?? []).filter(isMoon)[0];
    expect(moon).toBeDefined();
    expect(moon.overWater).toBeUndefined();
    expect(Date.parse(moon.viewingWindow.end)).toBeGreaterThan(Date.parse(moon.viewingWindow.start));
  });
});

describe("Lunar eclipses — real 2026-2028 events (SKY_EVENTS_PLAN.md §4)", () => {
  // All peak times/semi-durations below are this module's own
  // SearchLunarEclipse output, cross-checked against NASA GSFC / almanac.com
  // published peak times for the same eclipses (within a few seconds) 2026-09-28.

  it("shows a normal case where the peak itself is visible (La Jolla, Pacific, the 2026-03-03 total eclipse)", () => {
    const now = new Date("2026-02-20T00:00:00Z");
    const ecl = (fetchMoonEvents(LA_JOLLA, now, 14).data ?? []).filter(isEclipse).find((e) => e.kind === "total");
    expect(ecl).toBeDefined();
    expect(ecl!.peak).toBe("2026-03-03T11:33:40.289Z");
    expect(ecl!.peakIsVisible).toBe(true);
    expect(Date.parse(ecl!.visible.start)).toBeLessThanOrEqual(Date.parse(ecl!.peak));
    expect(Date.parse(ecl!.visible.end)).toBeGreaterThanOrEqual(Date.parse(ecl!.peak));
  });

  it("is visible only BEFORE its own peak at an Eastern beach (Naples, the 2026-03-03 total eclipse) — the Moon sets mid-eclipse", () => {
    // At this same real eclipse, Boca Raton's own visible window is real but
    // only ~13 minutes (under §4's 15-minute floor, so it's correctly
    // omitted there — see the next test); Naples, ~1.4° further south and
    // west, clears the floor with a comfortable ~20-minute margin.
    const now = new Date("2026-02-20T00:00:00Z");
    const ecl = (fetchMoonEvents(NAPLES, now, 14).data ?? []).filter(isEclipse).find((e) => e.kind === "total");
    expect(ecl).toBeDefined();
    expect(ecl!.peak).toBe("2026-03-03T11:33:40.289Z");
    expect(ecl!.peakIsVisible).toBe(false);
    expect(Date.parse(ecl!.visible.end)).toBeLessThan(Date.parse(ecl!.peak));
    expect(Date.parse(ecl!.visible.end) - Date.parse(ecl!.visible.start)).toBeGreaterThanOrEqual(15 * 60_000);
  });

  it("omits the same eclipse at Boca Raton, where the real visible window is under the 15-minute floor", () => {
    const now = new Date("2026-02-20T00:00:00Z");
    const eclipses = (fetchMoonEvents(BOCA, now, 14).data ?? []).filter(isEclipse);
    expect(eclipses.find((e) => e.peak.startsWith("2026-03-03"))).toBeUndefined();
  });

  it("is visible only AFTER its own peak in Hawaii (Waikiki, the 2026-08-28 partial eclipse) — the Moon rises mid-eclipse", () => {
    const now = new Date("2026-08-15T00:00:00Z");
    const ecl = (fetchMoonEvents(WAIKIKI, now, 14).data ?? []).filter(isEclipse).find((e) => e.kind === "partial" && e.peak.startsWith("2026-08-28"));
    expect(ecl).toBeDefined();
    expect(ecl!.peakIsVisible).toBe(false);
    expect(Date.parse(ecl!.visible.start)).toBeGreaterThan(Date.parse(ecl!.peak));
    expect(Date.parse(ecl!.visible.end) - Date.parse(ecl!.visible.start)).toBeGreaterThanOrEqual(15 * 60_000);
  });

  it("omits an eclipse entirely when the Moon is below the horizon at every beach for its whole span (2028-07-06 partial)", () => {
    const now = new Date("2028-06-25T00:00:00Z");
    for (const loc of [BOCA, LA_JOLLA, WAIKIKI]) {
      const eclipses = (fetchMoonEvents(loc, now, 14).data ?? []).filter(isEclipse);
      expect(eclipses.find((e) => e.peak.startsWith("2028-07-06"))).toBeUndefined();
    }
  });

  it("never surfaces a penumbral eclipse, even though SearchLunarEclipse finds one in-window", () => {
    // 2027-02-20 and 2027-07-18 are both penumbral (verified live) — neither
    // should ever produce a card row, at any beach.
    const now = new Date("2027-02-10T00:00:00Z");
    for (const loc of [BOCA, LA_JOLLA, WAIKIKI]) {
      const eclipses = (fetchMoonEvents(loc, now, 14).data ?? []).filter(isEclipse);
      expect(eclipses.find((e) => e.peak.startsWith("2027-02-20"))).toBeUndefined();
    }
  });
});

describe("DST — spring-forward / fall-back correctness (Eastern beach)", () => {
  it("computes a sane, positive-duration viewing window for a full moon shortly after DST ends (Nov 2026, America/New_York)", () => {
    // 2026 DST ends Sun Nov 1; the Nov 24, 2026 full moon falls comfortably
    // in EST (UTC-5). A prior version of this module's moonrise/moonset
    // bracketing had an off-by-a-lunar-day bug that this also would have caught.
    const now = new Date("2026-11-15T00:00:00Z");
    const moon = (fetchMoonEvents(BOCA, now, 14).data ?? []).filter(isMoon)[0];
    expect(moon.fullMoonInstant).toBe("2026-11-24T14:54:04.191Z");
    const start = Date.parse(moon.viewingWindow.start);
    const end = Date.parse(moon.viewingWindow.end);
    expect(end).toBeGreaterThan(start);
    expect(end - start).toBeLessThan(15 * 3600_000);
    // Moonrise should land in the evening local hours, not shifted a day off
    // by a DST/timezone bug — 24h-format hour in America/New_York.
    const hour = Number(
      new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).format(
        new Date(moon.moonriseLocal),
      ),
    );
    expect(hour).toBeGreaterThanOrEqual(16);
  });

  it("computes a sane window across the spring-forward boundary too (early March 2026)", () => {
    // 2026 DST starts Sun Mar 8; the Mar 3, 2026 full moon falls just before
    // it, still in EST.
    const now = new Date("2026-02-20T00:00:00Z");
    const moon = (fetchMoonEvents(BOCA, now, 14).data ?? []).filter(isMoon)[0];
    expect(moon.fullMoonInstant).toBe("2026-03-03T11:38:32.022Z");
    expect(Date.parse(moon.viewingWindow.end)).toBeGreaterThan(Date.parse(moon.viewingWindow.start));
  });
});

describe("CPU benchmark — all 39 beaches × 14 days (SKY_EVENTS_PLAN.md §9 acceptance criteria)", () => {
  it("computes moon events for every configured beach within budget", () => {
    const locations = listLocations();
    expect(locations.length).toBeGreaterThanOrEqual(39); // 3 curated + 36 auto-generated, per §2

    const now = new Date("2026-03-01T00:00:00Z"); // spans the 2026-03-03 total eclipse + a full moon
    const startMs = performance.now();
    for (const loc of locations) {
      const result = fetchMoonEvents(
        { lat: loc.lat, lon: loc.lon, timezone: loc.timezone, coastNormalDeg: loc.coastNormalDeg },
        now,
        14,
      );
      expect(result.status).toBe("ok");
    }
    const elapsedMs = performance.now() - startMs;
    // eslint-disable-next-line no-console -- intentional: the plan asks this benchmark to report its number.
    console.log(`[moonEvents benchmark] ${locations.length} beaches x 14 days: ${elapsedMs.toFixed(1)} ms total, ${(elapsedMs / locations.length).toFixed(2)} ms/beach`);
    // Generous ceiling — this is a CPU-bound pure computation (no network),
    // so it should be well under a Worker request's time budget even cold.
    expect(elapsedMs).toBeLessThan(5000);
  });
});
