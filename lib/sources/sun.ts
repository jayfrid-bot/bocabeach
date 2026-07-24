import type { Location, SunData, Wrapped } from "@/lib/types";

const ATTRIBUTION = "Computed (NOAA solar position algorithm)";
const SOURCE = "Solar calculator";

// Solar altitudes (as zenith angles, degrees) for each event.
const ZENITH_SUNRISE = 90.833; // upper limb + standard atmospheric refraction
const ZENITH_CIVIL = 96; // civil twilight ("daybreak" / first light)

// Photographic golden/blue hour, as SOLAR ELEVATIONS (degrees above horizon).
// Golden hour is NOT bounded by sunset — it straddles it: the warm, low-angle
// light runs from +6° down through the horizon to −4°. Blue hour is the −4°→−6°
// twilight band just past golden hour. (Widely-used photographic convention;
// e.g. PhotoPills / golden-hour.com use these same +6/−4/−6 bounds.)
const ELEV_GOLDEN_HI = 6; // upper bound of golden hour
const ELEV_GOLDEN_LO = -4; // golden↔blue boundary (below the horizon)
const ELEV_BLUE_LO = -6; // lower bound of blue hour (= civil twilight, −6°)
const ELEV_PEAK = -3; // peak-color anchor: midpoint of the −2°→−4° sweet spot

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
 * The sun's declination and the equation of time for a Julian day, via the NOAA
 * solar-position equations. `lon` is degrees east (negative = west); it only
 * nudges which instant we evaluate the slowly-varying terms at.
 */
function solarParams(
  jd0: number,
  lon: number,
): { declin: number; eqTime: number } {
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

  return { declin, eqTime };
}

/**
 * Hour angle (degrees) at which the sun reaches `zenith` for a given latitude
 * and declination. Null when it never does (polar day/night).
 */
function hourAngle(lat: number, declin: number, zenith: number): number | null {
  const latR = deg2rad(lat);
  const decR = deg2rad(declin);
  const cosH =
    (Math.cos(deg2rad(zenith)) - Math.sin(decR) * Math.sin(latR)) /
    (Math.cos(decR) * Math.cos(latR));
  if (cosH > 1 || cosH < -1) return null;
  return rad2deg(Math.acos(cosH));
}

export interface SunTimes {
  daybreak: Date | null;
  sunrise: Date | null;
  solarNoon: Date | null;
  sunset: Date | null;
  dusk: Date | null;
  // --- True golden/blue hour bounds from the elevation solve (see the ELEV_*
  // constants). Null when the sun never reaches that elevation on this day. ---
  goldenAmStart: Date | null; // sun rising through −4°
  goldenAmEnd: Date | null; // sun rising through +6°
  goldenEveStart: Date | null; // sun descending through +6°
  goldenEveEnd: Date | null; // sun descending through −4°
  blueAmStart: Date | null; // sun rising through −6° (= daybreak)
  blueAmEnd: Date | null; // sun rising through −4°
  blueEveStart: Date | null; // sun descending through −4°
  blueEveEnd: Date | null; // sun descending through −6° (= dusk)
  goldenAmPeak: Date | null; // sun at −3°, rising (pre-sunrise peak color)
  goldenEvePeak: Date | null; // sun at −3°, descending (post-sunset peak color)
  /** Sun's maximum altitude above the horizon at solar noon (degrees). */
  maxAltitudeDeg: number;
}

/**
 * Civil dawn, sunrise, solar noon, sunset and dusk for a calendar day at a
 * coordinate, as UTC instants, plus the peak solar altitude. Pure and
 * deterministic — accurate to ~1 minute, no network.
 */
export function computeSunTimes(
  lat: number,
  lon: number,
  year: number,
  month: number,
  day: number,
): SunTimes {
  const jd0 = julianDay0h(year, month, day);
  const { declin, eqTime } = solarParams(jd0, lon);
  const solarNoonUTC = 720 - 4 * lon - eqTime; // minutes past 0h UTC
  const midnightUTC = Date.UTC(year, month - 1, day);
  const at = (min: number): Date =>
    new Date(midnightUTC + Math.round(min * 60000));

  const haSun = hourAngle(lat, declin, ZENITH_SUNRISE);
  const haCivil = hourAngle(lat, declin, ZENITH_CIVIL);

  // Rising ("am") and descending ("eve") instants the sun passes a given
  // elevation, from the same hour-angle solver (zenith = 90° − elevation).
  // Both null when the sun never reaches that elevation (polar day/night).
  const crossing = (
    elevDeg: number,
  ): { am: Date | null; eve: Date | null } => {
    const ha = hourAngle(lat, declin, 90 - elevDeg);
    if (ha == null) return { am: null, eve: null };
    return { am: at(solarNoonUTC - 4 * ha), eve: at(solarNoonUTC + 4 * ha) };
  };
  const gHi = crossing(ELEV_GOLDEN_HI); // +6°
  const gLo = crossing(ELEV_GOLDEN_LO); // −4°
  const bLo = crossing(ELEV_BLUE_LO); // −6°
  const pk = crossing(ELEV_PEAK); // −3°

  return {
    daybreak: haCivil == null ? null : at(solarNoonUTC - 4 * haCivil),
    sunrise: haSun == null ? null : at(solarNoonUTC - 4 * haSun),
    solarNoon: at(solarNoonUTC),
    sunset: haSun == null ? null : at(solarNoonUTC + 4 * haSun),
    dusk: haCivil == null ? null : at(solarNoonUTC + 4 * haCivil),
    goldenAmStart: gLo.am,
    goldenAmEnd: gHi.am,
    goldenEveStart: gHi.eve,
    goldenEveEnd: gLo.eve,
    blueAmStart: bLo.am,
    blueAmEnd: gLo.am,
    blueEveStart: gLo.eve,
    blueEveEnd: bLo.eve,
    goldenAmPeak: pk.am,
    goldenEvePeak: pk.eve,
    // Altitude at solar noon = 90° − |latitude − declination|.
    maxAltitudeDeg: Math.round((90 - Math.abs(lat - declin)) * 10) / 10,
  };
}

const SYNODIC = 29.530588853; // mean lunar month (days)
const REF_NEW_MOON = Date.UTC(2000, 0, 6, 18, 14); // a known new moon
const MOON_PHASES = [
  { phase: "New moon", emoji: "🌑" },
  { phase: "Waxing crescent", emoji: "🌒" },
  { phase: "First quarter", emoji: "🌓" },
  { phase: "Waxing gibbous", emoji: "🌔" },
  { phase: "Full moon", emoji: "🌕" },
  { phase: "Waning gibbous", emoji: "🌖" },
  { phase: "Last quarter", emoji: "🌗" },
  { phase: "Waning crescent", emoji: "🌘" },
];

/** Moon phase + illumination for an instant (good to ~a few %). Pure. */
export function moonPhase(now: Date): {
  phase: string;
  emoji: string;
  illumination: number;
  fraction: number;
} {
  const days = (now.getTime() - REF_NEW_MOON) / 86400000;
  const frac = (((days % SYNODIC) + SYNODIC) % SYNODIC) / SYNODIC; // 0..1
  const illumination = Math.round(((1 - Math.cos(2 * Math.PI * frac)) / 2) * 100);
  return {
    ...MOON_PHASES[Math.round(frac * 8) % 8],
    illumination,
    fraction: Math.round(frac * 1000) / 1000,
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
    // Tomorrow's sunrise — the sunrise/sunset "sky show" card (lib/sunQuality.ts)
    // looks ahead to it once today's sunset has passed. Date.UTC normalizes the
    // day/month/year rollover, so this is just "the next calendar day".
    const tmr = new Date(Date.UTC(y, m - 1, d + 1));
    const tomorrow = computeSunTimes(
      loc.lat,
      loc.lon,
      tmr.getUTCFullYear(),
      tmr.getUTCMonth() + 1,
      tmr.getUTCDate(),
    );
    const data: SunData = {
      date: `${y}-${pad(m)}-${pad(d)}`,
      daybreak: t.daybreak?.toISOString(),
      sunrise: t.sunrise?.toISOString(),
      solarNoon: t.solarNoon?.toISOString(),
      sunset: t.sunset?.toISOString(),
      dusk: t.dusk?.toISOString(),
      tomorrowSunrise: tomorrow.sunrise?.toISOString(),
      // True golden/blue-hour windows from the elevation solve (undefined, not
      // null, when the sun never reaches that elevation — keeps SunData's
      // optional-string shape and the JSON snapshot small).
      goldenAmStartIso: t.goldenAmStart?.toISOString(),
      goldenAmEndIso: t.goldenAmEnd?.toISOString(),
      goldenEveStartIso: t.goldenEveStart?.toISOString(),
      goldenEveEndIso: t.goldenEveEnd?.toISOString(),
      blueAmStartIso: t.blueAmStart?.toISOString(),
      blueAmEndIso: t.blueAmEnd?.toISOString(),
      blueEveStartIso: t.blueEveStart?.toISOString(),
      blueEveEndIso: t.blueEveEnd?.toISOString(),
      goldenAmPeakIso: t.goldenAmPeak?.toISOString(),
      goldenEvePeakIso: t.goldenEvePeak?.toISOString(),
      tomorrowGoldenAmStartIso: tomorrow.goldenAmStart?.toISOString(),
      tomorrowGoldenAmEndIso: tomorrow.goldenAmEnd?.toISOString(),
      tomorrowGoldenAmPeakIso: tomorrow.goldenAmPeak?.toISOString(),
      maxAltitudeDeg: t.maxAltitudeDeg,
      moonPhase: moonPhase(now),
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
