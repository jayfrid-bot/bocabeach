-- Beach Session Live Activity server state (docs/LIVE_ACTIVITY_PLAN.md, "Server
-- and D1 model"). One row per ActivityKit activity, NOT another field on
-- `devices` — the update token is per-activity, rotates on its own schedule,
-- and a dead Live Activity token must never touch the device's normal APNs
-- token (see lib/db/d1Store.ts clearPushToken for that token's own story).
--
-- `push_token` is the per-activity ActivityKit update token. It rotates
-- (`upsertLiveActivity` replaces it atomically for the same `activity_id`)
-- and must never appear in a read API response or a log line.
--
-- `status` is 'active' | 'ended'. Only an 'active' row may receive pushes;
-- `markLiveActivityEnded` flips it and stamps `ended_at`. A row stays around
-- after ending for diagnostics (`last_apns_status`, etc.) until
-- `purgeLiveActivities` drops it, 72h later per the plan's "24-72h" window.
--
-- `last_state_json` / `last_state_hash` are the last content-state actually
-- sent (hash from lib/liveActivity/state.ts's `hashContentState`) — what the
-- next run diffs against to decide "did anything meaningful change" and
-- whether the lightning hero just turned active/escalated.
-- `pending_state_json` / `pending_since` are reserved for a coalesced-outbox
-- refinement the sender doesn't use yet. `next_send_at` IS used, as the
-- bounded fan-out's round-robin cursor (Codex review #2, lib/alerts/run.ts):
-- every pass advances it for every row it actually considered, so a run that
-- hits `LA_MAX_PER_RUN` always services the LEAST-recently-considered rows
-- first instead of starving the same tail of activities every tick.
-- `token_rotation` is the native plugin's own monotonic per-activity counter
-- (Codex review #4): a register call only replaces `push_token` when its
-- `rotation` is strictly greater than the value already on file, so an
-- out-of-order token upload (a retry racing a newer rotation) can never
-- clobber a fresher token. `last_seq` is the wire protocol's own monotonic
-- counter (Codex review #7, lib/liveActivity/state.ts / the Swift decoder):
-- every push — update or end — carries `seq = last_seq + 1`, so the phone can
-- always tell a stale/reordered push from the current one.
CREATE TABLE IF NOT EXISTS live_activities (
  activity_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  beach_slug TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  app_build TEXT,
  apns_environment TEXT,
  push_token TEXT NOT NULL,
  token_updated_at INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  last_state_json TEXT,
  last_state_hash TEXT,
  pending_state_json TEXT,
  pending_since INTEGER,
  next_send_at INTEGER,
  last_sent_at INTEGER,
  last_apns_timestamp INTEGER,
  last_apns_status INTEGER,
  token_rotation INTEGER NOT NULL DEFAULT 0,
  last_seq INTEGER NOT NULL DEFAULT 0
);

-- One active session per device, enforced as a REAL uniqueness constraint
-- (Codex review #4) — safe now that the register route supersedes the old
-- active row and upserts the new/rotated one in a single D1 batch
-- (`lib/db/d1Store.ts` `registerLiveActivity`), so there is no longer a
-- moment where a device could hold two 'active' rows across two separate
-- statements. Also still the index that makes "find the device's other
-- active rows" cheap.
CREATE UNIQUE INDEX IF NOT EXISTS idx_live_activities_active_device ON live_activities (device_id) WHERE status = 'active';

-- The due-end sweep in lib/alerts/run.ts scans for active rows past
-- expires_at every cron tick.
CREATE INDEX IF NOT EXISTS idx_live_activities_expiry ON live_activities (expires_at);

-- A push token is only ever live on ONE active activity at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_live_activities_active_token ON live_activities (push_token) WHERE status = 'active';
