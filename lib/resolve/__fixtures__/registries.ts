// Small, realistic registry fixtures shared across resolver module tests.
//
// Coordinates are chosen so that nearest-neighbor selection from the real Boca
// Raton beach point (lat 26.3587, lon -80.0686) reproduces the hand-written
// Boca config in config/locations.ts:
//   - tide primary 8722816 (Boca Raton), fallback 8722670 (Lake Worth Pier)
//   - buoy primary LKWF1 (water-temp, NO waves), wave fallback FWYF1 (Fowey Rocks)
// Verified distances from the Boca beach point:
//   tides:  8722816 ~0.26mi, 8722670 ~17.7mi, 8723214 ~43.7mi, 9410230 ~2262mi (CA)
//   buoys:  LKWF1 ~17.7mi (no waves), FWYF1 ~53.1mi (waves), 41114 ~82.8mi, 46221 (CA)

import type { BeachEntry, BuoyStation, GeoPoint, TideStation } from "@/lib/resolve/types";

/** Reference beach point used across tests: real Boca Raton (Red Reef Park). */
export const BOCA_BEACH = { lat: 26.3587, lon: -80.0686 } as const;

/**
 * NOAA tide stations. Nearest to the Boca beach point is 8722816 (Boca Raton);
 * second nearest is 8722670 (Lake Worth Pier) — matching the Boca fallback. The
 * CA station (9410230) is a far-away decoy that must never be selected.
 */
export const TIDE_FIXTURE: TideStation[] = [
  { id: "8722816", name: "Boca Raton", lat: 26.3557, lon: -80.0712, state: "FL" },
  { id: "8722670", name: "Lake Worth Pier", lat: 26.6128, lon: -80.0342, state: "FL" },
  { id: "8723214", name: "Virginia Key", lat: 25.7314, lon: -80.162, state: "FL" },
  { id: "9410230", name: "La Jolla", lat: 32.8669, lon: -117.2571, state: "CA" },
];

/**
 * NDBC buoy / C-MAN stations. Nearest to the Boca beach point is LKWF1, but it
 * reports no waves — so a wave-capable selection must skip it and pick FWYF1
 * (Fowey Rocks), matching the Boca buoy fallback. The CA buoy (46221) is a decoy.
 */
export const BUOY_FIXTURE: BuoyStation[] = [
  { id: "LKWF1", name: "Lake Worth Pier", lat: 26.6128, lon: -80.0342, hasWaves: false, hasWaterTemp: true },
  { id: "FWYF1", name: "Fowey Rocks", lat: 25.5904, lon: -80.0996, hasWaves: true, hasWaterTemp: true },
  { id: "41114", name: "Fort Pierce", lat: 27.55, lon: -80.22, hasWaves: true, hasWaterTemp: true },
  { id: "46221", name: "Santa Monica Bay", lat: 33.855, lon: -118.633, hasWaves: true, hasWaterTemp: true },
];

/**
 * Beach registry. Includes the Boca beach point itself (Red Reef Park), a nearby
 * Boca beach, a couple of other-FL coastal beaches, a west-coast (CA) beach, and
 * one inland false-positive (a Minnesota lake "beach") with coastalConfirmed:false
 * to exercise the coastal gate / INLAND_BEACH_SUSPECT path.
 */
export const BEACH_FIXTURE: BeachEntry[] = [
  { name: "Red Reef Park", lat: 26.3587, lon: -80.0686, state: "FL", source: "GNIS", gnisClass: "Beach", coastalConfirmed: true },
  { name: "South Beach Park", lat: 26.3456, lon: -80.0701, state: "FL", source: "GNIS", gnisClass: "Beach", coastalConfirmed: true },
  { name: "South Beach", lat: 25.7826, lon: -80.13, state: "FL", source: "GNIS", gnisClass: "Beach", coastalConfirmed: true },
  { name: "Fort Lauderdale Beach", lat: 26.1413, lon: -80.1048, state: "FL", source: "OSM", coastalConfirmed: true },
  { name: "Santa Monica State Beach", lat: 34.0094, lon: -118.4973, state: "CA", source: "GNIS", gnisClass: "Beach", coastalConfirmed: true },
  // Inland false-positive: a lake "beach" in MN — fails the coastal gate.
  { name: "Lake Calhoun Beach", lat: 44.9483, lon: -93.3105, state: "MN", source: "GNIS", gnisClass: "Beach", coastalConfirmed: false },
];

/** Geocoder result for "Boca Raton" (city centroid). */
export const GEOCODE_BOCA: GeoPoint = {
  name: "Boca Raton",
  lat: 26.35869,
  lon: -80.0831,
  admin1: "Florida",
  admin1Code: "FL",
  countryCode: "US",
  timezone: "America/New_York",
  population: 93235,
  featureCode: "PPL",
  kind: "city",
};

/**
 * Realistic excerpt of an NWS Miami (MFL) Surf Zone Forecast (SRF) product,
 * with `$$`-delimited zone blocks. The "Coastal Palm Beach County" block contains
 * "Palm Beach" (so it matches the Boca surfZone name "Palm Beach") and a
 * "Rip Current Risk...MODERATE" line in the exact shape lib/sources/nws.ts
 * parseRipRisk() consumes: /Rip Current Risk[\s*.:]*\b(Low|Moderate|High)\b/i,
 * within a `$$`-split segment that also matches the zone name.
 */
export const SRF_MFL_FIXTURE = `
000
SRFMFL

Surf Zone Forecast for Southeast Florida
National Weather Service Miami FL
400 AM EDT Sun Jun 15 2026

FLZ168-152100-
Coastal Palm Beach County-
400 AM EDT Sun Jun 15 2026

.TODAY...
Surf height 2 to 3 feet.
Water temperature 82 degrees.

Rip Current Risk...MODERATE. A moderate risk of rip currents.

.TONIGHT...
Surf height 1 to 2 feet.

$$

FLZ172-152100-
Coastal Broward County-
400 AM EDT Sun Jun 15 2026

.TODAY...
Surf height 1 to 2 feet.
Water temperature 83 degrees.

Rip Current Risk...LOW. A low risk of rip currents.

.TONIGHT...
Surf height 1 to 2 feet.

$$

FLZ173-152100-
Coastal Miami-Dade County-
400 AM EDT Sun Jun 15 2026

.TODAY...
Surf height 2 to 4 feet.

Rip Current Risk...HIGH. A high risk of rip currents today.

.TONIGHT...
Surf height 2 to 3 feet.

$$
`;
