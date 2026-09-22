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

/** Does this NDBC station report significant wave height? Keyed by station id,
 *  UPPERCASE (see reportsWaves() below) — config/locations.generated.json
 *  spells its 36 admin-added "auto" beaches' ids lowercase (e.g. "ppta1"), so
 *  lookup normalizes both spellings to one case instead of duplicating keys. */
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

  // --- 2026-09-22 classification of the 36 admin-added ("tier: auto") beaches
  // in config/locations.generated.json, probed live via scripts/ndbc_classify.mjs
  // against https://www.ndbc.noaa.gov/data/realtime2/<ID>.txt. Comments give the
  // station's NDBC name and what it reports.

  // Moored/nearshore wave buoys (5-digit numeric ids) — all confirmed reporting
  // WVHT live on 2026-09-22.
  "41067": true, // FRP2WAVE — nearshore wave buoy
  "41070": true, // Ponce de Leon Inlet Waves (PNCWAVE) — nearshore wave buoy
  "41076": true, // CHR60WAVE — nearshore wave buoy
  "41110": true, // Masonboro Inlet, NC (150) — nearshore wave buoy
  "41112": true, // Offshore Fernandina Beach, FL (132) — wave buoy
  "41113": true, // Cape Canaveral Nearshore, FL (143) — wave buoy
  "42012": true, // Orange Beach, AL — 44 NM SE of Mobile, AL — wave buoy
  "42035": true, // Galveston, TX — 22 NM East of Galveston, TX — wave buoy
  "42084": true, // Southwest Pass Entrance W, LA (256) — nearshore wave buoy
  "42092": true, // Aransas Pass Channel Entrance S, TX (252), Waverider buoy —
  // nearest live wave reporter to South Padre Island (~111 mi); see task 2.
  "42357": true, // DISL Sofar Spotter — wave buoy
  "44007": true, // Portland, ME — 12 NM SE of Portland, ME — wave buoy
  "44025": true, // Long Island, NY — 30 NM South of Islip, NY — wave buoy
  "44065": true, // New York Harbor Entrance, NY — wave buoy
  "44084": true, // Bethany Beach, DE (263) — nearshore wave buoy
  "44085": true, // Buzzards Bay, MA (260) — nearshore wave buoy
  "44086": true, // Nags Head, NC (243) — nearshore wave buoy
  "44097": true, // Block Island, RI (154) — nearshore wave buoy
  "44098": true, // Jeffrey's Ledge, NH (160) — nearshore wave buoy
  "44099": true, // Cape Henry, VA (147) — nearshore wave buoy
  "46042": true, // Monterey, CA — 27NM WNW of Monterey, CA — wave buoy
  "46211": true, // Grays Harbor, WA (036) — nearshore wave buoy
  "46215": true, // Diablo Canyon, CA (076) — nearshore wave buoy
  "46236": true, // Monterey Canyon Outer, CA (156) — nearshore wave buoy
  "46243": true, // Clatsop Spit, OR (162) — nearshore wave buoy
  "46253": true, // San Pedro South, CA (213) — nearshore wave buoy
  "46256": true, // Long Beach Channel, CA (215) — nearshore wave buoy
  "46268": true, // Topanga Nearshore, CA (103) — wave buoy
  "46278": true, // Tillamook Bay South Jetty, OR (270) — nearshore wave buoy
  "51211": true, // Pearl Harbor Entrance, HI (233) — nearshore wave buoy

  // One numeric buoy that does NOT report waves (tide/met only despite the
  // numeric id — confirms the "rule of thumb" is a starting point, not a rule).
  "41069": false, // Ponce de Leon Inlet, FL (PNC) — tide/met station, no wave sensor

  // Alphanumeric C-MAN / tide-gauge / pier stations — all confirmed WVHT "MM"
  // on 2026-09-22 (no wave sensor), except LJPC1 and SSBN7 below.
  BGXN3: false, // Great Bay Reserve, NH — tide/met station
  BZST2: false, // 8779749 SPI Brazos Santiago, TX — tide gauge (South Padre primary)
  CASM1: false, // 8418150 Portland, ME — tide gauge
  CHTS1: false, // 8665530 Charleston, Cooper River Entrance, SC — tide gauge
  CHYV2: false, // 8638999 Cape Henry, VA — tide gauge
  CMAN4: false, // 8536110 Cape May, NJ — tide gauge
  CPXC1: false, // Cal Poly Pier, CA — met station, no wave sensor
  FPKG1: false, // 8670870 Fort Pulaski, GA — tide gauge
  GISL1: false, // 8761724 Grand Isle, LA — tide gauge
  GTOT2: false, // 8771450 Galveston Pier 21, TX — tide gauge
  ICAC1: false, // 9410840 Santa Monica Pier, CA — tide gauge
  JMPN7: false, // 8658163 Wrightsville Beach, NC — tide gauge
  LJAC1: false, // 9410230 La Jolla, CA — tide gauge
  LJPC1: true, // La Jolla, CA (073) — nearshore wave buoy (reports live)
  LWSD1: false, // 8557380 Lewes, DE — tide gauge
  MEYC1: false, // 9413450 Monterey, CA — tide gauge
  MROS1: false, // 8661070 Springmaid Pier, SC — tide gauge
  MTKN6: false, // 8510560 Montauk, NY — tide gauge
  MYPF1: false, // 8720218 Mayport (Bar Pilots Dock), FL — tide gauge
  NLHC3: false, // 8461490 New London, CT — tide gauge
  NWHC3: false, // 8465705 New Haven, CT — tide gauge
  OHBC1: false, // 9410660 Los Angeles, CA — tide gauge
  OOUH1: false, // 1612340 Honolulu, HI — tide gauge
  ORIN7: false, // 8652587 Oregon Inlet Marina, NC — tide gauge
  PNLM6: false, // 8741533 Pascagoula NOAA Lab, MS — tide gauge
  PPTA1: false, // Perdido Pass, AL — met/tide station, no wave sensor
  RKXF1: false, // Upper Henderson Creek, Rookery Bay Reserve, FL — met station
  ROBN4: false, // 8530973 Robbins Reef, NJ — tide gauge
  SDHN4: false, // 8531680 Sandy Hook, NJ — tide gauge
  SSBN7: true, // Sunset Beach Nearshore Waves (SUN2WAVE) — wave buoy (reports live)
  TRDF1: false, // 8721604 Trident Pier, FL — tide gauge
  VAKF1: false, // 8723214 Virginia Key, FL — tide gauge
  WPTW1: false, // 9441102 Westport, WA — tide gauge
};

/** True if the station reports waves, false if it does not, undefined if it has
 *  not been classified in NDBC_STATION_REPORTS_WAVES. Undefined is a hard error
 *  for the coverage check — classify the station before shipping it. Station ids
 *  are normalized to uppercase so config/locations.generated.json's lowercase
 *  ids (e.g. "ppta1") resolve to the same entry as a hand-typed uppercase one. */
export function reportsWaves(stationId: string): boolean | undefined {
  return NDBC_STATION_REPORTS_WAVES[stationId.toUpperCase()];
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
