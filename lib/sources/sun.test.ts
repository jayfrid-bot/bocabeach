import { describe, it, expect } from "vitest";
import { computeSunTimes, fetchSun } from "@/lib/sources/sun";
import type { Location } from "@/lib/types";

// Boca Raton coordinates (matches config/locations.ts).
const LAT = 26.3587;
const LON = -80.0686;
const TZ = "America/New_York";

/** Minutes-past-local-midnight of a Date, as observed in `tz`. */
function localMinutes(date: Date, tz = TZ): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return get("hour") * 60 + get("minute");
}

describe("computeSunTimes", () => {
  it("matches the Boca Raton almanac on a summer day (EDT)", () => {
    // 2026-06-01: sunrise ~6:30 AM, sunset ~8:10 PM EDT; civil dawn ~6:04 AM.
    const { daybreak, sunrise, sunset } = computeSunTimes(LAT, LON, 2026, 6, 1);
    expect(localMinutes(sunrise!)).toBeGreaterThanOrEqual(6 * 60 + 25);
    expect(localMinutes(sunrise!)).toBeLessThanOrEqual(6 * 60 + 35);
    expect(localMinutes(sunset!)).toBeGreaterThanOrEqual(20 * 60 + 5);
    expect(localMinutes(sunset!)).toBeLessThanOrEqual(20 * 60 + 15);
    // Daybreak (civil dawn) leads sunrise by ~20-30 min.
    expect(localMinutes(daybreak!)).toBeGreaterThanOrEqual(5 * 60 + 58);
    expect(localMinutes(daybreak!)).toBeLessThanOrEqual(6 * 60 + 8);
  });

  it("matches the Boca Raton almanac on a winter day (EST)", () => {
    // 2026-12-21: sunrise ~7:04 AM, sunset ~5:32 PM EST.
    const { sunrise, sunset } = computeSunTimes(LAT, LON, 2026, 12, 21);
    expect(localMinutes(sunrise!)).toBeGreaterThanOrEqual(7 * 60 + 0);
    expect(localMinutes(sunrise!)).toBeLessThanOrEqual(7 * 60 + 10);
    expect(localMinutes(sunset!)).toBeGreaterThanOrEqual(17 * 60 + 27);
    expect(localMinutes(sunset!)).toBeLessThanOrEqual(17 * 60 + 40);
  });

  it("orders daybreak < sunrise < solar noon < sunset < dusk", () => {
    const { daybreak, sunrise, solarNoon, sunset, dusk } = computeSunTimes(
      LAT,
      LON,
      2026,
      6,
      1,
    );
    const ts = [daybreak, sunrise, solarNoon, sunset, dusk].map((x) =>
      x!.getTime(),
    );
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    // Dusk trails sunset by ~20-30 min (mirror of daybreak before sunrise).
    expect((dusk!.getTime() - sunset!.getTime()) / 60000).toBeGreaterThan(15);
    expect((dusk!.getTime() - sunset!.getTime()) / 60000).toBeLessThan(40);
  });

  it("projects solar noon and a high peak altitude in summer", () => {
    const { solarNoon, maxAltitudeDeg } = computeSunTimes(LAT, LON, 2026, 6, 1);
    // Solar noon for Boca (~80°W, EDT) lands near 1:20 PM.
    expect(localMinutes(solarNoon!)).toBeGreaterThanOrEqual(13 * 60 + 10);
    expect(localMinutes(solarNoon!)).toBeLessThanOrEqual(13 * 60 + 30);
    // Near-overhead sun in June at this latitude.
    expect(maxAltitudeDeg).toBeGreaterThanOrEqual(83);
    expect(maxAltitudeDeg).toBeLessThanOrEqual(88);
  });

  it("has a much lower peak altitude in winter than summer", () => {
    const summer = computeSunTimes(LAT, LON, 2026, 6, 1).maxAltitudeDeg;
    const winter = computeSunTimes(LAT, LON, 2026, 12, 21).maxAltitudeDeg;
    expect(winter).toBeLessThan(summer);
    expect(winter).toBeGreaterThanOrEqual(38); // ~40° at Boca's latitude
    expect(winter).toBeLessThanOrEqual(43);
  });

  it("returns null for events that don't occur (polar night)", () => {
    // Above the Arctic Circle near the winter solstice: no sunrise.
    const { sunrise, sunset } = computeSunTimes(78.2, 15.6, 2026, 12, 21);
    expect(sunrise).toBeNull();
    expect(sunset).toBeNull();
  });
});

describe("fetchSun", () => {
  const loc = {
    slug: "boca-raton",
    name: "Boca Raton",
    lat: LAT,
    lon: LON,
    timezone: TZ,
  } as Location;

  it("wraps the computed times for the local day with status ok", () => {
    // 2026-06-01 12:00 EDT = 16:00Z — squarely on June 1 in New York.
    const w = fetchSun(loc, new Date("2026-06-01T16:00:00Z"));
    expect(w.status).toBe("ok");
    expect(w.data?.date).toBe("2026-06-01");
    expect(w.data?.daybreak).toBeTruthy();
    expect(w.data?.sunrise).toBeTruthy();
    expect(w.data?.sunset).toBeTruthy();
  });

  it("uses the location timezone to pick the calendar day", () => {
    // 2026-06-02 02:00Z is still 2026-06-01 (10 PM) in New York.
    const w = fetchSun(loc, new Date("2026-06-02T02:00:00Z"));
    expect(w.data?.date).toBe("2026-06-01");
  });
});
