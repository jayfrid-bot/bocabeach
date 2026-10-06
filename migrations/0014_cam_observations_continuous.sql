-- Continuous cam archive. `cam_observations` (0006) was filled once by
-- scripts/backfill_cam_history.mjs; the hourly archiver now keeps it current
-- (lib/history/camObservations.ts) and also stores the per-cam detail the feed
-- carries only in its `latest` / `morning` groups.
--
-- 1) cam_observations gains the two history-entry fields 0006 had no column
--    for: the busiest-cam crowd WORD and the underwater read's level word. The
--    UPDATE back-fills them (and uw_pct, which the one-shot backfill always
--    left NULL) for the existing rows from their verbatim raw_json.
-- 2) cam_reads: one row per (beach, capture, cam) — each cam's own seaweed /
--    crowd / water read, so a roll-up (worst seaweed, busiest crowd, median
--    water) can later be checked against the individual angles. Kept
--    permanently; written INSERT OR IGNORE so re-reading the feed is a no-op.
ALTER TABLE cam_observations ADD COLUMN crowd_level TEXT;
ALTER TABLE cam_observations ADD COLUMN uw_level TEXT;

UPDATE cam_observations
SET crowd_level = json_extract(raw_json, '$.level'),
    uw_level    = json_extract(raw_json, '$.uwLevel'),
    uw_pct      = COALESCE(uw_pct, json_extract(raw_json, '$.uw'))
WHERE raw_json IS NOT NULL AND json_valid(raw_json);

CREATE TABLE cam_reads (
  slug TEXT NOT NULL,
  captured_at_utc TEXT NOT NULL,  -- same parse as cam_observations.captured_at_utc
  cam_id TEXT NOT NULL,           -- the feed's cam id (falls back to the cam name)
  cam_name TEXT,
  seaweed_level TEXT,
  cov_pct REAL,
  seaweed_note TEXT,
  crowd_level TEXT,
  crowd_pct REAL,
  people INTEGER,
  crowd_note TEXT,
  water_word TEXT,
  water_pct REAL,
  water_note TEXT,
  raw_json TEXT,                  -- the cam's reading verbatim (provider, frameAt, ...)
  PRIMARY KEY (slug, captured_at_utc, cam_id)
);
