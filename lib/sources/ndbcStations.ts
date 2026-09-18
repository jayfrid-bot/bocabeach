// Whether each NDBC station we rely on actually reports significant wave height
// (the "WVHT" column of its realtime feed).
//
// WHY THIS EXISTS — the 2026-09-18 Boca bug: a beach whose buoy pair has NO
// wave-reporting station silently serves the Open-Meteo wave MODEL, which reads
// roughly 3x high right at the shore (Boca showed 3.1 ft model while the water
// was ~1.0 ft, because both configured stations — LKWF1 and the old FWYF1
// fallback — are wave-less C-MAN/light stations). The buoy merge in buoy.ts
// fills wave height only if a station in the pair reports it; otherwise the
// model wins by default and nothing warns you. This map + the coverage test
// (ndbcStations.test.ts) turn that silent config mistake into a CI failure.
//
// SOURCE OF TRUTH for each entry: the station's own page,
//   https://www.ndbc.noaa.gov/station_page.php?station=<ID>
// and its realtime feed, https://www.ndbc.noaa.gov/data/realtime2/<ID>.txt
// (the WVHT column is "MM" on every row for a station with no wave sensor).
//
// RULE OF THUMB when adding a station: a 5-digit numeric id (e.g. 41122) is a
// moored buoy and almost always reports WVHT; an alphanumeric id ending in a
// letter+digit (e.g. LKWF1, FWYF1) is a fixed C-MAN / light station and usually
// does NOT. Do not guess — open the feed and confirm, then record it here. Any
// station left out of this map fails the coverage test until it is classified.

/** Does this NDBC station report significant wave height? Keyed by station id
 *  exactly as it appears in config/locations.ts (case-sensitive). */
export const NDBC_STATION_REPORTS_WAVES: Record<string, boolean> = {
  // Nearshore Waverider off Hollywood/Dania (a.k.a. the Hillsboro–Dania buoy),
  // ~24 mi south of Boca. Reports WVHT live — the observed-wave source shared by
  // Boca (fallback), Deerfield, and Fort Lauderdale.
  "41122": true,
  // Lake Worth Pier C-MAN mast. Wind, pressure, air/water temp only — no wave
  // sensor, so WVHT is "MM" on 100% of ticks, structurally, forever.
  LKWF1: false,
  // Fowey Rocks light station. Wind/pressure/temp only, no wave sensor (and
  // frequently offline). Left classified so a future config that reaches for it
  // as a wave source still fails the coverage test.
  FWYF1: false,
};

/** True if the station reports waves, false if it does not, undefined if it has
 *  not been classified in NDBC_STATION_REPORTS_WAVES. Undefined is a hard error
 *  for the coverage check — classify the station before shipping it. */
export function reportsWaves(stationId: string): boolean | undefined {
  return NDBC_STATION_REPORTS_WAVES[stationId];
}

/** The subset of a Location this check needs. LOCATIONS (Location[]) satisfies
 *  it structurally, and tests can pass minimal fixtures. */
export interface BuoyConfigured {
  slug: string;
  ndbcBuoyId: string;
  ndbcBuoyFallbackId?: string;
}

export interface BuoyCoverageViolation {
  slug: string;
  /** `unclassified-station`: a configured station is missing from the map, so
   *  its wave capability is unknown. `no-wave-station`: every configured (and
   *  classified) station is wave-less, so this beach falls back to the model. */
  reason: "unclassified-station" | "no-wave-station";
  /** The station ids this beach is configured with, primary first. */
  stations: string[];
  /** Human-readable, points at the fix. */
  detail: string;
}

/** The configured buoy ids for a beach, primary first, fallback (if any) second. */
function stationsOf(loc: BuoyConfigured): string[] {
  return [loc.ndbcBuoyId, loc.ndbcBuoyFallbackId].filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
}

/**
 * Every beach whose buoy configuration cannot deliver an OBSERVED wave height.
 * An empty array means every beach is covered. Pure (no network, no clock) so
 * it runs in the CI gate deterministically; the live audit (ndbcStations.test.ts
 * under NDBC_LIVE_CHECK) is what verifies the map still matches reality.
 */
export function buoyCoverageViolations(
  locations: readonly BuoyConfigured[],
): BuoyCoverageViolation[] {
  const violations: BuoyCoverageViolation[] = [];
  for (const loc of locations) {
    const stations = stationsOf(loc);
    const unclassified = stations.filter((id) => reportsWaves(id) === undefined);
    if (unclassified.length > 0) {
      violations.push({
        slug: loc.slug,
        reason: "unclassified-station",
        stations,
        detail:
          `Station(s) ${unclassified.join(", ")} are not classified in ` +
          `NDBC_STATION_REPORTS_WAVES. Check ` +
          unclassified
            .map((id) => `https://www.ndbc.noaa.gov/station_page.php?station=${id}`)
            .join(" and ") +
          ` — does the realtime feed's WVHT column carry numbers or "MM"? — then record it.`,
      });
      continue; // can't judge wave coverage until every station is classified
    }
    if (!stations.some((id) => reportsWaves(id) === true)) {
      violations.push({
        slug: loc.slug,
        reason: "no-wave-station",
        stations,
        detail:
          `None of ${stations.join(", ")} reports wave height, so ${loc.slug} ` +
          `silently serves the Open-Meteo wave MODEL (reads ~3x high nearshore). ` +
          `Assign a wave-reporting buoy (a nearby 5-digit numeric station, e.g. 41122) ` +
          `as ndbcBuoyId or ndbcBuoyFallbackId.`,
      });
    }
  }
  return violations;
}
