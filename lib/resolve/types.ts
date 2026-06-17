// Type contract for the location resolver: given a free-text beach/city query,
// it geocodes, picks nearest registry stations, derives surf-zone config, and
// emits a curated-fields-blank `Location` plus provenance + warnings.
//
// Pure types only — no logic. The resolver fills the data-driven fields of
// `Location`; curated fields (cams, cityConditionsUrl, healthyBeaches) are left
// empty/undefined for a human to fill in later.

import type { Location } from "@/lib/types";

/** A geocoded city/place candidate from the geocoder (e.g. Open-Meteo / GeoNames). */
export interface GeoPoint {
  name: string;
  lat: number;
  lon: number;
  /** Admin level 1 display name (e.g. "Florida"). */
  admin1?: string;
  /** Admin level 1 code (e.g. "FL"). */
  admin1Code?: string;
  /** Admin level 2 display name (the county, e.g. "Palm Beach"). */
  admin2?: string;
  /** ISO country code (e.g. "US"). */
  countryCode: string;
  /** IANA timezone, e.g. "America/New_York". */
  timezone?: string;
  population?: number;
  /** GeoNames feature code, e.g. "PPL" (populated place). */
  featureCode?: string;
  kind: "city" | "place";
}

/** A named beach from the beach registry (GNIS export or OSM). */
export interface BeachEntry {
  name: string;
  lat: number;
  lon: number;
  /** Two-letter US state, e.g. "FL". */
  state: string;
  source: "GNIS" | "OSM";
  /** GNIS feature class, e.g. "Beach". */
  gnisClass?: string;
  /** True once the point has passed the coastal gate (near open ocean, not a lake). */
  coastalConfirmed?: boolean;
}

/** A NOAA CO-OPS tide-prediction station. */
export interface TideStation {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** Two-letter US state, when known. */
  state?: string;
}

/** An NDBC buoy / C-MAN station with capability flags. */
export interface BuoyStation {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** Reports wave height/period. */
  hasWaves?: boolean;
  /** Reports water temperature. */
  hasWaterTemp?: boolean;
}

/** Where a resolved field's value came from. */
export type FieldSource =
  | "geocode"
  | "beach-registry"
  | "tide-registry"
  | "buoy-registry"
  | "nws-points"
  | "nws-srf"
  | "owner-todo"
  | "derived";

/** How much to trust a resolved field. */
export type Confidence = "high" | "medium" | "low";

/** A single resolved `Location` field, with its source, confidence, and provenance. */
export interface ResolvedField<T> {
  value: T | null;
  source: FieldSource;
  confidence: Confidence;
  /** Distance (statute miles) from the chosen beach point, for registry hits. */
  distanceMi?: number;
  note?: string;
}

/** A geocode/beach candidate offered to the user when the query is ambiguous. */
export interface Candidate {
  name: string;
  lat: number;
  lon: number;
  /** Two-letter US state, when known. */
  state?: string;
  /** Distance (statute miles) from the query reference point. */
  distanceMi: number;
  /** Compass bearing (deg, 0=N, 90=E) from the query reference point. */
  bearingDeg: number;
  source: "GNIS" | "OSM";
}

/** Machine-readable warning codes raised during resolution. */
export type WarningCode =
  | "AMBIGUOUS_CITY"
  | "BEACH_NAME_COLLISION"
  | "NO_TIDE_IN_RANGE"
  | "NO_BUOY_IN_RANGE"
  | "SURF_ZONE_UNCERTAIN"
  | "COASTAL_GATE_FAIL"
  | "INLAND_BEACH_SUSPECT"
  | "NON_US"
  | "GEOCODE_FAILED";

/** A resolution warning. `blocker` rejects the result; `warn`/`info` are advisory. */
export interface Warning {
  code: WarningCode;
  message: string;
  severity: "blocker" | "warn" | "info";
}

/** Per-field provenance for the data-driven parts of the resolved `Location`. */
export interface Provenance {
  lat: ResolvedField<number>;
  lon: ResolvedField<number>;
  timezone: ResolvedField<string>;
  noaaTideStationId: ResolvedField<string>;
  ndbcBuoyId: ResolvedField<string>;
  surfZone: ResolvedField<{ office: string; name: string }>;
}

/** Top-level resolver output. */
export interface ResolveResult {
  query: string;
  /** `resolved` = a single Location; `pick-list` = ambiguous; `rejected` = blocked. */
  status: "resolved" | "pick-list" | "rejected";
  candidates: Candidate[];
  /** The chosen candidate, when resolved (plus the geocoder's display name). */
  chosen?: Candidate & { geocodeName?: string };
  /** The resolved Location (curated fields left empty/undefined), when resolved. */
  location?: Location;
  provenance?: Provenance;
  warnings: Warning[];
}

/** Metadata describing a built registry snapshot. */
export interface RegistryMeta {
  /** ISO build timestamp. */
  builtAt: string;
  /** Row counts keyed by registry name. */
  counts: Record<string, number>;
  /** Upstream source identifiers used to build the snapshot. */
  sources: string[];
  version: number;
}
