-- The sticker funnel: scan → store tap → install.
--
-- scan_log (migration 0002) already counts the scan. These three tables carry
-- the two steps after it, so the growth report can say whether a sticker on a
-- lifeguard tower actually put the app on a phone.
--
-- scan_tap        one row per (day, source), same shape and the same reason as
--                 scan_log: a tap on "Get the app" costs one write a day, not
--                 one per visitor.
-- scan_claim      short-lived "someone on this network just scanned" note, used
--                 to match a later install back to the scan. `fp` is a salted,
--                 truncated hash of the client IP — never the address itself —
--                 and the row is swept once the match window has passed.
-- install_attrib  one row per device that was credited to a scan. Written at
--                 most once per device, only while the device row is minutes old.

CREATE TABLE scan_tap (
  day TEXT NOT NULL,            -- YYYY-MM-DD, America/New_York
  source TEXT NOT NULL,         -- "sticker" for a scanned session, else "web"
  n INTEGER NOT NULL DEFAULT 0,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (day, source)
);

CREATE TABLE scan_claim (
  fp TEXT PRIMARY KEY,          -- salted, truncated hash of the client IP
  source TEXT NOT NULL,
  tapped INTEGER NOT NULL DEFAULT 0,   -- 1 once they tapped through to the App Store
  at INTEGER NOT NULL,                 -- when the scan (or tap) happened
  claimed_at INTEGER                   -- set once an install has been credited to it
);
CREATE INDEX scan_claim_at ON scan_claim(at);

CREATE TABLE install_attrib (
  device_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,         -- the sticker tag the scan carried
  kind TEXT NOT NULL,           -- 'tap' = they tapped through · 'scan' = same network, same window
  at INTEGER NOT NULL
);
CREATE INDEX install_attrib_source ON install_attrib(source);
