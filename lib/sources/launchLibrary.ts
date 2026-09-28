/**
 * Where the rocket-launch feed for the "Coming up" sky-events card lives
 * (SKY_EVENTS_PLAN.md §7, §8, §13 Crew C). Same conventions as
 * lib/sources/ripNwps.ts: a one-shot preprocess script
 * (scripts/launch_library.mjs), run on a schedule by
 * .github/workflows/launch-library.yml, publishes ONE small
 * launch_data.json to its OWN `launch-data` branch — never shared with any
 * other feed's branch (the sargassum-data force-push wipeout lesson, §2).
 * The app fetches the small published file instead of hitting LL2
 * (thespacedevs.com) per beach per request, which would blow through LL2's
 * unauthenticated rate limit (~15 requests/hour, confirmed live 2026-09-28
 * by hitting it — see scripts/launch_library.mjs's header).
 *
 * This module does two jobs, same split as ripNwps.ts:
 *   1. Load + defense-in-depth-validate the published feed (untrusted input
 *      at the adapter boundary, §9 — the script already validates before
 *      publishing, but a corrupted publish or a future script bug must
 *      never reach a caller as a plausible-looking but wrong event).
 *   2. Turn each validated feed entry into a per-BEACH `LaunchSkyEvent`:
 *      great-circle bearing/distance (beach -> pad), the §7 range-tier
 *      eligibility rule, and day/twilight/night light state for both the
 *      observer and the pad, each independently evaluated at the launch's
 *      own `net` instant (never a borrowed sunrise/sunset window).
 *
 * Every function that depends on "now" takes it as an explicit parameter —
 * no `Date.now()`/`new Date()` inside any pure helper — so this module is
 * cache-deterministic and safe to call from a pinned conditions-snapshot
 * build (§9's SSR-safety rule).
 */
import { LAUNCH_PADS, LAUNCH_RANGES, type LaunchPad } from "@/config/launchPads";
import { angularDistance, bearingDeg, degToCardinal, fetchedAtOf, fetchWithTimeout, haversineMiles, oldestIso } from "@/lib/util";
import type {
  LaunchFeedEntry,
  LaunchFeedPayload,
  LaunchSkyEvent,
  WrappedLaunchEvents,
} from "@/lib/skyEventsTypes";

const FEED_BASE =
  process.env.LAUNCH_LIBRARY_FEED_BASE ??
  "https://raw.githubusercontent.com/jayfrid-bot/bocabeach/launch-data";

export function launchLibraryFeedUrl(): string {
  return `${FEED_BASE}/launch_data.json`;
}

const ATTRIBUTION = "The Space Devs Launch Library 2 (thespacedevs.com)";
const SOURCE = "Launch Library 2 (LL2)";

/** Feed older than this -> no launches shown on the card at all (§8): a
 *  launch that might have scrubbed hours ago with no update is never shown
 *  as if it were current. */
export const LAUNCH_CARD_MAX_FEED_AGE_MS = 6 * 60 * 60 * 1000; // 6h

/** Feed older than this -> no launch ALERT fires, even if the card still
 *  shows the (still-under-6h) data (§7, §8, §10) — alerts need fresher data
 *  than the card does. Each produced `LaunchSkyEvent.source.feedGeneratedAt`
 *  carries what Phase 3's alert-eligibility check (Crew G, §10) needs to
 *  apply this gate itself; `isLaunchFeedFreshForAlerts` below is a
 *  ready-made helper for that check. */
export const LAUNCH_ALERT_MAX_FEED_AGE_MS = 45 * 60 * 1000; // 45 min

/** How far into the future a feed's own `generatedAt` may plausibly sit
 *  (clock-skew tolerance) before it's treated as corrupted/untrustworthy
 *  rather than "very fresh" — applies to BOTH the 6h card gate and the
 *  45-min alert gate below (§9's timestamp-sanity rule: an implausible
 *  future timestamp is exactly the kind of "plausible-looking but wrong"
 *  value this adapter must never trust at face value). */
const MAX_FUTURE_SKEW_MS = 10 * 60 * 1000; // 10 min

/** Whether a launch event's own feed is fresh enough to be alert-eligible
 *  (§7, §10) — exported for Phase 3 (Crew G) to reuse rather than
 *  re-deriving the 45-min gate. Pure; both instants are explicit params. */
export function isLaunchFeedFreshForAlerts(feedGeneratedAtIso: string, nowMs: number): boolean {
  const t = Date.parse(feedGeneratedAtIso);
  if (!Number.isFinite(t)) return false;
  const ageMs = nowMs - t;
  if (ageMs < -MAX_FUTURE_SKEW_MS) return false; // implausibly future generatedAt — never "very fresh"
  return ageMs <= LAUNCH_ALERT_MAX_FEED_AGE_MS;
}

/** Only these `net_precision` names ever normalize to something other than
 *  "Unknown" (§7's card-display rule needs exactly "Minute" to be
 *  distinguishable from every coarser precision). LL2 has finer-grained
 *  entries than our closed enum (e.g. "Second", "Quarter 4", "Year Half 2",
 *  confirmed live 2026-09-28 against 100 upcoming launches) — each folds
 *  into the nearest bucket our type actually has. */
export function normalizeNetPrecision(raw: unknown): LaunchSkyEvent["netPrecision"] {
  if (typeof raw !== "string" || !raw) return "Unknown";
  const s = raw.trim().toLowerCase();
  if (s.startsWith("second") || s.startsWith("minute")) return "Minute";
  if (s.startsWith("hour")) return "Hour";
  if (s.startsWith("day")) return "Day";
  if (s.startsWith("month")) return "Month";
  if (s.startsWith("quarter")) return "Quarter";
  if (s.startsWith("year")) return "Year"; // covers "Year" and "Year Half N"
  return "Unknown";
}

/** LL2's real status abbrevs that count as "still upcoming/active" (§7),
 *  mapped onto our closed `LaunchSkyEvent["status"]` enum. LL2 also has a
 *  "TBC" (To Be Confirmed) status our frozen type has no variant for —
 *  folded into "TBD", the closest existing meaning (both say "the exact
 *  time isn't locked yet"). Every ended/terminal LL2 status (Success,
 *  Failure, Partial Failure, Cancelled) — and anything NOT in this map,
 *  safe-by-default — is rejected: never assumed active (§7's explicit
 *  reject list: "Cancelled, Success ..., Failure, or otherwise ended"). */
export const ACTIVE_STATUS_MAP: Readonly<Record<string, LaunchSkyEvent["status"]>> = {
  Go: "Go",
  TBD: "TBD",
  TBC: "TBD",
  Hold: "Hold",
  "In Flight": "In Flight",
};

/** Mirrors scripts/launch_library.mjs's own `ORBIT_ALLOWLIST` (§7) — kept
 *  in sync by hand, same convention as `ACTIVE_STATUS_MAP` and
 *  `normalizeNetPrecision` above. Defense-in-depth (§9): the script already
 *  filters a raw `mission.orbit.abbrev` through this exact allowlist before
 *  ever publishing it, but this adapter re-validates a published entry's
 *  `orbitAbbrev` independently too — a corrupted publish, a manually-edited
 *  file, or a future script bug (e.g. publishing "Sub" instead of null)
 *  must never let a non-orbital launch masquerade as `knownOrbital` at the
 *  §7 mid-tier eligibility gate. */
const ORBIT_ALLOWLIST = new Set(["LEO", "MEO", "GTO", "Direct-GEO", "GEO", "SSO", "PO", "HEO", "LO", "Mars"]);

/** Strips control characters and caps length — the string-sanitization
 *  rule every untrusted feed field goes through (§9: "length, control
 *  chars, enum allowlists, size limit"). Returns null for anything that
 *  isn't a non-empty string once sanitized. */
function sanitizeString(s: unknown, maxLen: number): string | null {
  if (typeof s !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = s.replace(/[\x00-\x1F\x7F]/g, "").trim();
  if (!cleaned) return null;
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

function isFiniteInt(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && Number.isInteger(n);
}

function isIsoInstant(s: unknown): s is string {
  return typeof s === "string" && Number.isFinite(Date.parse(s));
}

const MAX_LAUNCHES_IN_FEED = 200; // size limit (§9) — 14 days of global launches never gets close to this

/**
 * Defense-in-depth validation of ONE published feed entry (§9): the script
 * already validates/rejects before publishing, but this adapter treats the
 * published JSON as untrusted input too. Rejects (returns null for) any
 * entry missing/malforming a required field, whose `status` or
 * `netPrecision` fall outside the closed enums this file recognizes, or
 * whose `windowEnd` precedes `windowStart` — never guesses a plausible-
 * looking but wrong value.
 */
function sanitizeFeedEntry(raw: unknown): LaunchFeedEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = sanitizeString(r.id, 100);
  const name = sanitizeString(r.name, 200);
  if (!id || !name) return null;
  if (!isIsoInstant(r.net) || !isIsoInstant(r.windowStart) || !isIsoInstant(r.windowEnd) || !isIsoInstant(r.lastUpdated)) {
    return null;
  }
  if (Date.parse(r.windowEnd as string) < Date.parse(r.windowStart as string)) return null;
  const netPrecision = normalizeNetPrecision(r.netPrecision);
  const rawStatus = typeof r.status === "string" ? r.status : "";
  const status = ACTIVE_STATUS_MAP[rawStatus];
  if (!status) return null; // includes ended/cancelled/unrecognized statuses — reject (§7)
  if (!isFiniteInt(r.padId) || !isFiniteInt(r.padLocationId)) return null;
  const rawOrbitAbbrev = r.orbitAbbrev === null ? null : sanitizeString(r.orbitAbbrev, 40);
  // §7/§9 defense-in-depth: re-check against the allowlist here too — never
  // trust the published field's non-null-ness alone as proof of "orbital".
  const orbitAbbrev = rawOrbitAbbrev !== null && ORBIT_ALLOWLIST.has(rawOrbitAbbrev) ? rawOrbitAbbrev : null;
  return {
    id,
    name,
    net: r.net as string,
    netPrecision,
    windowStart: r.windowStart as string,
    windowEnd: r.windowEnd as string,
    status,
    padId: r.padId,
    padLocationId: r.padLocationId,
    orbitAbbrev,
    lastUpdated: r.lastUpdated as string,
  };
}

function sanitizeFeedPayload(raw: unknown): { generatedAt: string; launches: LaunchFeedEntry[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== 1) return null;
  if (!isIsoInstant(r.generatedAt)) return null;
  // A missing or non-array `launches` is a MALFORMED payload, not a valid
  // empty one (§9) — a genuinely empty result is always `launches: []`
  // (an array), never an absent/wrong-typed field; conflating the two would
  // let a truncated/corrupted publish masquerade as an honest "nothing
  // right now" (§8).
  if (!Array.isArray(r.launches)) return null;
  const rawLaunches = r.launches.slice(0, MAX_LAUNCHES_IN_FEED);
  const launches: LaunchFeedEntry[] = [];
  for (const entry of rawLaunches) {
    const clean = sanitizeFeedEntry(entry);
    if (clean) launches.push(clean);
  }
  return { generatedAt: r.generatedAt as string, launches };
}

let cachedFeed: { fetchedAt: string; generatedAt: string; launches: LaunchFeedEntry[] } | null = null;
let cachedAtMs = 0;
const PROCESS_CACHE_MS = 60_000; // avoid re-fetching the same small feed for every beach in one request burst
// In-flight promise shared by every concurrent caller within the cache
// window — same rationale as ripNwps.ts's `inFlight`: a cold build calling
// this for many beaches essentially simultaneously must share ONE fetch of
// the small published file, not kick off a redundant one per beach.
let inFlight: Promise<{ fetchedAt: string; generatedAt: string; launches: LaunchFeedEntry[] } | null> | null = null;

async function loadFeed(): Promise<{ fetchedAt: string; generatedAt: string; launches: LaunchFeedEntry[] } | null> {
  const now = Date.now();
  if (cachedFeed && now - cachedAtMs < PROCESS_CACHE_MS) return cachedFeed;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await fetchWithTimeout(launchLibraryFeedUrl(), {
        timeoutMs: 7000,
        next: { revalidate: 900 }, // the workflow republishes every ~30 min; 15 min keeps this comfortably fresh
      });
      if (!res.ok) return null;
      const json = (await res.json()) as unknown;
      const payload = sanitizeFeedPayload(json);
      if (!payload) return null;
      const fetchedAt = oldestIso(payload.generatedAt, fetchedAtOf(res));
      const result = { fetchedAt, generatedAt: payload.generatedAt, launches: payload.launches };
      cachedFeed = result;
      cachedAtMs = Date.now();
      return result;
    } catch {
      return null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

// --- Solar altitude (pure, no network) --------------------------------

const deg2rad = (d: number) => (d * Math.PI) / 180;
const rad2deg = (r: number) => (r * 180) / Math.PI;
const mod360 = (x: number) => ((x % 360) + 360) % 360;
const clampUnit = (n: number) => Math.min(1, Math.max(-1, n));

/**
 * Solar altitude (degrees above the horizon, negative = below) at an
 * arbitrary lat/lon and UTC instant — the general NOAA solar-position
 * algorithm, evaluated at an arbitrary INSTANT rather than solved for a
 * sunrise/sunset zenith crossing (which is what lib/sources/sun.ts's
 * computeSunTimes does for a fixed calendar date). Self-contained here,
 * not imported from sun.ts: this file owns its own solar-position math so
 * Crew C's files stay disjoint from lib/sources/sun.ts, which other crews
 * may also be touching (§13's file-ownership rule). Pure — `date` is
 * always the caller's own explicit instant (§7, §9).
 */
export function solarAltitudeDeg(lat: number, lon: number, date: Date): number {
  const jd = date.getTime() / 86_400_000 + 2440587.5;
  const t = (jd - 2451545.0) / 36525;

  const l0 = mod360(280.46646 + t * (36000.76983 + t * 0.0003032));
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const mr = deg2rad(m);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const c =
    Math.sin(mr) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * mr) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * mr) * 0.000289;
  const trueLong = l0 + c;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(deg2rad(125.04 - 1934.136 * t));
  const meanObliq = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliqCorr = meanObliq + 0.00256 * Math.cos(deg2rad(125.04 - 1934.136 * t));
  const declin = rad2deg(Math.asin(Math.sin(deg2rad(obliqCorr)) * Math.sin(deg2rad(appLong))));

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

  const utcMinutes = (date.getTime() / 60_000) % 1440;
  let trueSolarTime = (utcMinutes + eqTime + 4 * lon) % 1440;
  if (trueSolarTime < 0) trueSolarTime += 1440;

  const hourAngle = trueSolarTime / 4 - 180; // degrees; folds the "am negative, pm positive" split into one expression

  const latR = deg2rad(lat);
  const decR = deg2rad(declin);
  const haR = deg2rad(hourAngle);
  const cosZenith = Math.sin(latR) * Math.sin(decR) + Math.cos(latR) * Math.cos(decR) * Math.cos(haR);
  const zenith = rad2deg(Math.acos(clampUnit(cosZenith)));
  return 90 - zenith;
}

/** Day/twilight/night from solar altitude (§7): day >=0°, twilight
 *  -18°..<0° (civil+nautical+astronomical twilight banded together), night
 *  <-18°. Shared by both the observer's and the pad's light state. */
export function lightStateForAltitude(altDeg: number): LaunchSkyEvent["observerLightState"] {
  if (altDeg >= 0) return "day";
  if (altDeg >= -18) return "twilight";
  return "night";
}

// --- Where to look (§7, §9) --------------------------------------------

const CARDINAL_WORDS: Readonly<Record<string, string>> = {
  N: "north",
  NNE: "north-northeast",
  NE: "northeast",
  ENE: "east-northeast",
  E: "east",
  ESE: "east-southeast",
  SE: "southeast",
  SSE: "south-southeast",
  S: "south",
  SSW: "south-southwest",
  SW: "southwest",
  WSW: "west-southwest",
  W: "west",
  WNW: "west-northwest",
  NW: "northwest",
  NNW: "north-northwest",
};

const PRIMARY_DIRECTIONS: readonly [string, number][] = [
  ["north", 0],
  ["east", 90],
  ["south", 180],
  ["west", 270],
];

/** Plain-English "where to look" line for a launch's bearing (§7, §12):
 *  "bearing 349° (nearly due north)" for a bearing within 15° of — but not
 *  exactly on — one of the 4 PRIMARY compass points (checked directly by
 *  angular distance to each of N/E/S/W, not by first snapping to the
 *  nearest 16-point cardinal — 349° snaps to "NNW" at the 16-point
 *  resolution, which would miss that it's actually only 11° off due
 *  north), "bearing N° (due north)" for an exact primary bearing, and the
 *  plain 16-point word (via `degToCardinal`) for anything farther from
 *  every primary. Boca Raton -> the Cape Canaveral SLC-40 pad computes to
 *  348.5°, which rounds to 349° — matches SKY_EVENTS_PLAN.md §7's own
 *  "Boca -> Cape ≈349°" citation (verified in this file's test suite). */
export function describeBearing(deg: number): string {
  const rounded = Math.round(deg);
  let closestWord = PRIMARY_DIRECTIONS[0][0];
  let closestDist = Infinity;
  for (const [word, primaryDeg] of PRIMARY_DIRECTIONS) {
    const d = angularDistance(deg, primaryDeg);
    if (d < closestDist) {
      closestDist = d;
      closestWord = word;
    }
  }
  if (closestDist === 0) return `bearing ${rounded}° (due ${closestWord})`;
  if (closestDist <= 15) return `bearing ${rounded}° (nearly due ${closestWord})`;
  return `bearing ${rounded}° (${CARDINAL_WORDS[degToCardinal(deg)]})`;
}

// --- Range tier + pad resolution (§7) -----------------------------------

const NEAR_MAX_MILES = 50;
const MID_MAX_MILES = 200;

/** Distance-only tier, before the mid-tier's extra orbital/twilight gate is
 *  applied: "near" (<=50mi, any launch), "mid" (50-200mi, gated further),
 *  or null (>200mi — always omitted, §7, never becomes a `rangeTier`). */
export function distanceTier(miles: number): "near" | "mid" | null {
  if (miles <= NEAR_MAX_MILES) return "near";
  if (miles <= MID_MAX_MILES) return "mid";
  return null;
}

/** This pad's coordinate: the specific pad if catalogued in
 *  config/launchPads.ts AND its catalogued `locationId` agrees with the
 *  entry's own claimed `padLocationId` (a mismatch — corrupted feed data, a
 *  future LL2 reassignment, or a copy/paste error — is dropped rather than
 *  trusted; never silently resolved to the catalogued location while the
 *  entry itself disagrees, §9); else the range's fallback centroid (matched
 *  by `padLocationId` alone, for an uncatalogued-but-otherwise-consistent
 *  pad id); else null when the location isn't one of our 4 ranges at all
 *  (shouldn't happen — the published feed is already filtered to them —
 *  but never assumed). */
export function resolvePadCoordinate(padId: number, padLocationId: number): { lat: number; lon: number } | null {
  const pad: LaunchPad | undefined = LAUNCH_PADS[padId];
  if (pad) {
    if (pad.locationId !== padLocationId) return null;
    return { lat: pad.lat, lon: pad.lon };
  }
  const range = LAUNCH_RANGES.find((r) => r.locationIds.includes(padLocationId));
  if (range) return { lat: range.fallbackLat, lon: range.fallbackLon };
  return null;
}

/**
 * One feed entry -> one beach's `LaunchSkyEvent`, or null when this launch
 * isn't eligible for this beach at all (§7): pad unresolvable, >200mi
 * (far tier, never shown), or 50-200mi without both known-orbital AND the
 * observer's own sun below the horizon at `net`. `rating` is always null
 * here — Phase 2B (Crew F, lib/skyEvents.ts) fills it in via Crew E's
 * `skyVisibilityQuality`, once that interface exists; this Phase 1 adapter
 * only produces the unrated event (§13's phase ordering).
 */
export function buildLaunchSkyEvent(
  entry: LaunchFeedEntry,
  beach: { lat: number; lon: number },
  feedGeneratedAt: string,
): LaunchSkyEvent | null {
  const padCoord = resolvePadCoordinate(entry.padId, entry.padLocationId);
  if (!padCoord) return null;

  const distanceMiles = haversineMiles(beach.lat, beach.lon, padCoord.lat, padCoord.lon);
  const tier = distanceTier(distanceMiles);
  if (!tier) return null; // >200mi — omitted entirely, §7

  const netDate = new Date(entry.net);
  const observerAlt = solarAltitudeDeg(beach.lat, beach.lon, netDate);
  const padAlt = solarAltitudeDeg(padCoord.lat, padCoord.lon, netDate);
  const observerLightState = lightStateForAltitude(observerAlt);
  const padLightState = lightStateForAltitude(padAlt);

  const knownOrbital = entry.orbitAbbrev !== null;
  if (tier === "mid" && !(knownOrbital && observerAlt < 0)) {
    // 50-200mi: only known-orbital launches, and only when the OBSERVER's
    // own sky is already below the day/twilight line at `net` (§7) — a
    // daytime 150mi launch is too faint regardless of the pad's own light
    // state.
    return null;
  }

  const bearing = bearingDeg(beach.lat, beach.lon, padCoord.lat, padCoord.lon);

  return {
    eventType: "launch",
    ll2Id: entry.id,
    name: entry.name,
    net: entry.net,
    netPrecision: entry.netPrecision,
    windowStart: entry.windowStart,
    windowEnd: entry.windowEnd,
    status: entry.status,
    padId: entry.padId,
    padLocationId: entry.padLocationId,
    observerLightState,
    padLightState,
    rangeTier: tier,
    knownOrbital,
    whereToLook: { bearingDeg: bearing, line: describeBearing(bearing) },
    rating: null, // Phase 2B fills this in (§13)
    source: {
      feedGeneratedAt,
      // A launch stops being a valid "upcoming" event once its own window
      // has passed — independent of the feed's own 6h staleness gate,
      // which is applied separately, before this function is even called
      // (see fetchLaunchEvents below).
      validThrough: entry.windowEnd,
    },
  };
}

/**
 * All launch events eligible for one beach, soonest-`net`-first. Applies
 * the §8 6-hour card staleness gate (a stale feed publishes NO launches,
 * rather than showing possibly-scrubbed data) before doing any per-launch
 * work. `now` is an explicit param — never `Date.now()` internally (§9).
 */
export async function fetchLaunchEvents(beach: { lat: number; lon: number }, now: Date = new Date()): Promise<WrappedLaunchEvents> {
  const fetchedAt = now.toISOString();
  const loaded = await loadFeed();
  if (!loaded) {
    return {
      source: SOURCE,
      attribution: ATTRIBUTION,
      fetchedAt,
      status: "best-effort",
      data: null,
      note: "launch feed unavailable",
    };
  }
  const feedAgeMs = now.getTime() - Date.parse(loaded.generatedAt);
  const implausiblyFuture = feedAgeMs < -MAX_FUTURE_SKEW_MS;
  if (!Number.isFinite(feedAgeMs) || implausiblyFuture || feedAgeMs > LAUNCH_CARD_MAX_FEED_AGE_MS) {
    return {
      source: SOURCE,
      attribution: ATTRIBUTION,
      fetchedAt: loaded.fetchedAt,
      status: "best-effort",
      data: [],
      note: implausiblyFuture
        ? `launch feed timestamp implausible (generatedAt ${loaded.generatedAt} is in the future)`
        : `launch feed stale (generated ${loaded.generatedAt})`,
    };
  }
  const events: LaunchSkyEvent[] = [];
  for (const entry of loaded.launches) {
    const event = buildLaunchSkyEvent(entry, beach, loaded.generatedAt);
    if (event) events.push(event);
  }
  events.sort((a, b) => Date.parse(a.net) - Date.parse(b.net));
  return {
    source: SOURCE,
    attribution: ATTRIBUTION,
    fetchedAt: loaded.fetchedAt,
    status: "ok",
    data: events,
  };
}

// Re-exported for tests / Phase 2B consumers that want the raw feed shape
// without going through the per-beach mapping.
export type { LaunchFeedEntry, LaunchFeedPayload };
