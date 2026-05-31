// ---------------------------------------------------------------------------
// Shared domain types for Boca Beach Rats.
// Every data source normalizes its payload into one of the *Data shapes below
// and wraps it in `Wrapped<T>` so the UI gets a uniform { data, status } envelope.
// ---------------------------------------------------------------------------

export type SourceStatus = "ok" | "stale" | "error" | "best-effort";

export interface SourceMeta {
  /** Human-readable provider, e.g. "NOAA NDBC (LKWF1)". */
  source: string;
  status: SourceStatus;
  /** ISO timestamp of when we fetched it. */
  fetchedAt: string;
  /** Short credit line shown in the UI. */
  attribution: string;
  note?: string;
}

export interface Wrapped<T> extends SourceMeta {
  data: T | null;
}

// --- Tides (NOAA CO-OPS) ---------------------------------------------------
export interface TideEvent {
  type: "high" | "low";
  time: string; // ISO
  heightFt: number;
}
export interface TideData {
  /** Upcoming high/low events, soonest first. */
  next: TideEvent[];
  /** Whether the tide is currently rising or falling (derived from next events). */
  trend?: "rising" | "falling";
}

// --- Buoy (NOAA NDBC realtime2) -------------------------------------------
export interface BuoyData {
  waterTempF?: number;
  airTempF?: number;
  /** Wind direction the wind is coming FROM, in degrees. */
  windDirDeg?: number;
  windSpeedMph?: number;
  windGustMph?: number;
  waveHeightFt?: number;
  dominantPeriodS?: number;
  observedAt?: string; // ISO
}

// --- Weather (NWS api.weather.gov) ----------------------------------------
export interface WeatherData {
  airTempF?: number;
  windDirDeg?: number;
  windDirCardinal?: string;
  windSpeedMph?: number;
  shortForecast?: string; // "Mostly Sunny"
  precipProbability?: number; // 0-100
  isDaytime?: boolean;
  observedAt?: string; // ISO
}

// --- Marine (Open-Meteo) ---------------------------------------------------
export interface MarineData {
  waveHeightFt?: number;
  waveDirDeg?: number;
  wavePeriodS?: number;
  swellHeightFt?: number;
  swellPeriodS?: number;
  swellDirDeg?: number;
  seaSurfaceTempF?: number;
  uvIndex?: number;
}

// --- Official local conditions (City of Boca Raton Ocean Rescue scrape) -----
export type FlagColor =
  | "green"
  | "yellow"
  | "red"
  | "double-red"
  | "purple"
  | "unknown";

export interface CityOfficialData {
  /** Posted lifeguard flag(s); multiple can fly at once (e.g. yellow + purple). */
  flags: FlagColor[];
  swimmingRating?: string; // "Fair"
  snorkelingRating?: string;
  surfingRating?: string;
  marineLife?: string[]; // ["jellyfish", "seaweed"]
  hazards?: string[]; // ["rip currents", "shoreline drop-offs"]
  summary?: string; // short human-readable snippet
  updatedLabel?: string; // "Friday, May 29, 2026"
}

// --- Water quality (FL Healthy Beaches) ------------------------------------
export type WaterQualityRating = "good" | "moderate" | "poor" | "unknown";
export interface WaterQualitySite {
  name: string;
  rating: WaterQualityRating;
  enterococci?: number; // CFU / 100ml
  sampledAt?: string;
}
export interface WaterQualityData {
  overall: WaterQualityRating;
  advisory: boolean;
  sites: WaterQualitySite[];
}

// --- Per-spot weather (Open-Meteo current) --------------------------------
export interface SpotWeatherData {
  airTempF?: number;
  apparentTempF?: number;
  windSpeedMph?: number;
  windGustMph?: number;
  windDirDeg?: number;
  windDirCardinal?: string;
  humidity?: number; // %
  weatherCode?: number; // WMO code
  shortForecast?: string; // human-readable, derived from the WMO code
  observedAt?: string; // ISO
}

// --- Snapshot --------------------------------------------------------------
export interface ConditionsSnapshot {
  location: LocationPublic;
  generatedAt: string; // ISO
  tides: Wrapped<TideData>;
  buoy: Wrapped<BuoyData>;
  weather: Wrapped<WeatherData>;
  marine: Wrapped<MarineData>;
  cityOfficial: Wrapped<CityOfficialData>;
  waterQuality: Wrapped<WaterQualityData>;
}

// --- Scores ----------------------------------------------------------------
export interface SubScore {
  key: string;
  label: string;
  /** 0-100 sub-score, or null when the input was unavailable. */
  score: number | null;
  weight: number; // 0-1
  /** Human-readable value that produced this sub-score. */
  display?: string;
}
export interface ScoreResult {
  /** Final 0-100 score after safety caps. */
  score: number;
  /** Score before safety caps were applied. */
  rawScore: number;
  rating: string; // "Excellent" | "Good" | "Fair" | "Poor"
  subScores: SubScore[];
  /** Explanations for any safety cap that lowered the score. */
  caps: string[];
}

/** A cam plus the live weather/wind at its location (Open-Meteo, per spot). */
export interface CamView {
  /** Stable id (only set for cams with a proxied snapshot). */
  id?: string;
  name: string;
  provider: string;
  embedType: "iframe" | "image" | "link";
  url: string;
  /** Local proxy path for the live still (image cams only), e.g. /api/cam/boca-surf. */
  imageUrl?: string;
  attribution?: string;
  weather: Wrapped<SpotWeatherData>;
}

export interface ConditionsResponse {
  snapshot: ConditionsSnapshot;
  /** Single composite Beach Day score (0-100) with breakdown + safety caps. */
  score: ScoreResult;
  cams: CamView[];
}

// --- Location config -------------------------------------------------------
export interface CamConfig {
  /**
   * Stable id, required when `snapshotUrl` is set: it keys the /api/cam/[id]
   * proxy allowlist so only configured upstreams can be fetched (no SSRF).
   */
  id?: string;
  name: string;
  provider: string;
  /** How to render: inline iframe, an auto-refreshing still image, or a link out. */
  embedType: "iframe" | "image" | "link";
  /** Human-facing page (used for the link/click-through). */
  url: string;
  /**
   * Upstream live still-image URL, proxied server-side via /api/cam/[id] (so an
   * http-only or hotlink-sensitive source is served same-origin over https).
   * Only used when embedType is "image".
   */
  snapshotUrl?: string;
  attribution?: string;
  /** Cam's own coordinates for per-spot weather; falls back to the town's lat/lon. */
  lat?: number;
  lon?: number;
}

export interface Location {
  slug: string;
  name: string;
  region: string;
  lat: number;
  lon: number;
  timezone: string; // IANA, e.g. "America/New_York"
  noaaTideStationId: string;
  noaaTideStationFallbackId?: string;
  ndbcBuoyId: string;
  ndbcBuoyFallbackId?: string;
  /**
   * FL Healthy Beaches (DOH) water-quality config. `county` is the DOH county
   * name exactly as published by the feed (e.g. "Palm Beach", "Broward");
   * `sites` are the SPLocation sampling-site names (matched case-insensitively)
   * that make up this town's beaches.
   */
  healthyBeaches?: {
    county: string;
    sites: string[];
  };
  /** City/official conditions page to scrape (flags, lifeguard ratings, hazards). */
  cityConditionsUrl?: string;
  cams: CamConfig[];
}

export type LocationPublic = Pick<
  Location,
  "slug" | "name" | "region" | "lat" | "lon" | "timezone"
>;
