import { describe, it, expect } from "vitest";
import { computeSunTimes, fetchSun, moonPhase } from "@/lib/sources/sun";
import type { Location } from "@/lib/types";

describe("moonPhase", () => {
  it("identifies a known full moon (2025-06-11) and a new moon (2025-06-25)", () => {
    expect(moonPhase(new Date("2025-06-11T07:44:00Z")).phase).toBe("Full moon");
    expect(moonPhase(new Date("2025-06-11T07:44:00Z")).illumination).toBeGreaterThan(95);
    expect(moonPhase(new Date("2025-06-25T10:32:00Z")).phase).toBe("New moon");
    expect(moonPhase(new Date("2025-06-25T10:32:00Z")).illumination).toBeLessThan(5);
  });
});

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

  it("also returns null golden/blue-hour crossings during polar night", () => {
    const t = computeSunTimes(78.2, 15.6, 2026, 12, 21);
    for (const d of [
      t.goldenAmStart,
      t.goldenAmEnd,
      t.goldenEveStart,
      t.goldenEveEnd,
      t.blueAmStart,
      t.blueEveEnd,
      t.goldenAmPeak,
      t.goldenEvePeak,
    ]) {
      expect(d).toBeNull();
    }
  });
});

describe("computeSunTimes — true golden/blue hour (elevation solve)", () => {
  const t = computeSunTimes(LAT, LON, 2026, 7, 24);

  it("orders the evening sequence: golden start (+6°) → sunset → peak (−3°) → golden end (−4°) → blue end (−6°)", () => {
    const seq = [
      t.goldenEveStart!,
      t.sunset!,
      t.goldenEvePeak!,
      t.goldenEveEnd!,
      t.blueEveEnd!,
    ].map((d) => d.getTime());
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]).toBeGreaterThan(seq[i - 1]);
    }
  });

  it("evening golden hour straddles sunset — it does NOT stop at it", () => {
    expect(t.goldenEveStart!.getTime()).toBeLessThan(t.sunset!.getTime());
    expect(t.goldenEveEnd!.getTime()).toBeGreaterThan(t.sunset!.getTime());
  });

  it("orders the morning sequence: blue start (−6°) → golden start (−4°) → peak (−3°) → sunrise → golden end (+6°)", () => {
    const seq = [
      t.blueAmStart!,
      t.goldenAmStart!,
      t.goldenAmPeak!,
      t.sunrise!,
      t.goldenAmEnd!,
    ].map((d) => d.getTime());
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]).toBeGreaterThan(seq[i - 1]);
    }
  });

  it("blue-hour bounds coincide with the −6° civil-twilight instants (daybreak/dusk)", () => {
    expect(t.blueAmStart!.getTime()).toBe(t.daybreak!.getTime());
    expect(t.blueEveEnd!.getTime()).toBe(t.dusk!.getTime());
    // The blue↔golden boundary is shared (−4°).
    expect(t.blueAmEnd!.getTime()).toBe(t.goldenAmStart!.getTime());
    expect(t.blueEveStart!.getTime()).toBe(t.goldenEveEnd!.getTime());
  });

  it("each golden-hour side runs ~40-55 min at Boca's latitude (sun drops fast, but +6→−4 is 10° of arc)", () => {
    const eveMin = (t.goldenEveEnd!.getTime() - t.goldenEveStart!.getTime()) / 60000;
    const amMin = (t.goldenAmEnd!.getTime() - t.goldenAmStart!.getTime()) / 60000;
    expect(eveMin).toBeGreaterThanOrEqual(40);
    expect(eveMin).toBeLessThanOrEqual(55);
    expect(amMin).toBeGreaterThanOrEqual(40);
    expect(amMin).toBeLessThanOrEqual(55);
    // Post-sunset side (sunset→−4°) is the ~25-35 min "per side of sunset" figure.
    const postSunset = (t.goldenEveEnd!.getTime() - t.sunset!.getTime()) / 60000;
    expect(postSunset).toBeGreaterThanOrEqual(10);
    expect(postSunset).toBeLessThanOrEqual(35);
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

  it("emits the true golden/blue-hour ISO windows (today + tomorrow's morning)", () => {
    const w = fetchSun(loc, new Date("2026-06-01T16:00:00Z"));
    const d = w.data!;
    for (const iso of [
      d.goldenAmStartIso,
      d.goldenAmEndIso,
      d.goldenEveStartIso,
      d.goldenEveEndIso,
      d.blueEveEndIso,
      d.goldenEvePeakIso,
      d.tomorrowGoldenAmStartIso,
      d.tomorrowGoldenAmEndIso,
    ]) {
      expect(iso).toBeTruthy();
      expect(Number.isFinite(Date.parse(iso!))).toBe(true);
    }
    // Evening golden hour runs past sunset.
    expect(Date.parse(d.goldenEveEndIso!)).toBeGreaterThan(Date.parse(d.sunset!));
  });
});
