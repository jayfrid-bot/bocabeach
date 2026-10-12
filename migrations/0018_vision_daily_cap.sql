-- Per-UTC-day call counter for the Clef fallback reader (POST /api/vision/clef,
-- lib/vision/dailyCap.ts). A budget guard: a loop bug must not run up a Workers
-- AI bill.
--
-- One row per (day, model). The route takes a call with ONE statement:
--
--   INSERT INTO vision_daily_calls (day, model, count) VALUES (?, ?, 1)
--   ON CONFLICT (day, model) DO UPDATE SET count = vision_daily_calls.count + 1
--     WHERE vision_daily_calls.count < ?
--   RETURNING count
--
-- SQLite runs that statement atomically, so two concurrent calls can never
-- both take the last slot. No row comes back when the cap is already reached.
--
--   day    'YYYY-MM-DD' in UTC.
--   model  the Workers AI model id, e.g. '@cf/cloudflare/clef'.
--
-- The table gains one row a day; it needs no purge.
CREATE TABLE IF NOT EXISTS vision_daily_calls (
  day   TEXT    NOT NULL,
  model TEXT    NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (day, model)
);
