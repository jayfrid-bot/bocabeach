// ---------------------------------------------------------------------------
// Meteor shower adapter for the "Coming up" sky-events card
// (docs/SKY_EVENTS_PLAN.md §6, Phase 1 Crew A). Pure and deterministic —
// this is a static-calendar lookup (config/meteorShowers.ts) plus local
// astronomy math, never a live fetch, so there's nothing to go stale beyond
// the config table's own current+next-year coverage.
//
// SSR/hydration rule (§9): every function here takes its clock as an
// explicit `nowMs`/instant argument. No Date.now()/new Date() default
// anywhere in this file.
//
// ASTRONOMY-ENGINE NOTE: at the time this file was written, `astronomy-engine`
// (Crew B's dependency add, §4) was NOT YET a package.json dependency — this
// file does not depend on Crew B landing first. Since this adapter needs a
// sun-altitude and a radiant (RA/Dec) altitude check for §5's "dark sky +
// radiant above horizon" rule, it implements its own small local helpers
// below (`solarAltitudeDeg`, `radiantAltitudeDeg`) rather than leaving a
// hook — the math is standard and small (the same NOAA solar-position
// formulas lib/sources/sun.ts already uses, plus a textbook equatorial-to-
// horizontal transform via Greenwich Mean Sidereal Time), and it's
// unit-tested below, including cross-checks against lib/sources/sun.ts's
// own computeSunTimes for the solar half. If/when astronomy-engine lands,
// swapping these two functions for its `Horizon()` is a drop-in change —
// nothing outside this file depends on how they're implemented.
// ---------------------------------------------------------------------------

import { METEOR_SHOWERS } from "@/config/meteorShowers";
import type { MeteorSkyEvent, WrappedMeteorEvents, IsoInterval } from "@/lib/skyEventsTypes";
import { clamp } from "@/lib/util";

const ATTRIBUTION = "Meteor shower calendar (computed)";
const SOURCE = "Meteor shower calendar";

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const mod360 = (x: number): number => ((x % 360) + 360) % 360;

// --- Shared solar position math (mirrors lib/sources/sun.ts's solarParams,
// generalized to an arbitrary instant instead of a single calendar day) ----

function julianDate(ms: number): number {
  return ms / DAY_MS + 2440587.5;
}

/** Sun's apparent declination (deg) and the equation of time (minutes) for a
 *  Julian Date — identical derivation to lib/sources/sun.ts's solarParams. */
function sunDeclinationAndEquationOfTime(jd: number): { declDeg: number; eqTimeMin: number } {
  const t = (jd - 2451545.0) / 36525;
  const l0 = mod360(280.46646 + t * (36000.76983 + t * 0.0003032));
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const mr = m * DEG;
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const c =
    Math.sin(mr) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * mr) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * mr) * 0.000289;
  const trueLong = l0 + c;
  const omega = 125.04 - 1934.136 * t;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * DEG);
  const meanObliq = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliqCorr = meanObliq + 0.00256 * Math.cos(omega * DEG);
  const declDeg = Math.asin(Math.sin(obliqCorr * DEG) * Math.sin(appLong * DEG)) * RAD;
  const varY = Math.tan((obliqCorr / 2) * DEG) ** 2;
  const eqTimeMin =
    4 *
    RAD *
    (varY * Math.sin(2 * l0 * DEG) -
      2 * e * Math.sin(mr) +
      4 * e * varY * Math.sin(mr) * Math.cos(2 * l0 * DEG) -
      0.5 * varY * varY * Math.sin(4 * l0 * DEG) -
      1.25 * e * e * Math.sin(2 * mr));
  return { declDeg, eqTimeMin };
}

function utcMinutesOfDay(ms: number): number {
  const d = new Date(ms);
  return (
    d.getUTCHours() * 60 +
    d.getUTCMinutes() +
    d.getUTCSeconds() / 60 +
    d.getUTCMilliseconds() / 60000
  );
}

/**
 * The Sun's altitude above the horizon (degrees; negative = below), for a
 * lat/lon at an arbitrary UTC instant. Pure, no I/O, accurate to about the
 * same ~1-minute-of-time-equivalent precision as lib/sources/sun.ts's
 * sunrise/sunset (see this file's tests, which cross-check it against
 * `computeSunTimes`'s peak/rise/set values for the same lat/lon/day).
 */
export function solarAltitudeDeg(lat: number, lon: number, ms: number): number {
  const jd = julianDate(ms);
  const { declDeg, eqTimeMin } = sunDeclinationAndEquationOfTime(jd);
  // "True solar time" in minutes past local midnight, wrapped to [0, 1440);
  // 4 minutes of time per degree of longitude east of the prime meridian.
  const trueSolarTimeMin = ((utcMinutesOfDay(ms) + eqTimeMin + 4 * lon) % 1440 + 1440) % 1440;
  const hourAngleDeg = trueSolarTimeMin / 4 - 180; // 0 at local solar noon
  const latR = lat * DEG;
  const declR = declDeg * DEG;
  const haR = hourAngleDeg * DEG;
  const sinAlt = Math.sin(latR) * Math.sin(declR) + Math.cos(latR) * Math.cos(declR) * Math.cos(haR);
  return Math.asin(clamp(sinAlt, -1, 1)) * RAD;
}

/** Greenwich Mean Sidereal Time, in degrees (0-360), for a Julian Date —
 *  the standard low-precision series (Meeus). */
function gmstDeg(jd: number): number {
  const t = (jd - 2451545.0) / 36525;
  const gmst =
    280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * t * t - (t * t * t) / 38710000;
  return mod360(gmst);
}

/**
 * A fixed-RA/Dec radiant's altitude above the horizon (degrees), for a
 * lat/lon at an arbitrary UTC instant — the standard equatorial-to-
 * horizontal transform via local sidereal time. Pure, no I/O.
 */
export function radiantAltitudeDeg(
  lat: number,
  lon: number,
  raDeg: number,
  decDeg: number,
  ms: number,
): number {
  const jd = julianDate(ms);
  const lstDeg = mod360(gmstDeg(jd) + lon); // lon east-positive, same convention as Location.lon
  let haDeg = mod360(lstDeg - raDeg);
  if (haDeg > 180) haDeg -= 360; // fold to [-180, 180]; cos() doesn't care, but keeps values readable
  const latR = lat * DEG;
  const decR = decDeg * DEG;
  const haR = haDeg * DEG;
  const sinAlt = Math.sin(latR) * Math.sin(decR) + Math.cos(latR) * Math.cos(decR) * Math.cos(haR);
  return Math.asin(clamp(sinAlt, -1, 1)) * RAD;
}

// --- Per-beach best observing window (§5, §6) -------------------------------

const DARK_SKY_SUN_ALT_DEG = -18; // astronomical twilight, per §6
const RADIANT_MIN_ALT_DEG = 20; // per §6

const SEARCH_STEP_MS = 5 * MINUTE_MS;
// Widening search bands around the peak instant: most showers' best night is
// well within a day of peak, but the search widens once (to +/-84h) before
// giving up, so a peak that lands mid-afternoon local time still finds the
// nearest qualifying dark-sky night on either side.
const SEARCH_HALF_SPANS_HOURS = [36, 84];

interface Candidate {
  start: number;
  end: number;
}

/**
 * The best local observing interval near a shower's peak: the widest
 * contiguous stretch where the sky is astronomically dark (sun < -18°) AND
 * the radiant is at least 20° above the horizon, picking whichever
 * qualifying night is closest to the peak instant. Returns null when no
 * such interval exists near peak at all (e.g. a high-latitude beach in
 * summer where astronomical twilight never ends) — callers omit the shower
 * for that beach rather than emit a degenerate window (same silent-omission
 * convention as other sources in this app).
 */
export function findBestObservingWindow(
  lat: number,
  lon: number,
  raDeg: number,
  decDeg: number,
  peakMs: number,
): IsoInterval | null {
  for (const halfHours of SEARCH_HALF_SPANS_HOURS) {
    const halfMs = halfHours * HOUR_MS;
    const searchStart = peakMs - halfMs;
    const searchEnd = peakMs + halfMs;

    const candidates: Candidate[] = [];
    let openStart: number | null = null;
    for (let t = searchStart; t <= searchEnd; t += SEARCH_STEP_MS) {
      const qualifies =
        solarAltitudeDeg(lat, lon, t) < DARK_SKY_SUN_ALT_DEG &&
        radiantAltitudeDeg(lat, lon, raDeg, decDeg, t) >= RADIANT_MIN_ALT_DEG;
      if (qualifies && openStart === null) openStart = t;
      if (!qualifies && openStart !== null) {
        candidates.push({ start: openStart, end: t });
        openStart = null;
      }
    }
    if (openStart !== null) candidates.push({ start: openStart, end: searchEnd });

    if (candidates.length > 0) {
      let best = candidates[0];
      let bestDist = Math.abs((best.start + best.end) / 2 - peakMs);
      for (const c of candidates.slice(1)) {
        const dist = Math.abs((c.start + c.end) / 2 - peakMs);
        if (dist < bestDist) {
          best = c;
          bestDist = dist;
        }
      }
      return { start: new Date(best.start).toISOString(), end: new Date(best.end).toISOString() };
    }
  }
  return null;
}

// --- Public adapter ----------------------------------------------------------

const FOURTEEN_DAYS_MS = 14 * DAY_MS;

/** Structurally compatible with `Location` (lib/types.ts) — only the three
 *  fields this adapter's math actually needs, so tests don't need a full
 *  Location fixture (same "isolated module" convention as lib/sunQuality.ts).
 *  `timezone` isn't used by the (UTC-native) astronomy math below; it's kept
 *  on the input shape for API symmetry with the rest of the app and in case
 *  a future caller wants it, but every instant this module returns is UTC. */
export interface MeteorShowerBeachInput {
  lat: number;
  lon: number;
  timezone: string;
}

/**
 * Meteor showers whose peak falls in the next 14 days for one beach, each
 * carrying its own per-beach best observing window (§5, §6). Pure function
 * of `beach` and `nowMs` — no network, no wall clock. `rating` is always
 * `null` here: sky-visibility rating is Crew E/F's Phase 2 job
 * (lib/skyVisibilityQuality.ts + lib/skyEvents.ts), not this adapter's.
 */
export function fetchMeteorShowers(beach: MeteorShowerBeachInput, nowMs: number): WrappedMeteorEvents {
  const fetchedAt = new Date(nowMs).toISOString();
  try {
    const windowEnd = nowMs + FOURTEEN_DAYS_MS;
    const events: MeteorSkyEvent[] = [];

    for (const shower of METEOR_SHOWERS) {
      for (const yearPeak of shower.peaks) {
        const peakMs = Date.parse(yearPeak.peak);
        if (!(peakMs >= nowMs && peakMs < windowEnd)) continue;

        const bestLocalWindow = findBestObservingWindow(
          beach.lat,
          beach.lon,
          shower.radiantRaDeg,
          shower.radiantDecDeg,
          peakMs,
        );
        if (bestLocalWindow === null) continue; // silently omitted — never a guessed window (§6)

        events.push({
          eventType: "meteor",
          showerId: shower.showerId,
          showerName: shower.showerName,
          peak: yearPeak.peak,
          activityWindow: yearPeak.activityWindow,
          bestLocalWindow,
          radiantRaDeg: shower.radiantRaDeg,
          radiantDecDeg: shower.radiantDecDeg,
          zhr: shower.zhr,
          sourceEdition: yearPeak.sourceEdition,
          rating: null,
        });
      }
    }

    events.sort((a, b) => Date.parse(a.peak) - Date.parse(b.peak));

    return {
      source: SOURCE,
      status: "ok",
      fetchedAt,
      attribution: ATTRIBUTION,
      data: events,
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
