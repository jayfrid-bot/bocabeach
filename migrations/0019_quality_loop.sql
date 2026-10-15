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
--                    claim, the second opinion, the other cams, the exact claim
--                    identity: cam, frame hash or time, claim time, beach-local date).
--                    `dedupe_key` is UNIQUE, so a retried POST never double-writes.
--                    `pushed` is 1 once a phone accepted the push. `status` is open
--                    until the owner answers, or until it is older than 24 hours
--                    (set to expired when the list is read).
--
-- quality_push_slots the push LIMITS, enforced by D1 itself, and the push QUEUE. An alert that may
--                    push takes a slot in ONE conditional INSERT (lib/quality/pushSlots.ts), in the same
--                    batch as the alert itself: at most 3 slots per owner day, and none for a beach and
--                    signal that took one in the last 3 hours. UNIQUE (owner_day, slot) backs the count.
--                    State: 'queued' -> the drain (POST /api/quality/drain, run by workers/history-cron
--                    every minute) CLAIMS it with one conditional UPDATE, setting 'attempting' and a fresh
--                    attempt_id, BEFORE it calls APNs -> 'sent' (finalized only WHERE attempt_id matches),
--                    or the slot is deleted (released) when that attempt fails. An 'attempting' row older
--                    than 10 minutes is never sent again: it becomes 'unknown' (a push that may or may not
--                    have gone out), shown in the review list. Every state counts toward the day's 3 and
--                    the 3-hour repeat window. Sent and unknown rows are purged after 30 days.
--
-- quality_labels     the owner's answers, and the owner's own reports. The raw
--                    material for the golden test set and the weekly scorecard.
--                    source 'alert'  = a Right/Wrong tap on a quality_alerts row.
--                    source 'report' = "Report conditions" (no alert behind it;
--                                      verdict is NULL, correct_value is the truth).
--                    A second tap on the same alert SUPERSEDES the first: the old label
--                    keeps its row (superseded = 1) and the unique index allows one
--                    active label per alert.
--                    published_value / claimed_value / correct_value are JSON text.
--                    r2_key is the frame the label is about: the exact still kept with
--                    the alert (quality/...), else an archived frame (cam_frames.r2_key).
--
-- quality_overrides  the owner's seaweed verdict on ONE EXACT CLAIM, honored live. The target is the
--                    claim's identity: cam, frame (hash, else time) AND the time the reader scored it
--                    (claimed_at, required). It is written only when the claim was made on today's
--                    beach-local date (the date of claimed_at) and the alert was not expired; an older
--                    answer stores the label only.
--                      action 'publish'  (Right, or Wrong with a corrected level of moderate or high):
--                                         that claim publishes at `level` and its pending claim becomes
--                                         confirmed ("owner").
--                      action 'reject'   (Wrong with none, low, or no value): that claim is removed and
--                                         nothing is published for it, and the cam is DISPUTED for the
--                                         rest of the day (the reader keeps that state in the feed).
--                    One active override per alert (unique index). Of all verdicts, one merged event
--                    stream ordered by (created_at_utc, id) is replayed; the latest verdict per exact
--                    target wins (lib/quality/seaweedOverrides.ts and scripts/quality_watch.py apply the
--                    same rules, tested against lib/quality/verdictVectors.json).
--
-- owner_sessions     who the owner is. A phone enrolls once with the OWNER_ENROLL_CODE secret (in a URL
--                    fragment, so it never reaches a server log) and receives a random 32-byte token,
--                    shown once and stored here only as its SHA-256. Every owner route needs that token.
--                    One ACTIVE session per device_id (enrolling again revokes the old one), and a
--                    push_token is unique across active sessions (setting it on one session takes it
--                    from any other). `push_token` is the APNs token of the owner's phone, set through an
--                    owner route; owner pushes go only to it (never to the general devices table).
--
-- owner_enroll_attempts  the enrollment throttle: one counter per (bucket, hour), bumped by one atomic
--                    statement (INSERT ... ON CONFLICT DO UPDATE ... WHERE n < max). Buckets: an address,
--                    and 'all'. Purged after 2 days.
CREATE TABLE owner_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,     -- hex SHA-256 of the owner token
  push_token TEXT,                     -- APNs token (hex), set by /api/quality/owner/push-token
  push_updated_at TEXT,                -- ISO
  created_at TEXT NOT NULL,            -- ISO
  last_seen TEXT NOT NULL,             -- ISO, refreshed at most every 10 minutes
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))
);
CREATE INDEX owner_sessions_active ON owner_sessions(revoked, push_token);
CREATE UNIQUE INDEX owner_sessions_one_active_per_device ON owner_sessions(device_id) WHERE revoked = 0;
CREATE UNIQUE INDEX owner_sessions_push_token_unique ON owner_sessions(push_token) WHERE revoked = 0 AND push_token IS NOT NULL;

CREATE TABLE owner_enroll_attempts (
  bucket TEXT NOT NULL,                -- 'ip:<address>' or 'all'
  hour_key TEXT NOT NULL,              -- the UTC hour, e.g. 2026-10-14T16
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, hour_key)
);

CREATE TABLE quality_labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER,                    -- the alert this answers (NULL for a report)
  superseded INTEGER NOT NULL DEFAULT 0 CHECK (superseded IN (0, 1)),
  slug TEXT NOT NULL,
  signal TEXT NOT NULL CHECK (signal IN ('seaweed', 'clarity', 'surf', 'sand', 'score', 'crowd', 'other')),
  observed_at_utc TEXT NOT NULL,       -- ISO, when the thing was seen (frame time, hour, or the report moment)
  source TEXT NOT NULL CHECK (source IN ('alert', 'report')),
  published_value TEXT,                -- JSON: what the app showed
  claimed_value TEXT,                  -- JSON: what the watchdog flagged (NULL for a report)
  verdict TEXT CHECK (verdict IN ('right', 'wrong')),
  correct_value TEXT,                  -- JSON: the truth, when the owner gave it
  cam_id TEXT,
  r2_key TEXT,                         -- the frame behind the label
  frames_json TEXT,                    -- JSON array of {camId, r2Key, displayAtUtc}, for a report
  note TEXT,
  created_at TEXT NOT NULL             -- ISO
);
CREATE INDEX quality_labels_slug_signal ON quality_labels(slug, signal, observed_at_utc);
CREATE INDEX quality_labels_created ON quality_labels(created_at);
CREATE UNIQUE INDEX quality_labels_one_active_per_alert ON quality_labels(alert_id) WHERE alert_id IS NOT NULL AND superseded = 0;

CREATE TABLE quality_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  signal TEXT NOT NULL CHECK (signal IN ('seaweed', 'clarity', 'surf', 'sand', 'score', 'crowd', 'other')),
  kind TEXT NOT NULL,                  -- 'seaweed-held-disagreed' | 'hourly-jump'
  created_at TEXT NOT NULL,            -- ISO
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'expired')),
  label_id INTEGER,                    -- the active quality_labels.id once answered
  dedupe_key TEXT NOT NULL UNIQUE,
  pushed INTEGER NOT NULL DEFAULT 0 CHECK (pushed IN (0, 1))
);
CREATE INDEX quality_alerts_status_created ON quality_alerts(status, created_at);
CREATE INDEX quality_alerts_slug_signal ON quality_alerts(slug, signal, created_at);
CREATE INDEX quality_alerts_slug_created ON quality_alerts(slug, created_at);

CREATE TABLE quality_push_slots (
  alert_id INTEGER PRIMARY KEY,        -- one slot per alert
  slug TEXT NOT NULL,
  signal TEXT NOT NULL,
  owner_day TEXT NOT NULL,             -- YYYY-MM-DD, America/New_York
  slot INTEGER NOT NULL,               -- 1, 2, 3, ... within the owner day
  reserved_at TEXT NOT NULL,           -- ISO
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'attempting', 'sent', 'unknown')),
  attempt_id TEXT,                     -- set when the drain claims the slot; finalize and release must match it
  attempted_at TEXT,                   -- ISO, when it was claimed
  sent_at TEXT,                        -- ISO
  UNIQUE (owner_day, slot)
);
CREATE INDEX quality_push_slots_key ON quality_push_slots(slug, signal, reserved_at);
CREATE INDEX quality_push_slots_state ON quality_push_slots(state, reserved_at);

CREATE TABLE quality_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER NOT NULL,           -- the answered alert
  label_id INTEGER,                    -- the label written with it
  superseded INTEGER NOT NULL DEFAULT 0 CHECK (superseded IN (0, 1)),
  slug TEXT NOT NULL,
  signal TEXT NOT NULL CHECK (signal IN ('seaweed', 'clarity', 'surf', 'sand', 'score', 'crowd', 'other')),
  cam_id TEXT NOT NULL,
  -- the exact claim this verdict is about
  frame_sha TEXT,                      -- first 20 hex of the still's SHA-256 (feed cams), else NULL
  frame_at TEXT,                       -- the frame's own time (courier cams), else NULL
  claimed_at TEXT NOT NULL,            -- when the reader scored the claim (part of the exact identity)
  local_date TEXT NOT NULL,            -- beach-local date of the claim, which is also the day of the answer
  verdict TEXT NOT NULL CHECK (verdict IN ('right', 'wrong')),
  action TEXT NOT NULL CHECK (action IN ('publish', 'reject')),
  level TEXT CHECK (level IN ('none', 'low', 'moderate', 'high')),  -- the level a 'publish' puts out
  coverage_pct REAL,
  note TEXT,
  created_at_utc TEXT NOT NULL,        -- ISO, when the owner answered
  until_utc TEXT NOT NULL              -- ISO, the end of the beach-local day
);
CREATE INDEX quality_overrides_slug_until ON quality_overrides(slug, signal, until_utc);
CREATE UNIQUE INDEX quality_overrides_one_active_per_alert ON quality_overrides(alert_id) WHERE superseded = 0;
