// Row shapes for the hourly history archive (migrations/0006_history.sql).
// snake_case, mirroring the D1 columns exactly — see lib/db/d1Store.ts /
// lib/db/memoryStore.ts for the two backends that read/write these.

import type { FlagColor } from "@/lib/types";

export interface BeachHourlyRow {
  slug: string;
  hour_utc: string;
  snapshot_generated_at: string;
  archived_at: string;
  local_date: string;
  local_hour: number;
  utc_offset_minutes: number;
  timezone: string;

  score: number | null;
  raw_score: number | null;
  rating: string | null;
  available_weight: number | null;
  observed_weight: number | null;
  coverage_tier: "full" | "standard" | "limited" | null;

  air_temp_f: number | null;
  water_temp_f: number | null;
  sand_temp_f: number | null;
  /** RAW significant wave height (Hs) from the buoy/model — never the
   *  estimated surf (breaking) height. Has meant this since migration 0006;
   *  keep it that way so older rows stay comparable to new ones. See
   *  `surf_ft` below for the estimated-surf number (migration 0010). */
  wave_ft: number | null;
  /** Estimated SURF (breaking) height (lib/surfHeight.ts) — what the app
   *  shows/scores as "waves". NULL on every row archived before migration
   *  0010 (and on any row whose wave reading had no raw Hs at all); never
   *  back-filled, since there's no way to retroactively estimate surf for a
   *  row that only ever kept Hs with no period stored alongside it. */
  surf_ft: number | null;
  wave_source: "observed" | "model" | null;
  wind_mph: number | null;
  gust_mph: number | null;
  uv: number | null;
  cloud_pct: number | null;
  rain_now: 0 | 1 | null;
  lightning_near: 0 | 1 | null;
  tide_state: "rising" | "falling" | null;
  crowd_pct: number | null;
  seaweed_pct: number | null;
  seaweed_level: string | null;
  clarity_pct: number | null;

  engine_version: string;
  scoring_config_version: string;
  build_sha: string | null;
  row_kind: "snapshot" | "cam-backfill";
  archive_reason: string | null;

  caps_json: string | null;
  factors_json: string | null;
  missing_json: string | null;
  extra_json: string | null;
}

/**
 * One row of `sun_event_predictions` (migrations/0013): the sunrise/sunset
 * color model's output for ONE sun event — the one the card shows, which
 * stays current through its golden window, so `lead_minutes` is negative
 * just after the event — as of one archive hour, with every input it used. See lib/history/sunPredictions.ts.
 */
export interface SunEventPredictionRow {
  slug: string;
  event_kind: "sunrise" | "sunset";
  event_iso: string;
  as_of_hour_utc: string;
  snapshot_generated_at: string;
  archived_at: string;
  lead_minutes: number;

  score: number | null;
  band: string | null;
  model_path: "factor" | "total-only" | null;
  note: string | null;
  breakdown_json: string | null;

  low_cloud_pct: number | null;
  mid_cloud_pct: number | null;
  high_cloud_pct: number | null;
  total_cloud_pct: number | null;
  humidity_pct: number | null;
  aod: number | null;
  pm2_5: number | null;
  horizon_cloud_pct: number | null;
  horizon_source: "beam" | "overhead" | null;
  horizon_fresh: 0 | 1 | null;
  seasonal_prior: number | null;
  point_time: string | null;
  peak_color_iso: string | null;
  peak_offset_minutes: number | null;

  algo_version: string;
  engine_version: string;
  build_sha: string | null;

  observed_score: number | null;
  observed_source: string | null;
  observed_at: string | null;
}

/**
 * One row of `sun_event_observations` (migrations/0015): what the sky actually
 * did at one sunrise/sunset, scored from one cam's livestream by
 * scripts/sun_cam_check.py. Keyed (slug, event_kind, event_date_local, cam_id).
 */
export interface SunEventObservationRow {
  slug: string;
  event_kind: "sunrise" | "sunset";
  /** Beach-local calendar day, YYYY-MM-DD. */
  event_date_local: string;
  cam_id: string;
  event_iso: string;
  /** 'solar' = the cam looks at the sun; 'antisolar' = it looks away. */
  view: "solar" | "antisolar";
  distance_mi: number;
  /** 0-100, the peak frame's score. */
  observed_score: number;
  warm_frac: number;
  colorfulness: number;
  peak_frame_iso: string;
  series_json: string;
  /** 'YYYY-MM-DD.N' — see isNewerSunScore. */
  score_version: string;
  /** When the script scored the event (ISO UTC). */
  scored_at: string;
  credit: string;
  /** When this key was first received; never rewritten by a re-score. */
  created_at: string;
}

/**
 * Is an incoming observation's (score_version, scored_at) strictly newer than
 * the stored one? score_version compares by its date part, then its counter as
 * a number (so '.10' beats '.9'), then scored_at. An exact duplicate is NOT
 * newer, so it is a no-op. d1Store.ts's upsert encodes the same rule in SQL.
 */
export function isNewerSunScore(
  incoming: Pick<SunEventObservationRow, "score_version" | "scored_at">,
  stored: Pick<SunEventObservationRow, "score_version" | "scored_at">,
): boolean {
  const parts = (v: string): [string, number] => [v.slice(0, 10), Number(v.slice(11))];
  const [ad, an] = parts(incoming.score_version);
  const [bd, bn] = parts(stored.score_version);
  if (ad !== bd) return ad > bd;
  if (an !== bn) return an > bn;
  return incoming.scored_at > stored.scored_at;
}

/** The `observed_source` text a sun-cam observation writes onto prediction rows. */
export function sunCamObservedSource(camId: string, view: "solar" | "antisolar"): string {
  return `sun-cam:${camId}:${view}`;
}

/**
 * Shape of `beach_hourly.extra_json` (schema version `v`): the app's other
 * proprietary computed readouts as of the archived hour — compact numbers and
 * enums only, no prose. Every block is optional: a model that had no input,
 * or threw while archiving, is simply absent (never fabricated). Each block
 * carries its own algorithm version `av` where the module has one; modules
 * without a version constant are tagged with the dated string below, which
 * must be bumped by hand when that model's formula changes.
 */
export interface BeachHourlyExtra {
  v: 1;
  /** Estimated surf (lib/surfHeight.ts, Komar-Gaughan). */
  surf?: {
    av: string;
    /** Total raw Hs, ft. */
    hs: number | null;
    /** Raw height that actually fed the estimate (can be the swell part), ft. */
    rawFt: number | null;
    /** Its paired dominant period, s. */
    periodS: number | null;
    /** Estimated breaking surf, ft. */
    surfFt: number | null;
    src: "buoy" | "model" | null;
  };
  /** Sand temperature model (lib/sandTemp.ts) and the inputs it ran on. */
  sand?: {
    av: string;
    tempF: number | null;
    surfF: number | null;
    soilF: number | null;
    solarWm2: number | null;
    windMph: number | null;
    rainIn: number | null;
    cloudPct: number | null;
    beamCloud: 0 | 1;
    carried: 0 | 1;
    hfn: number | null;
  };
  /** Rip current resolved for this hour (lib/ripRisk). */
  rip?: {
    av: string;
    level: string;
    source: string;
    /** NOAA model probability %, when a fresh model hour exists. */
    modelPct: number | null;
    /** The SRF period's own word, when one is current. */
    srf: string | null;
    watch: 0 | 1;
    alert: 0 | 1;
  };
  /** Storm activity meter (lib/stormActivity.ts). */
  storm?: {
    av: string;
    score: number;
    band: string;
    strikes: number | null;
    proximity: number | null;
    rain: number | null;
    radar: 0 | 1;
  };
  /** Feels-like beach temperature (lib/feelsLikeBeach.ts). */
  feels?: { av: string; tempF: number; band: string };
  /** Water-feel trend (lib/waterTrend.ts). */
  water?: { av: string; status: string; d48: number; d7d: number | null };
  /** Crowd and seaweed vs the beach's own average (lib/vsAverage.ts). */
  vsAvg?: {
    av: string;
    crowd?: { pct: number | null; pts: number | null; days: number };
    seaweed?: { pct: number | null; pts: number | null; days: number };
  };
  /** Swim-safety and surf-condition levels (lib/safetyLine.ts). */
  safety?: { av: string; swim: string; surf: string };
  /** Best beach window today (multiDayWindows[0].best). */
  window?: { av: string; startIso: string; endIso: string; score: number } | null;
  /** Sky events on the "Coming up" card with their visibility rating
   *  (lib/skyEvents.ts, lib/skyVisibilityQuality.ts). */
  sky?: { av: string; events: { t: string; at: string; r: string | null; s: number | null }[] };
  /**
   * Rain loop (scorecard): the model nowcast next to the radar reading it is
   * later judged against. `beach_hourly.rain_now` is derived from the nowcast,
   * so it is NOT truth; `radarMmHr`/`radarDry` are.
   */
  rain?: {
    av: string;
    /** Open-Meteo minutely_15 nowcast state. */
    nowcast: "dry" | "raining" | null;
    /** Minutes until that state flips (absent = no change in the next 2 h). */
    changeInMin: number | null;
    /** MRMS radar rain rate at the beach, mm/hr (null = no radar reading). */
    radarMmHr: number | null;
    /** 1 = fresh radar frame saw no rain now or in the last 20 min; 0 = it saw
     *  rain at/near the beach or within 20 min; null = no usable frame. */
    radarDry: 0 | 1 | null;
    /** Age of the radar frame, minutes. */
    radarAgeMin: number | null;
  };
  /** Lifeguard flags as posted (CityOfficialData.flags) and the feed status. */
  flags?: { av: string; colors: FlagColor[]; status: string | null };
  /** Best-day outlook for days 1..6 ahead (multiDayWindows[1..6]); day 0 is `window`. */
  outlook?: {
    av: string;
    days: { date: string; peak: number | null; start: string | null; end: string | null; score: number | null }[];
  };
}

export interface CamObservationRow {
  slug: string;
  captured_at_utc: string;
  crowd_pct: number | null;
  people: number | null;
  seaweed_level: string | null;
  cov_pct: number | null;
  clarity_pct: number | null;
  water_word: string | null;
  uw_pct: number | null;
  source: "feed" | "live";
  raw_json: string | null;
  /** Busiest-cam crowd word (migration 0014). */
  crowd_level: string | null;
  /** Underwater read's level word (migration 0014). */
  uw_level: string | null;
}

/** One cam's own read within a capture (migrations/0014 `cam_reads`). */
export interface CamReadRow {
  slug: string;
  captured_at_utc: string;
  cam_id: string;
  cam_name: string | null;
  seaweed_level: string | null;
  cov_pct: number | null;
  seaweed_note: string | null;
  crowd_level: string | null;
  crowd_pct: number | null;
  people: number | null;
  crowd_note: string | null;
  water_word: string | null;
  water_pct: number | null;
  water_note: string | null;
  raw_json: string | null;
}

/** A served beach with just enough to decide whether/when to archive it. */
export interface ArchiveCandidate {
  slug: string;
  lat: number;
  lon: number;
  timezone: string;
  /** 'curated' beaches archive every hour; 'auto' beaches only in daylight. */
  tier: "curated" | "auto";
}

// --- Lifetime records (Plus "Last N days" history feature) -----------------
// One row per kind, straight off `DeviceStore.historyRecords`'s UNION ALL
// query (d1Store.ts) — each kind is the single (slug, hour) reading that
// wins its own ORDER BY/LIMIT 1, across the WHOLE archive for this beach,
// never bounded by whatever `days` window a caller asked hourlyHistory for.

export type HistoryRecordKind = "best" | "hottest_sand" | "biggest_surf" | "quietest";

export interface HistoryRecordRow {
  kind: HistoryRecordKind;
  local_date: string;
  local_hour: number;
  value: number;
}

/** The single highest hourly Beach Day score in the WHOLE archive, across
 *  every beach — straight off `DeviceStore.historyBestEver`'s one bounded
 *  statement. Ties go to the earliest `hour_utc`. */
export interface HistoryBestEverRow {
  slug: string;
  local_date: string;
  local_hour: number;
  score: number;
}

export interface HistoryRecordsResult {
  /** 0-4 rows — a kind is simply absent when this beach has no row with a
   *  non-null value for that column yet (e.g. a beach with no cams has no
   *  'quietest' row, ever). */
  records: HistoryRecordRow[];
  /** MIN(local_date) across every snapshot row for this beach, or null when
   *  this beach has never been archived at all. */
  archiveStartedAt: string | null;
  /** COUNT(DISTINCT local_date) across every snapshot row for this beach. */
  dayCount: number;
  /** MIN(local_date) among rows that actually have a non-null `surf_ft` —
   *  the surf estimate (lib/surfHeight.ts, migration 0010) is newer than
   *  the archive itself, so this is normally LATER than `archiveStartedAt`,
   *  sometimes by several days. The UI uses the gap to caption the
   *  "Biggest surf" tile honestly ("since <surfSince>") instead of implying
   *  it covers the whole archive. Null when no row has ever had a surf_ft
   *  value (in which case the 'biggest_surf' record itself is also absent). */
  surfSince: string | null;
}
