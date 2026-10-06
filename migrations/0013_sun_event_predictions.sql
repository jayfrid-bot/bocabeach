-- Sun-event prediction log. One row per (beach, sun event, archive hour): the
-- hourly archiver (app/api/history/archive/route.ts) scores the NEXT sunrise
-- AND the NEXT sunset with the very same lib/sunAlert.ts
-- `assembleSunEventQuality` the sun-color card and push alert use, and keeps
-- the score plus EVERY input it was computed from. Rows for one event at
-- successive `as_of_hour_utc` values show how its forecast evolved as it got
-- closer, so predictions can later be checked against reality and the model
-- recalibrated. (Trigger: 2026-10-06, a ~90th-percentile Boca sunrise the app
-- rated "Good" — and nothing about the shown score had been stored.)
--
-- Recording only: nothing here changes any score. Kept permanently (no
-- pruning). The observed_* columns are reserved for truth data; nothing fills
-- them yet.
CREATE TABLE sun_event_predictions (
  slug TEXT NOT NULL,
  event_kind TEXT NOT NULL,            -- 'sunrise' | 'sunset'
  event_iso TEXT NOT NULL,             -- ISO instant of the event itself
  as_of_hour_utc TEXT NOT NULL,        -- ISO top of the UTC hour this row was archived for
  snapshot_generated_at TEXT NOT NULL, -- the snapshot's own clock (the "now" the model used)
  archived_at TEXT NOT NULL,
  lead_minutes INTEGER NOT NULL,       -- event_iso minus snapshot_generated_at, minutes

  score INTEGER,                       -- 0-100, NULL when no forecast cloud reading
  band TEXT,                           -- dud | plain | good | vivid | epic
  model_path TEXT,                     -- 'factor' | 'level-curve' | 'total-only' | NULL
  note TEXT,
  breakdown_json TEXT,                 -- factor-model breakdown (factor path only)

  -- Inputs, exactly as handed to sunEventQuality
  low_cloud_pct REAL,
  mid_cloud_pct REAL,
  high_cloud_pct REAL,
  total_cloud_pct REAL,
  humidity_pct REAL,
  aod REAL,
  pm2_5 REAL,
  horizon_cloud_pct REAL,              -- satellite horizon reading (NULL = none used)
  horizon_source TEXT,                 -- 'beam' (beamCloudPct) | 'overhead' (cloudPct fallback) | NULL
  horizon_fresh INTEGER,               -- 0/1, NULL when no horizon
  seasonal_prior REAL,                 -- factor path only (default prior when none supplied)
  point_time TEXT,                     -- hourly forecast point used (its ISO time), NULL if none
  peak_color_iso TEXT,
  peak_offset_minutes INTEGER,         -- peak color minus event, minutes

  algo_version TEXT NOT NULL,          -- SUN_QUALITY_VERSION
  engine_version TEXT NOT NULL,
  build_sha TEXT,

  -- Truth data, reserved: nothing fills these yet.
  observed_score REAL,
  observed_source TEXT,
  observed_at TEXT,

  PRIMARY KEY (slug, event_kind, event_iso, as_of_hour_utc)
);
CREATE INDEX sun_event_predictions_event ON sun_event_predictions(slug, event_iso);
