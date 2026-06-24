// ---------------------------------------------------------------------------
// Shared domain types for Is It Beach Day.
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
  humidityPct?: number; // relative humidity, 0-100
  dewPointF?: number; // °F — the comfort/mugginess driver
  /** NWS gridpoint (NDFD) sky cover % for the current hour — forecaster-curated. */
  cloudCoverPct?: number;
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
  /** Cloud cover, 0-100% (0 = full sun, 100 = overcast). */
  cloudCoverPct?: number;
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
  /**
   * Active City-issued swim/beach advisory from the myboca.us AlertCenter bar
   * (e.g. "NO SWIM ADVISORY for Spanish River Beach"). The City posts these
   * promptly — a timelier swim-safety signal than the county's weekly sampling.
   */
  noSwimAdvisory?: { title: string; url: string };
}

// --- 7-day outlook (Open-Meteo daily) -------------------------------------
export interface ForecastDay {
  date: string; // YYYY-MM-DD (local to the beach)
  dow: string; // "Mon"
  hi?: number; // °F
  lo?: number; // °F
  rain?: number; // precip probability %, 0-100
  windMaxMph?: number;
  weatherCode?: number; // WMO code
  emoji: string; // sky emoji derived from the code
  sky?: string; // short label derived from the code
}

// --- Hourly outlook (Open-Meteo hourly) -----------------------------------
/** Raw per-hour metrics; `time` is an absolute UTC ISO string. */
export interface HourlyMetrics {
  time: string; // ISO (UTC)
  airTempF?: number;
  cloudCoverPct?: number;
  precipProbability?: number; // 0-100
  weatherCode?: number; // WMO code
  windSpeedMph?: number;
  windDirDeg?: number;
  uvIndex?: number;
  humidityPct?: number; // relative humidity, 0-100
  dewPointF?: number; // °F — the comfort/mugginess driver
  /** Modeled ground-surface temperature (°F) — the basis of the sand estimate. */
  soilTempF?: number;
  /** Solar energy hitting the ground (W/m²); drives how much hotter sand runs. */
  solarWm2?: number;
  /** Precipitation that hour (inches) — wet sand stays near air temp. */
  precipIn?: number;
  shortForecast?: string; // derived from the WMO code
  emoji?: string; // sky emoji derived from the code
}

/** One scored daylight hour for the hourly score graph. */
export interface HourlyScore {
  time: string; // ISO (UTC)
  score: number; // 0-100 after caps
  rating: string; // "Excellent" | "Good" | "Fair" | "Poor"
  emoji: string;
  raining: boolean;
  windSpeedMph?: number;
  /** Direction the wind blows FROM, in degrees. */
  windDirDeg?: number;
}

// --- Rain nowcast (Open-Meteo minutely_15 precipitation) -------------------
export type NowcastState = "dry" | "raining";
export interface NowcastData {
  state: NowcastState;
  /** Minutes until rain starts (when dry) or stops (when raining); undefined if no change in the window. */
  changeInMin?: number;
  /** Plain-English summary, e.g. "Dry — rain likely in ~25 min". */
  text: string;
}

/** The best contiguous stretch of today's daylight hours by Beach Day score. */
export interface BestWindow {
  startIso: string;
  endIso: string;
  score: number;
}

/**
 * One upcoming day's beach-time outlook: the best contiguous daylight window by
 * Beach Day score, the day's peak hourly score, and a representative sky emoji.
 * Powers the "best beach times for the next few days" forecast. `best` is null
 * when no daylight hours scored for that day (e.g. today already past sunset).
 */
export interface DayWindow {
  /** YYYY-MM-DD in the beach's local time. */
  date: string;
  /** Short weekday label, e.g. "Mon" (or "Today"). */
  dow: string;
  best: BestWindow | null;
  /** Peak hourly score across the day's daylight hours (0-100), or null. */
  peakScore: number | null;
  /** Representative sky emoji (around midday). */
  emoji: string;
}

// --- Sun times (computed locally from lat/lon/date) ------------------------
export interface SunData {
  /** Calendar day these events fall on, local to the beach (YYYY-MM-DD). */
  date: string;
  /** First light / civil dawn (sun 6° below horizon), ISO. */
  daybreak?: string;
  /** Sunrise (upper limb at the horizon, ISO). */
  sunrise?: string;
  /** Solar noon — the sun at its highest and strongest, ISO. */
  solarNoon?: string;
  /** Sunset (upper limb at the horizon, ISO). */
  sunset?: string;
  /** Dusk / civil twilight end (sun 6° below horizon, evening), ISO. */
  dusk?: string;
  /** Sun's maximum altitude above the horizon at solar noon (degrees). */
  maxAltitudeDeg?: number;
  /** Tonight's moon phase (computed from the date). */
  moonPhase?: {
    phase: string;
    emoji: string;
    illumination: number;
    /** Position in the ~29.5-day synodic cycle: 0 = new, 0.5 = full, →1 = next new. */
    fraction: number;
  };
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

// --- Air quality (Open-Meteo Air Quality) ----------------------------------
// --- MET Norway current conditions (consensus second opinion) --------------
export interface MetnoCurrent {
  airTempF?: number;
  windSpeedMph?: number;
  /** Direction the wind is coming FROM, in degrees. */
  windDirDeg?: number;
  humidityPct?: number;
  dewPointF?: number;
  cloudCoverPct?: number;
}

export interface AirQualityData {
  /** US EPA AQI (0-500+); the headline number for the meter. */
  usAqi?: number;
  /** Pollutant driving the AQI, e.g. "PM2.5" | "PM10" | "Ozone". */
  dominantPollutant?: string;
  pm2_5?: number; // µg/m³
  pm10?: number; // µg/m³
  ozone?: number; // µg/m³
  observedAt?: string; // ISO
}

// --- Lightning (NOAA GOES-19 GLM, via an off-Netlify job) ------------------
export interface LightningData {
  /** Minutes of GLM data the upstream job scanned. Omitted when the upstream
   * payload doesn't report it (rather than passing a bogus value through). */
  windowMinutes?: number;
  /** Closest strike in the window (miles) + how long ago (minutes). */
  nearestMi?: number;
  nearestMinutesAgo?: number;
  /** Compass bearing FROM the beach TO the closest strike (deg, 0=N, 90=E). */
  nearestBearingDeg?: number;
  /** Most recent strike in the window (may differ from the closest). */
  lastMinutesAgo?: number;
  lastMi?: number;
  /** Strike counts within radius bands over the window. */
  within10mi: number;
  within25mi: number;
  within50mi: number;
  /** Total strikes the job saw in its scanned area + window. */
  totalInArea: number;
  /** Age of the upstream GLM snapshot, in minutes (its end-to-end latency). */
  dataAgeMinutes?: number;
}

// --- Sargassum / seaweed (NOAA Sargassum Inundation Risk, via off-Netlify job) ---
export type SargassumRisk = "none" | "low" | "moderate" | "high" | "unknown";
/** One beach-cam's observed reading (from the vision job): seaweed + crowd. */
export interface CamSeaweedReading {
  name: string;
  level: SargassumRisk;
  /** 0-100 % of visible sand/shore covered by sargassum (refines the score). */
  coveragePct?: number;
  note?: string;
  capturedAt?: string;
  /** How busy the beach looks from this cam. */
  crowd?: BusynessLevel;
  /** Approx number of people visible. */
  people?: number;
  /** 0-100 how full the beach looks. */
  crowdPct?: number;
  crowdNote?: string;
}
/** Typical seaweed by local hour, learned from the rolling cam history. */
export interface SargassumByHour {
  hour: number; // local hour 0-23
  level: SargassumRisk; // none | low | moderate | high — the band, for the bar COLOUR
  /** Continuous 0-3 rank (coverage-aware) — drives the bar HEIGHT (granular). */
  avg?: number;
  samples: number;
}
/** One day's AVERAGE seaweed, for the seaweed-by-day chart. */
export interface SargassumByDay {
  date: string; // local calendar date, YYYY-MM-DD
  level: SargassumRisk; // the day's average band — drives the bar colour
  /** Average level on the 0-3 scale (continuous) — drives the bar height. */
  avg: number;
  /** Number of cam reads that fed the day. */
  samples: number;
  /** Worst single reading that day (for the tooltip). */
  worst: SargassumRisk;
}

// --- Beach busyness (from the same cam-vision job) -------------------------
export type BusynessLevel =
  | "empty"
  | "quiet"
  | "moderate"
  | "busy"
  | "packed"
  | "unknown";
export interface BusynessByHour {
  hour: number; // local hour 0-23
  level: BusynessLevel; // the band, for the bar COLOUR
  people?: number;
  /** Avg 0-100 fullness for this hour (refines the hourly crowd sub-score). */
  crowdPct?: number;
  /** Continuous 0-4 rank (fullness-aware) — drives the bar HEIGHT (granular). */
  avg?: number;
  samples: number;
}
/** One day's AVERAGE crowd, for the busyness-by-day chart. */
export interface BusynessByDay {
  date: string; // local calendar date, YYYY-MM-DD
  level: BusynessLevel; // the day's average band — drives the bar colour
  /** Average level on the 0-4 scale (continuous) — drives the bar height. */
  avg: number;
  /** Average people across the day's reads (for the tooltip). */
  people?: number;
  /** Number of cam reads that fed the day. */
  samples: number;
}
export interface BusynessData {
  level: BusynessLevel;
  /** Approx people visible at the busiest cam. */
  peopleEstimate?: number;
  /** 0-100 fullness at the busiest cam. */
  crowdPct?: number;
  note?: string;
  capturedAtLocal?: string;
  cams?: { name: string; crowd: BusynessLevel; people?: number }[];
  /** Typical busyness by local hour, learned from the rolling cam history. */
  byHour?: BusynessByHour[];
  /** Peak busyness per day, learned from the rolling cam history. */
  byDay?: BusynessByDay[];
}
/**
 * Seaweed (sargassum) read entirely from the beach cams by the vision job —
 * the worst level seen across the cams, preferring the early-morning shot
 * (taken before the City's beach-cleaning tractor, so most representative).
 */
export interface SargassumData {
  level: SargassumRisk;
  /** 0-100 % coverage at the worst cam in the most recent capture. */
  coveragePct?: number;
  note?: string;
  /** True when the most recent capture is from the early-morning window. */
  isMorning: boolean;
  capturedAtLocal?: string;
  cams: CamSeaweedReading[];
  /** Today's actual reads in capture order — past hours score with the read
   * in effect at that time, so later changes never rewrite earlier hours. */
  todayReads?: { hour: number; level: SargassumRisk; coveragePct?: number }[];
  /** Typical seaweed by local hour, learned from the rolling cam history. */
  byHour?: SargassumByHour[];
  /** Worst seaweed per day, learned from the rolling cam history. */
  byDay?: SargassumByDay[];
}

// --- NWS alerts + rip-current risk (api.weather.gov) -----------------------
export type RipRisk = "low" | "moderate" | "high" | "unknown";
export interface NwsAlert {
  event: string; // "Rip Current Statement"
  severity: string; // "Moderate" | "Severe" | ...
  headline?: string;
  ends?: string; // ISO
}
export interface NwsData {
  /** Active NWS alerts for the beach point. */
  alerts: NwsAlert[];
  /** Today's rip-current risk from the Surf Zone Forecast. */
  ripCurrentRisk: RipRisk;
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
  dewPointF?: number; // °F
  weatherCode?: number; // WMO code
  shortForecast?: string; // human-readable, derived from the WMO code
  observedAt?: string; // ISO
}

// --- Traffic (area congestion near the beach, HERE Traffic v7 flow) --------
export type TrafficLevel = "light" | "moderate" | "heavy" | "severe" | "unknown";
export interface TrafficData {
  /** Congestion band derived from HERE jamFactor. */
  level: TrafficLevel;
  /** 0-100 congestion index (jamFactor × 10); undefined when unknown. */
  congestion?: number;
  /** Number of usable road segments that fed the aggregate. */
  segments: number;
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
  nowcast: Wrapped<NowcastData>;
  nws: Wrapped<NwsData>;
  airQuality: Wrapped<AirQualityData>;
  /** MET Norway current conditions — independent consensus voice. */
  metno: Wrapped<MetnoCurrent>;
  /** Explicit NOAA GFS model voice (via Open-Meteo) for the consensus. */
  gfs: Wrapped<MetnoCurrent>;
  lightning: Wrapped<LightningData>;
  sargassum: Wrapped<SargassumData>;
  busyness: Wrapped<BusynessData>;
  traffic: Wrapped<TrafficData>;
  forecast: Wrapped<ForecastDay[]>;
  sun: Wrapped<SunData>;
  hourly: Wrapped<HourlyMetrics[]>;
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
  /** false only when zero sub-scores were available (total data outage) so the UI can show "Conditions unavailable". */
  dataAvailable?: boolean;
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
  /** Capture time of the displayed still (ISO), when the source publishes one. */
  capturedAt?: string;
  attribution?: string;
  weather: Wrapped<SpotWeatherData>;
}

export interface ConditionsResponse {
  snapshot: ConditionsSnapshot;
  /** Single composite Beach Day score (0-100) with breakdown + safety caps. */
  score: ScoreResult;
  /** Beach Day score forecast across today's daylight hours (empty if unavailable). */
  hourlyScores: HourlyScore[];
  /** Best beach-time window + peak score per upcoming day (today first). */
  multiDayWindows: DayWindow[];
  cams: CamView[];
}

// --- Location config -------------------------------------------------------
export interface CamConfig {
  /**
   * Stable id, required when `snapshotUrl` or `snapshotFeed` is set: it keys the
   * /api/cam/[id] proxy allowlist so only configured upstreams can be fetched (no SSRF).
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
  /**
   * Live still resolved from a video-monitoring.com "latest.json" feed: we read
   * the most-recent frame path for `view` and proxy it via /api/cam/[id]. Use this
   * (instead of snapshotUrl) when the freshest frame lives at a rotating path.
   */
  snapshotFeed?: {
    /** Cam base directory, e.g. http://video-monitoring.com/beachcams/bocainlet */
    base: string;
    /** View key within latest.json, e.g. "s4". */
    view: string;
    /** Frame resolution to serve (default "mr" ≈ 1920px; "hr" is the full original). */
    res?: "mr" | "hr";
  };
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
  /**
   * Provenance tier. `"curated"` = a human filled in the local fields (cams,
   * lifeguard-flag scrape, water-quality county). `"auto"` = produced by the
   * beach auto-resolver from lat/lon, so the national data layers (weather,
   * marine, tides, buoy, NWS alerts/rip, UV, air) are present but the curated
   * locals are not yet. Absent ⇒ `"curated"` (every hand-written entry).
   */
  tier?: "curated" | "auto";
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
  /**
   * NWS Surf Zone Forecast lookup for rip-current risk: `office` is the issuing
   * WFO (e.g. "MFL" = Miami), `name` is the zone block name in the SRF text
   * (e.g. "Palm Beach"). Alerts use lat/lon and need no config.
   */
  surfZone?: { office: string; name: string };
  /** Optional override for the HERE traffic sampling radius (km). Defaults to ~2 km. */
  trafficRadiusKm?: number;
  cams: CamConfig[];
}

export type LocationPublic = Pick<
  Location,
  "slug" | "name" | "region" | "lat" | "lon" | "timezone" | "tier"
>;
