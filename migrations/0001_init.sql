-- Beach Day Plus — initial schema (D1 `isitbeachday-plus`, binding DB).
--
-- devices   one row per install, keyed by the client-minted deviceId (localStorage
--           `bd:device-id`). Legacy KV push subscriptions land here as
--           id = "legacy:" + base64url(pushToken) until the app re-registers with
--           a real deviceId. `sent_json` carries the push dedup state that used to
--           live on the KV record.
-- presence  at most one armed "I'm at the beach" window per device; safety alerts
--           only go to devices with a live row here.
-- alert_log per-device, per-alert-key dedup for the alerts engine.

CREATE TABLE devices (
  id TEXT PRIMARY KEY, platform TEXT, push_token TEXT, tz TEXT, home_slug TEXT,
  profile_json TEXT, prefs_json TEXT,
  plan TEXT NOT NULL DEFAULT 'free', entitlement_until INTEGER,
  trial_used INTEGER NOT NULL DEFAULT 0, preview_seen INTEGER NOT NULL DEFAULT 0,
  sent_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX devices_push_token ON devices(push_token);
CREATE INDEX devices_home_slug ON devices(home_slug);
CREATE TABLE presence (
  device_id TEXT PRIMARY KEY, slug TEXT NOT NULL, lat REAL, lon REAL, accuracy_m REAL,
  fix_at INTEGER, armed_until INTEGER NOT NULL, source TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE alert_log (
  device_id TEXT NOT NULL, alert_key TEXT NOT NULL, sent_at INTEGER NOT NULL, meta_json TEXT,
  PRIMARY KEY (device_id, alert_key)
);
