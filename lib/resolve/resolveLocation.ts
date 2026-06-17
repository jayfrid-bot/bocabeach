// Top-level location resolver: from a free-text beach/city query, geocode, pick
// the chosen beach point, gate it as coastal+US, then resolve the data-driven
// `Location` fields (tide/buoy stations, surf zone, timezone) concurrently — each
// wrapped so a single failing lookup degrades to null + a warning instead of
// throwing. Curated fields (cams, cityConditionsUrl, healthyBeaches) are left
// empty/undefined for a human to fill in later.
//
// House style mirrors lib/sources/nws.ts: the network/registry-touching helpers
// (geocodeName, resolveSurfZone, the loaders) never throw and return typed
// degraded values; resolveBeach orchestrates them and itself never throws.
//
// Dependency injection: every side-effecting collaborator is reachable through an
// optional `deps` bag so tests can supply fixture registries and stubbed network
// calls without mocking the module system. Defaults wire the real modules.

import type { Location } from "@/lib/types";
import { listLocations } from "@/config/locations";

import { coastalGate } from "./coastalGate";
import { geocodeName } from "./geocode";
import {
  loadBeachRegistry,
  matchBeachByName,
  nearestBeaches,
  type RankedBeach,
} from "./beachRegistry";
import {
  loadBuoyStations,
  loadTideStations,
  nearestBuoys,
  nearestTideStations,
} from "./stationRegistry";
import { resolveSurfZone } from "./nwsZone";
import { resolveTimezone } from "./timezone";
import { uniqueSlug } from "./slug";
import type {
  BeachEntry,
  BuoyStation,
  Candidate,
  Confidence,
  GeoPoint,
  Provenance,
  ResolveResult,
  ResolvedField,
  TideStation,
  Warning,
  WarningCode,
} from "./types";

import { bearingDeg, haversineMiles, round } from "@/lib/util";

/** Options accepted by {@link resolveBeach}. */
export interface ResolveOptions {
  /** When the chosen point is ambiguous, pick `candidates[pick]` instead of returning a pick-list. */
  pick?: number;
  /** Slugs already in use (for collision-free slugging). Defaults to the configured locations. */
  takenSlugs?: string[];
  /** Max distance (statute miles) from a city centroid to its nearest beach. Default 30. */
  maxBeachMiles?: number;
}

/**
 * Injectable collaborators. Tests pass fixture registries + stubbed network calls
 * here; production leaves it empty and the real modules are used.
 */
export interface ResolveDeps {
  geocodeName: typeof geocodeName;
  loadBeachRegistry: typeof loadBeachRegistry;
  loadTideStations: typeof loadTideStations;
  loadBuoyStations: typeof loadBuoyStations;
  resolveSurfZone: typeof resolveSurfZone;
}

const DEFAULT_DEPS: ResolveDeps = {
  geocodeName,
  loadBeachRegistry,
  loadTideStations,
  loadBuoyStations,
  resolveSurfZone,
};

/** Default coastal-gate / nearest-beach radius (statute miles). */
const DEFAULT_MAX_BEACH_MILES = 30;
/** A city centroid auto-picks its nearest beach when the 2nd is at least this much farther. */
const BEACH_TIE_MILES = 8;
/**
 * When the nearest beach sits within this distance of the city centroid it is
 * unambiguously "the city's beach" (the centroid is on its own beachfront), so
 * we auto-pick the nearest even if a second beach is close behind it.
 */
const CITY_OWN_BEACH_MILES = 3;
/** A beach-name match is "strong" (the chosen point) below this distance gap to the 2nd hit. */
const STRONG_BEACH_GAP_MILES = 5;
/**
 * A named beach within this distance of the city centroid is treated as "the
 * city's beach" and preferred over the centroid itself. Beyond it, we fall back
 * to the town's own coastal point (below) rather than pointing at a far beach.
 */
const NEAR_NAMED_BEACH_MI = 10;
/**
 * The city centroid counts as coastal (so the town IS its own beachfront) when a
 * NOAA tide station sits within this distance — used when no named beach is close
 * (e.g. Boca Raton / Cocoa Beach, whose beaches aren't named "Beach" in GNIS).
 */
const COASTAL_ANCHOR_MI = 12;

// --- warning helpers --------------------------------------------------------

const WARN_MESSAGES: Record<WarningCode, string> = {
  AMBIGUOUS_CITY: "Multiple US cities matched in different states; pick one.",
  BEACH_NAME_COLLISION: "Several beaches share this name; pick one.",
  NO_TIDE_IN_RANGE: "No NOAA tide station found in range of the beach point.",
  NO_BUOY_IN_RANGE: "No NDBC buoy found in range of the beach point.",
  SURF_ZONE_UNCERTAIN: "Surf-zone block name is uncertain; verify against the SRF product.",
  COASTAL_GATE_FAIL: "No coastal beach in range; the point looks inland or out of coverage.",
  INLAND_BEACH_SUSPECT: "Beach matched but the point is far from the open coast.",
  NON_US: "Only US locations are supported.",
  GEOCODE_FAILED: "Could not geocode the query and no beach matched by name.",
};

function warn(
  code: WarningCode,
  severity: Warning["severity"],
  message?: string,
): Warning {
  return { code, severity, message: message ?? WARN_MESSAGES[code] };
}

// --- candidate helpers ------------------------------------------------------

/** Build a user-facing candidate from a beach + a reference point. */
function beachCandidate(b: BeachEntry, refLat: number, refLon: number): Candidate {
  return {
    name: b.name,
    lat: b.lat,
    lon: b.lon,
    state: b.state,
    distanceMi: round(haversineMiles(refLat, refLon, b.lat, b.lon), 2),
    bearingDeg: round(bearingDeg(refLat, refLon, b.lat, b.lon), 0),
    source: b.source,
  };
}

/** Build a candidate for a geocoded city (no registry source — treated as GNIS-ish "place"). */
function cityCandidate(g: GeoPoint, refLat: number, refLon: number): Candidate {
  return {
    name: g.name,
    lat: g.lat,
    lon: g.lon,
    state: g.admin1Code,
    distanceMi: round(haversineMiles(refLat, refLon, g.lat, g.lon), 2),
    bearingDeg: round(bearingDeg(refLat, refLon, g.lat, g.lon), 0),
    source: "GNIS",
  };
}

/** Empty result scaffold carrying the query + accumulated warnings. */
function rejected(query: string, warnings: Warning[]): ResolveResult {
  return { query, status: "rejected", candidates: [], warnings };
}

function pickList(
  query: string,
  candidates: Candidate[],
  warnings: Warning[],
): ResolveResult {
  return { query, status: "pick-list", candidates, warnings };
}

// --- safe-degrade wrapper ---------------------------------------------------

/**
 * Run an async resolver step so it can never throw: on rejection it logs a
 * warning and yields `null`. Mirrors the "sources never throw" contract.
 */
async function safe<T>(
  fn: () => Promise<T>,
  onError: (e: unknown) => Warning,
  warnings: Warning[],
): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    warnings.push(onError(e));
    return null;
  }
}

// --- city-origin disambiguation ---------------------------------------------

/**
 * From the geocoder hits choose a single US city origin, or signal a pick-list.
 * - non-US top hit -> reject NON_US
 * - empty -> caller handles GEOCODE_FAILED
 * - multiple US cities in *different states* with no clear population winner ->
 *   pick-list (AMBIGUOUS_CITY)
 */
function chooseCityOrigin(
  geo: GeoPoint[],
): { origin: GeoPoint } | { ambiguous: GeoPoint[] } | { nonUs: true } | null {
  if (geo.length === 0) return null;

  // The geocoder is US-only filtered, but be defensive: a non-US top hit rejects.
  const top = geo[0];
  if (top.countryCode !== "US") return { nonUs: true };

  const usCities = geo.filter((g) => g.countryCode === "US");
  if (usCities.length === 1) return { origin: usCities[0] };

  // Group by state. If the top two share a state, the top is fine.
  const states = new Set(usCities.map((g) => g.admin1Code ?? g.admin1 ?? "?"));
  if (states.size <= 1) return { origin: usCities[0] };

  // Different states: a clear population winner (>= 2x the runner-up) auto-picks.
  const byPop = [...usCities].sort((a, b) => (b.population ?? 0) - (a.population ?? 0));
  const topPop = byPop[0].population ?? 0;
  const runnerPop = byPop[1].population ?? 0;
  if (topPop > 0 && topPop >= runnerPop * 2) return { origin: byPop[0] };

  return { ambiguous: usCities };
}

// --- chosen-beach selection -------------------------------------------------

interface ChosenBeach {
  beach: BeachEntry;
  /** Distance from the city origin, if the beach was selected via a city centroid. */
  distanceMi?: number;
}

/**
 * From an already-ranked list of nearby beaches, auto-pick when there is one
 * obvious choice (a single beach, the centroid sitting on its own beach, or a
 * clear nearest winner), honoring `opts.pick`; otherwise return the pick-list.
 */
function chooseBeachFromNear(
  near: RankedBeach[],
  opts: ResolveOptions,
): { chosen: ChosenBeach } | { candidates: RankedBeach[] } {
  if (opts.pick !== undefined) {
    const picked = near[opts.pick];
    if (picked) return { chosen: { beach: picked, distanceMi: picked.distanceMi } };
  }

  if (near.length === 1) {
    return { chosen: { beach: near[0], distanceMi: near[0].distanceMi } };
  }

  // The centroid is on its own beachfront -> the nearest beach is the city's beach.
  const ownBeach = near[0].distanceMi <= CITY_OWN_BEACH_MILES;
  const clearWinner = near[1].distanceMi - near[0].distanceMi >= BEACH_TIE_MILES;
  if (ownBeach || clearWinner) {
    return { chosen: { beach: near[0], distanceMi: near[0].distanceMi } };
  }

  return { candidates: near };
}

/** Distance (statute mi) to the nearest NOAA tide station, or null when none. */
function nearestTideMi(reg: TideStation[], lat: number, lon: number): number | null {
  const n = nearestTideStations(reg, lat, lon, 1);
  return n.length ? n[0].distanceMi : null;
}

// --- field builders ---------------------------------------------------------

function field<T>(
  value: T | null,
  source: ResolvedField<T>["source"],
  confidence: Confidence,
  extra?: { distanceMi?: number; note?: string },
): ResolvedField<T> {
  const f: ResolvedField<T> = { value, source, confidence };
  if (extra?.distanceMi !== undefined) f.distanceMi = extra.distanceMi;
  if (extra?.note !== undefined) f.note = extra.note;
  return f;
}

// --- main entry -------------------------------------------------------------

/**
 * Resolve a free-text query to a curated-fields-blank `Location` (plus provenance
 * + warnings), or to a pick-list / rejection. Never throws.
 */
export async function resolveBeach(
  query: string,
  opts: ResolveOptions = {},
  deps: ResolveDeps = DEFAULT_DEPS,
): Promise<ResolveResult> {
  const warnings: Warning[] = [];
  const reg = deps.loadBeachRegistry();
  const tideReg = deps.loadTideStations();

  // 1) geocode + beach-name match concurrently.
  const [geo, nameMatches] = await Promise.all([
    safe(() => deps.geocodeName(query), () => warn("GEOCODE_FAILED", "info"), warnings).then(
      (g) => g ?? [],
    ),
    Promise.resolve(matchBeachByName(reg, query)),
  ]);

  // 2) Decide the chosen beach point + the geocode point used for tz/region.
  let chosenBeach: BeachEntry;
  let originGeo: GeoPoint | undefined;
  let beachDistanceMi: number | undefined;
  let beachConfidence: Confidence = "high";

  const maxMiles = opts.maxBeachMiles ?? DEFAULT_MAX_BEACH_MILES;
  const strongNameMatch = pickStrongBeachMatch(nameMatches, geo, maxMiles);

  if (strongNameMatch) {
    // 2a) Strong beach-name match -> that beach IS the chosen point.
    chosenBeach = strongNameMatch;
    // If the geocoder also returned a US city, use it as the tz/region origin.
    originGeo = geo.find((g) => g.countryCode === "US" && g.kind === "city");
    if (nameMatches.length > 1) {
      // Multiple same-named beaches existed; we chose one — note the collision.
      warnings.push(warn("BEACH_NAME_COLLISION", "info"));
    }
  } else {
    // 2b) City path: choose a US city origin from the geocode.
    const cityChoice = chooseCityOrigin(geo);
    if (cityChoice === null) {
      // No geocode AND no beach match -> reject.
      return rejected(query, [...warnings, warn("GEOCODE_FAILED", "blocker")]);
    }
    if ("nonUs" in cityChoice) {
      return rejected(query, [...warnings, warn("NON_US", "blocker")]);
    }
    if ("ambiguous" in cityChoice) {
      const cands = cityChoice.ambiguous.map((g) =>
        cityCandidate(g, cityChoice.ambiguous[0].lat, cityChoice.ambiguous[0].lon),
      );
      return pickList(query, cands, [...warnings, warn("AMBIGUOUS_CITY", "warn")]);
    }

    originGeo = cityChoice.origin;

    // 3) Choose the beach point for this city. Priority:
    //    a) a named beach right at the town (<= NEAR_NAMED_BEACH_MI) -> use it
    //       (auto-pick the obvious one, else a pick-list);
    //    b) else, if the town itself is on the coast (a tide station is within
    //       COASTAL_ANCHOR_MI), use the town's OWN coastal point — this is what
    //       makes Boca Raton / Cocoa Beach resolve to themselves even though GNIS
    //       has no "Beach" feature there;
    //    c) else, a named beach exists but is a ways off -> let the user pick;
    //    d) else nothing coastal in range -> reject.
    const near = nearestBeaches(reg, {
      lat: originGeo.lat,
      lon: originGeo.lon,
      limit: 5,
      maxMiles,
    });
    const tideMi = nearestTideMi(tideReg, originGeo.lat, originGeo.lon);
    const anchorCoastal = tideMi !== null && tideMi <= COASTAL_ANCHOR_MI;

    if (near.length > 0 && near[0].distanceMi <= NEAR_NAMED_BEACH_MI) {
      const beachChoice = chooseBeachFromNear(near, opts);
      if ("candidates" in beachChoice) {
        const cands = beachChoice.candidates.map((b) =>
          beachCandidate(b, originGeo!.lat, originGeo!.lon),
        );
        return pickList(query, cands, [...warnings, warn("BEACH_NAME_COLLISION", "warn")]);
      }
      chosenBeach = beachChoice.chosen.beach;
      beachDistanceMi = beachChoice.chosen.distanceMi;
      beachConfidence = "medium";
    } else if (anchorCoastal) {
      // The town is its own beachfront — synthesize a beach point at the centroid.
      chosenBeach = {
        name: originGeo.name,
        lat: originGeo.lat,
        lon: originGeo.lon,
        state: originGeo.admin1Code ?? "",
        source: "GNIS",
        coastalConfirmed: true,
      };
      beachDistanceMi = 0;
      beachConfidence = "medium";
    } else if (near.length > 0) {
      const cands = near.map((b) => beachCandidate(b, originGeo!.lat, originGeo!.lon));
      return pickList(query, cands, [...warnings, warn("BEACH_NAME_COLLISION", "warn")]);
    } else {
      return rejected(query, [...warnings, warn("COASTAL_GATE_FAIL", "blocker")]);
    }
  }

  // 4) Coastal gate from the chosen beach point.
  const gateOrigin = {
    lat: chosenBeach.lat,
    lon: chosenBeach.lon,
    countryCode: originGeo?.countryCode ?? "US",
  };
  // Nearest *other* coastal beach distance for the gate; the chosen point itself
  // is at distance 0 when it is in the registry, so the gate trivially passes for
  // a real coast-confirmed beach but still rejects inland false-positives.
  const nearestForGate = chosenBeach.coastalConfirmed === false
    ? null
    : nearestCoastalMi(reg, chosenBeach);
  const gate = coastalGate(gateOrigin, nearestForGate, opts.maxBeachMiles ?? DEFAULT_MAX_BEACH_MILES);
  if (!gate.ok) {
    const code = gate.reason ?? "COASTAL_GATE_FAIL";
    return rejected(query, [...warnings, warn(code, "blocker")]);
  }

  // 5) Resolve the data-driven fields concurrently, each safe-degrading.
  const buoyReg = deps.loadBuoyStations();
  const placeForSurf = surfPlaceHint(originGeo, chosenBeach);

  const [tides, buoys, surf, tz] = await Promise.all([
    safe(
      () => Promise.resolve(nearestTideStations(tideReg, chosenBeach.lat, chosenBeach.lon, 2)),
      () => warn("NO_TIDE_IN_RANGE", "warn"),
      warnings,
    ),
    safe(
      () => Promise.resolve(nearestBuoys(buoyReg, chosenBeach.lat, chosenBeach.lon)),
      () => warn("NO_BUOY_IN_RANGE", "warn"),
      warnings,
    ),
    safe(
      () => deps.resolveSurfZone(chosenBeach.lat, chosenBeach.lon, placeForSurf),
      () => warn("SURF_ZONE_UNCERTAIN", "warn"),
      warnings,
    ),
    safe(
      () => resolveTzForChosen(originGeo, chosenBeach, deps),
      () => warn("GEOCODE_FAILED", "info"),
      warnings,
    ),
  ]);

  // Tide stations
  const tidePrimary = tides && tides.length > 0 ? tides[0] : null;
  const tideFallback = tides && tides.length > 1 ? tides[1] : null;
  if (!tidePrimary) warnings.push(warn("NO_TIDE_IN_RANGE", "warn"));

  // Buoys
  const buoyPrimary = buoys?.primary ?? null;
  const buoyFallback = buoys?.fallback ?? null;
  if (!buoyPrimary) warnings.push(warn("NO_BUOY_IN_RANGE", "warn"));

  // Surf zone
  const surfOffice = surf?.office;
  const surfName = surf?.name;
  const surfConfidence: Confidence = surf?.confidence ?? "low";
  if (!surfOffice) {
    warnings.push(warn("SURF_ZONE_UNCERTAIN", "warn", "Could not resolve an NWS office for the point."));
  } else if (surfConfidence !== "high" || !surfName) {
    warnings.push(warn("SURF_ZONE_UNCERTAIN", "info", surf?.note));
  }

  // Timezone
  const tzValue = tz?.timezone ?? null;
  const tzConfidence: Confidence = tz?.confidence ?? "low";

  // 6) Build the Location + provenance.
  // Prefer the geocoded city display name (e.g. "Boca Raton") over a raw beach
  // feature name (e.g. "Red Reef Park") so the town reads naturally.
  const displayName = originGeo?.name ?? chosenBeach.name;
  const region = buildRegion(originGeo, chosenBeach);
  const taken = opts.takenSlugs ?? listLocations().map((l) => l.slug);
  const slug = uniqueSlug(displayName, taken, originGeo?.admin1Code ?? chosenBeach.state);

  const location: Location = {
    slug,
    name: displayName,
    region,
    lat: chosenBeach.lat,
    lon: chosenBeach.lon,
    timezone: tzValue ?? "",
    noaaTideStationId: tidePrimary?.id ?? "",
    ndbcBuoyId: buoyPrimary?.id ?? "",
    cams: [],
  };
  if (tideFallback) location.noaaTideStationFallbackId = tideFallback.id;
  if (buoyFallback) location.ndbcBuoyFallbackId = buoyFallback.id;
  if (surfOffice && surfName) location.surfZone = { office: surfOffice, name: surfName };
  // Curated fields (cams already [], cityConditionsUrl, healthyBeaches) left undefined.

  const provenance: Provenance = {
    lat: field(chosenBeach.lat, "beach-registry", beachConfidence, { distanceMi: beachDistanceMi }),
    lon: field(chosenBeach.lon, "beach-registry", beachConfidence, { distanceMi: beachDistanceMi }),
    timezone: field(tzValue, "geocode", tzConfidence),
    noaaTideStationId: field(
      tidePrimary?.id ?? null,
      "tide-registry",
      tidePrimary ? "high" : "low",
      { distanceMi: tidePrimary?.distanceMi },
    ),
    ndbcBuoyId: field(
      buoyPrimary?.id ?? null,
      "buoy-registry",
      buoyPrimary ? "high" : "low",
      { distanceMi: buoyPrimary?.distanceMi },
    ),
    surfZone: field(
      surfOffice && surfName ? { office: surfOffice, name: surfName } : null,
      "nws-srf",
      surfOffice ? surfConfidence : "low",
      { note: surf?.note },
    ),
  };

  const chosen: ResolveResult["chosen"] = {
    name: chosenBeach.name,
    lat: chosenBeach.lat,
    lon: chosenBeach.lon,
    state: chosenBeach.state,
    distanceMi: beachDistanceMi ?? 0,
    bearingDeg: originGeo
      ? round(bearingDeg(originGeo.lat, originGeo.lon, chosenBeach.lat, chosenBeach.lon), 0)
      : 0,
    source: chosenBeach.source,
    geocodeName: originGeo?.name,
  };

  return {
    query,
    status: "resolved",
    candidates: [],
    chosen,
    location,
    provenance,
    warnings,
  };
}

// --- private helpers --------------------------------------------------------

/**
 * Decide whether the beach-name matches are "strong" enough to make a beach the
 * chosen point (rather than going through a city centroid). A single match is
 * strong. Multiple matches are strong only when the nearest to the top geocode
 * clearly beats the rest; otherwise we let the caller fall through to the city
 * path / pick-list. When there is no geocode at all, the first match wins.
 */
function pickStrongBeachMatch(
  matches: BeachEntry[],
  geo: GeoPoint[],
  maxMiles: number,
): BeachEntry | null {
  if (matches.length === 0) return null;

  const ref = geo.find((g) => g.countryCode === "US") ?? geo[0];
  // No geocode anchor to validate against -> only trust a single, unambiguous match.
  if (!ref) return matches.length === 1 ? matches[0] : null;

  const ranked = [...matches]
    .map((b) => ({ b, d: haversineMiles(ref.lat, ref.lon, b.lat, b.lon) }))
    .sort((a, b) => a.d - b.d);
  // A same-named beach far from where the query geocoded is NOT what the user
  // meant (e.g. "Miami" must not match "Miami Beach, NJ"). Require proximity.
  if (ranked[0].d > maxMiles) return null;
  if (ranked.length === 1) return ranked[0].b;
  // Strong only when the nearest clearly beats the runner-up (or it's out of range).
  if (ranked[1].d - ranked[0].d >= STRONG_BEACH_GAP_MILES || ranked[1].d > maxMiles) {
    return ranked[0].b;
  }
  return null;
}

/** Nearest coast-confirmed beach (statute mi) to a chosen beach, for the gate. 0 when it is itself coastal. */
function nearestCoastalMi(reg: BeachEntry[], chosen: BeachEntry): number | null {
  if (chosen.coastalConfirmed !== false) return 0;
  const near = nearestBeaches(reg, { lat: chosen.lat, lon: chosen.lon, limit: 1 });
  return near.length ? near[0].distanceMi : null;
}

/** A place hint for the SRF name match: prefer the county/city display, then the beach name. */
function surfPlaceHint(geo: GeoPoint | undefined, beach: BeachEntry): string | undefined {
  return geo?.name ?? beach.name;
}

/** Build "<County> County, <ST>" when the geocoder supplies a county, else "<State>, <ST>". */
function buildRegion(geo: GeoPoint | undefined, beach: BeachEntry): string {
  const state = geo?.admin1Code ?? beach.state;
  if (geo?.admin2 && state) return `${geo.admin2} County, ${state}`;
  const area = geo?.admin1;
  if (area && state && area !== state) return `${area}, ${state}`;
  return state ?? area ?? "";
}

/**
 * Resolve the timezone for the chosen point. Uses the city geocode tz when
 * present; for a beach-name-only match without a geocode, tries geocoding the
 * beach's own name (best-effort) before degrading to low confidence.
 */
async function resolveTzForChosen(
  geo: GeoPoint | undefined,
  beach: BeachEntry,
  deps: ResolveDeps,
): Promise<{ timezone?: string; confidence: Confidence }> {
  if (geo) return resolveTimezone(geo);
  // Beach-name-only path: attempt a geocode of the beach name for its tz.
  const hits = await deps.geocodeName(beach.name).catch(() => [] as GeoPoint[]);
  const us = hits.find((g) => g.countryCode === "US" && g.timezone);
  if (us) return resolveTimezone(us);
  return { timezone: undefined, confidence: "low" };
}

