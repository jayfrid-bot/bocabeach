// Row shapes for the hourly history archive (migrations/0006_history.sql).
// snake_case, mirroring the D1 columns exactly — see lib/db/d1Store.ts /
// lib/db/memoryStore.ts for the two backends that read/write these.

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
  wave_ft: number | null;
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
