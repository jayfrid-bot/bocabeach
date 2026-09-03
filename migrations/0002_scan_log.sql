-- QR sticker scan counter. One row per (day, source) rather than one per scan,
-- so a viral sticker costs a handful of D1 writes a day instead of thousands.
-- `source` is the ?s= tag on the short link, so different print runs or placements
-- can be told apart later without a schema change.
CREATE TABLE scan_log (
  day TEXT NOT NULL,            -- YYYY-MM-DD, America/New_York
  source TEXT NOT NULL,         -- "sticker" by default
  n INTEGER NOT NULL DEFAULT 0,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (day, source)
);
