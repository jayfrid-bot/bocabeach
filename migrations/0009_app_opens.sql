-- Daily active users: one row per device per day it opened the app or site.
--
-- The devices table only learns about a phone when someone saves something
-- (a home beach, a profile, alerts), so it cannot say how many people actually
-- use the app. This table can. The client posts once per calendar day
-- (lib/useAppOpenPing.ts → /api/open), and the primary key makes a repeat post
-- a no-op, so a busy day costs one write per person, not one per page view.
--
-- `id_hash` is a salted, truncated SHA-256 of the random device id — never the
-- id itself — so this table cannot be joined back to `devices` or to anything
-- else. It is enough to count distinct people per day and per week, and nothing
-- more.

CREATE TABLE app_opens (
  day TEXT NOT NULL,            -- YYYY-MM-DD, America/New_York (same as scan_log)
  id_hash TEXT NOT NULL,        -- salted, truncated hash of the device id
  platform TEXT NOT NULL,       -- "ios" | "android" | "web"
  first_at INTEGER NOT NULL,    -- epoch ms of the first open that day
  PRIMARY KEY (day, id_hash)
);

CREATE INDEX app_opens_day_platform ON app_opens (day, platform);
