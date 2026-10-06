-- Sun-event observations: what the sky ACTUALLY did at each sunrise/sunset,
-- scored 0-100 from the beach livestreams by scripts/sun_cam_check.py (runs on
-- the owner's Mac) and delivered through POST /api/sun-observations. This is
-- the ground truth for calibrating lib/sunQuality.ts against the predictions
-- logged in sun_event_predictions (migrations/0013). See docs/SUN_CAM_CHECK.md.
-- (0014 is reserved for a parallel branch.)
--
-- One row per (beach, event, local day, cam): a Deerfield cam reports for both
-- Deerfield Beach and Boca Raton, so a beach can have several rows for one
-- event. `view` is 'solar' when the cam looks at the sun (a sunrise on the
-- east-facing cams) and 'antisolar' when it looks away (a sunset), so the two
-- are never averaged together. `distance_mi` is how far the cam is from the
-- beach's pin. Re-posting the same key replaces the row (a re-score).
--
-- Every row carries the credit string for the cam's owner; Elbo Room allowed
-- the use on the condition that it is credited. Kept permanently.
CREATE TABLE sun_event_observations (
  slug TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('sunrise', 'sunset')),
  event_date_local TEXT NOT NULL,      -- beach-local calendar day, YYYY-MM-DD
  cam_id TEXT NOT NULL,                -- config/sun-cams.json id
  event_iso TEXT NOT NULL,             -- ISO instant of the event itself (same value sun_event_predictions.event_iso holds)
  view TEXT NOT NULL CHECK (view IN ('solar', 'antisolar')),
  distance_mi REAL NOT NULL,           -- cam to the beach's pin, miles
  observed_score REAL NOT NULL,        -- 0-100, the PEAK frame's score
  warm_frac REAL NOT NULL,             -- peak frame: warm share of the valid sky pixels, 0-1
  colorfulness REAL NOT NULL,          -- peak frame: Hasler-Suesstrunk colorfulness
  peak_frame_iso TEXT NOT NULL,        -- which frame was the peak
  series_json TEXT NOT NULL,           -- [{t, score, warm_frac, colorfulness, warm_sat}], event-35 min .. event+25 min
  score_version TEXT NOT NULL,         -- SUN_CAM_SCORE_VERSION in scripts/sun_cam_check.py
  credit TEXT NOT NULL,                -- e.g. 'Live stream courtesy Elbo Room (ElboRoom.com)'
  created_at TEXT NOT NULL,            -- when this row was written
  PRIMARY KEY (slug, event_kind, event_date_local, cam_id)
);
CREATE INDEX sun_event_observations_event ON sun_event_observations(slug, event_iso);
