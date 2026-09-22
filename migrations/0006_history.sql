-- Hourly beach history archive (docs/HISTORY_AND_IMAGERY_PLAN.md Part A, as
-- amended by the "Codex review 2026-09-20" section at the bottom of that file).
--
-- beach_hourly      one row per (slug, UTC hour) — the newest conditions build
--                   that was actually shown for that hour. Typed columns for
--                   anything filtered/graphed/aggregated; JSON text columns
--                   only for evolving/variable-shape structures (cap strings,
--                   per-factor sub-score breakdown, missing-factor list, and a
--                   free-form `extra_json` escape hatch for anything added
--                   later without another migration).
--
--                   Keyed by UTC hour (`hour_utc`) so DST never creates a
--                   collision or a gap: `local_date`/`local_hour` are
--                   denormalized display fields, not the key — a fall-back
--                   1 AM happens twice in local time but each occurrence is a
--                   distinct UTC hour, and a spring-forward 2 AM that never
--                   happens in local time simply has no local beach ever
--                   claim it.
--
-- cam_observations  raw cam-vision reads (crowd/seaweed/clarity), independent
--                   of beach_hourly and NEVER used to fabricate a score for an
--                   hour beach_hourly has no row for. Keyed by the read's own
--                   capture time so the backfill script (which only has cam
--                   data, never a score) has somewhere honest to put it.
--
-- history_budget    one row per UTC day, counting archive "builds" (each an
--                   `getConditions` call ≈ 10 upstream API calls) so the
--                   archiver can stop for the day before blowing through
--                   Open-Meteo's free-tier request budget. Reserved BEFORE a
--                   build via a single conditional UPSERT (`builds < max`),
--                   never bumped after the fact — that closes the race where
--                   two overlapping cron calls both read the same remaining
--                   budget and both proceed (Codex review 2026-09-22).
--
-- history_claims    one row per (slug, hour_utc) a build was ever attempted
--                   for — `key` = `history:<slug>:<hour_utc>`. Same
--                   abandonment-window pattern as `send_claims`
--                   (migrations/0004_send_claims.sql): the INSERT ... ON
--                   CONFLICT DO UPDATE wins for the caller when no claim
--                   exists OR the existing claim is older than
--                   ABANDONED_CLAIM_MS (10 min) and `completed_at` is still
--                   NULL, so a build that timed out, threw, or failed its
--                   upsert is retried by a later tick instead of losing that
--                   (slug, hour) forever. `completed_at` is set on a
--                   successful write (lib/db/store.ts completeHistoryClaim).
--                   A stale-snapshot skip (see rowFromConditions/the archive
--                   route) instead calls releaseHistoryClaim to delete the
--                   row outright, so the very next tick can retry once the
--                   getConditions cache has turned over — no need to wait
--                   out the full abandon window.

CREATE TABLE beach_hourly (
  slug TEXT NOT NULL,
  hour_utc TEXT NOT NULL,              -- ISO, top of the UTC hour, e.g. 2026-09-20T14:00:00.000Z
  snapshot_generated_at TEXT NOT NULL, -- ISO — the snapshot's own clock (see lib/conditions.ts)
  archived_at TEXT NOT NULL,           -- ISO — when this row was written
  local_date TEXT NOT NULL,            -- YYYY-MM-DD in the beach's own timezone
  local_hour INTEGER NOT NULL,         -- 0-23, beach-local
  utc_offset_minutes INTEGER NOT NULL, -- beach-local minus UTC, at hour_utc (DST-aware)
  timezone TEXT NOT NULL,              -- IANA, e.g. America/New_York

  score INTEGER,
  raw_score INTEGER,
  rating TEXT,
  available_weight REAL,   -- sum of sub-score weights that had data
  observed_weight REAL,    -- sum of sub-score weights backed by a live observation (vs. model)
  coverage_tier TEXT,      -- 'full' | 'standard' | 'limited'

  air_temp_f REAL,
  water_temp_f REAL,
  sand_temp_f REAL,
  wave_ft REAL,
  wave_source TEXT,        -- 'observed' | 'model' | NULL
  wind_mph REAL,
  gust_mph REAL,
  uv REAL,
  cloud_pct REAL,
  rain_now INTEGER,        -- 0/1
  lightning_near INTEGER,  -- 0/1
  tide_state TEXT,         -- 'rising' | 'falling' | NULL
  crowd_pct REAL,
  seaweed_pct REAL,
  seaweed_level TEXT,
  clarity_pct REAL,

  engine_version TEXT NOT NULL,
  scoring_config_version TEXT NOT NULL,
  build_sha TEXT,
  row_kind TEXT NOT NULL DEFAULT 'snapshot', -- 'snapshot' | 'cam-backfill'
  archive_reason TEXT,     -- why this row was (re)written, e.g. 'cron', 'backfill'

  caps_json TEXT,          -- JSON array of active cap strings
  factors_json TEXT,       -- JSON array of {key,label,score,weight,display?}
  missing_json TEXT,       -- JSON array of sub-score keys with no data
  extra_json TEXT,         -- reserved for fields added without a migration

  PRIMARY KEY (slug, hour_utc)
);
CREATE INDEX beach_hourly_slug_date ON beach_hourly(slug, local_date);
CREATE INDEX beach_hourly_hour_utc ON beach_hourly(hour_utc);

CREATE TABLE cam_observations (
  slug TEXT NOT NULL,
  captured_at_utc TEXT NOT NULL,  -- ISO, parsed to UTC from the feed's offset-bearing local time
  crowd_pct REAL,
  people INTEGER,
  seaweed_level TEXT,
  cov_pct REAL,
  clarity_pct REAL,
  water_word TEXT,
  uw_pct REAL,
  source TEXT NOT NULL,           -- 'feed' | 'live'
  raw_json TEXT,                  -- the original history entry, verbatim
  PRIMARY KEY (slug, captured_at_utc)
);

CREATE TABLE history_budget (
  day TEXT PRIMARY KEY,           -- YYYY-MM-DD, UTC
  builds INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE history_claims (
  key TEXT PRIMARY KEY,           -- `history:<slug>:<hour_utc>`
  claimed_at INTEGER NOT NULL,    -- ms epoch, when this build was (last) claimed
  completed_at INTEGER            -- ms epoch, set when the claimed build actually wrote a row
);
