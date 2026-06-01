import type { Location, SunData, Wrapped } from "@/lib/types";

const ATTRIBUTION = "Computed (NOAA solar position algorithm)";
const SOURCE = "Solar calculator";

// Solar altitudes (as zenith angles, degrees) for each event.
const ZENITH_SUNRISE = 90.833; // upper limb + standard atmospheric refraction
const ZENITH_CIVIL = 96; // civil twilight ("daybreak" / first light)

const deg2rad = (d: number) => (d * Math.PI) / 180;
const rad2deg = (r: number) => (r * 180) / Math.PI;
const mod360 = (x: number) => ((x % 360) + 360) % 360;
const pad = (n: number) => String(n).padStart(2, "0");

/** Julian Day number at 0h UTC for a Gregorian calendar date. */
function julianDay0h(year: number, month: number, day: number): number {
  let y = year;
  let m = month;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);
  return (
    Math.floor(365.25 * (y + 4716)) +
    Math.floor(30.6001 * (m + 1)) +
    day +
    b -
    1524.5
  );
}

/**
 * Minutes past 0h UTC of a solar event on the given Julian day, using the NOAA
 * solar-position equations. `lon` is degrees east (negative = west). Returns
 * null when the sun never reaches that altitude (polar day/night).
 */
function eventMinutesUTC(
  jd0: number,
  lat: number,
  lon: number,
  zenith: number,
  rising: boolean,
): number | null {
  // Julian century at ~solar noon UTC (good enough for declination / eq. of time).
  const t = (jd0 + (720 - 4 * lon) / 1440 - 2451545.0) / 36525;

  const l0 = mod360(280.46646 + t * (36000.76983 + t * 0.0003032));
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const mr = deg2rad(m);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const c =
    Math.sin(mr) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * mr) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * mr) * 0.000289;
  const appLong =
    l0 + c - 0.00569 - 0.00478 * Math.sin(deg2rad(125.04 - 1934.136 * t));
  const meanObliq =
    23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliqCorr = meanObliq + 0.00256 * Math.cos(deg2rad(125.04 - 1934.136 * t));
  const declin = rad2deg(
    Math.asin(Math.sin(deg2rad(obliqCorr)) * Math.sin(deg2rad(appLong))),
  );

  const varY = Math.tan(deg2rad(obliqCorr / 2)) ** 2;
  const eqTime =
    4 *
    rad2deg(
      varY * Math.sin(2 * deg2rad(l0)) -
        2 * e * Math.sin(mr) +
        4 * e * varY * Math.sin(mr) * Math.cos(2 * deg2rad(l0)) -
        0.5 * varY * varY * Math.sin(4 * deg2rad(l0)) -
        1.25 * e * e * Math.sin(2 * mr),
    ); // minutes

  const latR = deg2rad(lat);
  const decR = deg2rad(declin);
  const cosH =
    (Math.cos(deg2rad(zenith)) - Math.sin(decR) * Math.sin(latR)) /
    (Math.cos(decR) * Math.cos(latR));
  if (cosH > 1 || cosH < -1) return null;
  const ha = rad2deg(Math.acos(cosH)); // hour angle, degrees

  const solarNoonUTC = 720 - 4 * lon - eqTime; // minutes past 0h UTC
  return rising ? solarNoonUTC - 4 * ha : solarNoonUTC + 4 * ha;
}

export interface SunTimes {
  daybreak: Date | null;
  sunrise: Date | null;
  sunset: Date | null;
}

/**
 * Civil dawn, sunrise and sunset for a calendar day at a coordinate, as UTC
 * instants. Pure and deterministic — accurate to ~1 minute, no network.
 */
export function computeSunTimes(
  lat: number,
  lon: number,
  year: number,
  month: number,
  day: number,
): SunTimes {
  const jd0 = julianDay0h(year, month, day);
  const midnightUTC = Date.UTC(year, month - 1, day);
  const at = (zenith: number, rising: boolean): Date | null => {
    const min = eventMinutesUTC(jd0, lat, lon, zenith, rising);
    return min == null ? null : new Date(midnightUTC + Math.round(min * 60000));
  };
  return {
    daybreak: at(ZENITH_CIVIL, true),
    sunrise: at(ZENITH_SUNRISE, true),
    sunset: at(ZENITH_SUNRISE, false),
  };
}

/** The calendar Y/M/D for `now` as observed in the given IANA timezone. */
function localYMD(
  tz: string,
  now: Date,
): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

/**
 * Today's daybreak/sunrise/sunset for a location. Computed locally (no fetch),
 * so it always resolves; `now` is injectable for testing.
 */
export function fetchSun(loc: Location, now: Date = new Date()): Wrapped<SunData> {
  const fetchedAt = now.toISOString();
  try {
    const { y, m, d } = localYMD(loc.timezone, now);
    const t = computeSunTimes(loc.lat, loc.lon, y, m, d);
    const data: SunData = {
      date: `${y}-${pad(m)}-${pad(d)}`,
      daybreak: t.daybreak?.toISOString(),
      sunrise: t.sunrise?.toISOString(),
      sunset: t.sunset?.toISOString(),
    };
    const ok = Boolean(data.sunrise && data.sunset);
    return {
      source: SOURCE,
      status: ok ? "ok" : "best-effort",
      fetchedAt,
      attribution: ATTRIBUTION,
      data,
      note: ok ? undefined : "polar day/night — sun never crosses the horizon",
    };
  } catch (e) {
    return {
      source: SOURCE,
      status: "error",
      fetchedAt,
      attribution: ATTRIBUTION,
      data: null,
      note: String(e),
    };
  }
}
