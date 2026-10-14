-- Data-quality loop, phase 1 (docs/QUALITY_PLAN.md): catch a wrong number,
-- ask the owner, keep the answer.
--
-- quality_alerts     one row per thing the watchdog flagged. Two producers:
--                      * scripts/cam_seaweed.py, when a held seaweed jump gets a
--                        second opinion that disagrees (POST /api/quality/alerts);
--                      * the hourly history archiver, when an hour's score, surf,
--                        sand or clarity moved more than nothing explains
--                        (lib/quality/watchdog.ts).
--                    `payload_json` holds what was flagged plus the evidence (the
--                    claim, the second opinion, the other cams, the frame's hash).
--                    `dedupe_key` is UNIQUE, so a retried POST never double-writes.
--                    `pushed` is 1 when the owner got a push for it; the daily cap
--                    and the 3-hour repeat rule count these rows (lib/quality/
--                    pushPolicy.ts). An alert that was not pushed (quiet hours,
--                    daily cap, unwatched beach) still shows in the review list.
--                    `status` is open until the owner answers, or until it is
--                    older than 24 hours (set to expired when the list is read).
--
-- quality_labels     the owner's answers, and the owner's own reports. The raw
--                    material for the golden test set and the weekly scorecard.
--                    source 'alert'  = a Right/Wrong tap on a quality_alerts row.
--                    source 'report' = "Report conditions" (no alert behind it;
--                                      verdict is NULL, correct_value is the truth).
--                    published_value / claimed_value / correct_value are JSON text.
--                    r2_key is the archived frame (cam_frames.r2_key) the label is
--                    about; frames_json lists every nearest frame a report captured.
--
-- quality_overrides  the owner's seaweed verdict on a cam, honored live until `until_utc`
--                    (the end of the beach-local day) or until the cam gives a NEWER
--                    fresh reading than `created_at_utc`. Two kinds:
--                      'wrong'  drop that cam's reading and claim from the live summary
--                               (lib/quality/seaweedOverrides.ts, in lib/sources/sargassum.ts),
--                               and the cam reader (GET /api/quality/overrides) stops that
--                               cam's further moderate+ claims from confirming by persistence
--                               or second opinion until it reads below moderate.
--                      'right'  publish the claim the owner judged (`claim_json`: level,
--                               coveragePct, note) for that cam's held reading; the reader
--                               stores it as a confirmed claim (confirmedBy "owner").
--
CREATE TABLE quality_labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  signal TEXT NOT NULL CHECK (signal IN ('seaweed', 'clarity', 'surf', 'sand', 'score', 'crowd', 'other')),
  observed_at_utc TEXT NOT NULL,       -- ISO, when the thing was seen (frame time, hour, or the report moment)
  source TEXT NOT NULL CHECK (source IN ('alert', 'report')),
  published_value TEXT,                -- JSON: what the app showed
  claimed_value TEXT,                  -- JSON: what the watchdog flagged (NULL for a report)
  verdict TEXT CHECK (verdict IN ('right', 'wrong')),
  correct_value TEXT,                  -- JSON: the truth, when the owner gave it
  cam_id TEXT,
  r2_key TEXT,                         -- an archived frame (cam_frames.r2_key)
  frames_json TEXT,                    -- JSON array of {camId, r2Key, displayAtUtc}, for a report
  note TEXT,
  created_at TEXT NOT NULL             -- ISO
);
CREATE INDEX quality_labels_slug_signal ON quality_labels(slug, signal, observed_at_utc);
CREATE INDEX quality_labels_created ON quality_labels(created_at);

CREATE TABLE quality_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  signal TEXT NOT NULL CHECK (signal IN ('seaweed', 'clarity', 'surf', 'sand', 'score', 'crowd', 'other')),
  kind TEXT NOT NULL,                  -- 'seaweed-held-disagreed' | 'hourly-jump'
  created_at TEXT NOT NULL,            -- ISO
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'expired')),
  label_id INTEGER,                    -- quality_labels.id once answered
  dedupe_key TEXT NOT NULL UNIQUE,
  pushed INTEGER NOT NULL DEFAULT 0 CHECK (pushed IN (0, 1))
);
CREATE INDEX quality_alerts_status_created ON quality_alerts(status, created_at);
CREATE INDEX quality_alerts_slug_signal ON quality_alerts(slug, signal, created_at);
CREATE INDEX quality_alerts_pushed ON quality_alerts(pushed, created_at);

CREATE TABLE quality_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  signal TEXT NOT NULL CHECK (signal IN ('seaweed', 'clarity', 'surf', 'sand', 'score', 'crowd', 'other')),
  cam_id TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,        -- ISO; readings scored at or before this are dropped
  until_utc TEXT NOT NULL,             -- ISO; the override ends here (end of the beach-local day)
  label_id INTEGER,
  verdict TEXT NOT NULL DEFAULT 'wrong' CHECK (verdict IN ('right', 'wrong')),
  claim_json TEXT                      -- JSON {level, coveragePct, note} the owner judged; used by 'right'
);
CREATE INDEX quality_overrides_slug_until ON quality_overrides(slug, signal, until_utc);
