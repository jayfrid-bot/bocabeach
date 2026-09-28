-- The "coming-up" sky-events alert ledger (docs/SKY_EVENTS_PLAN.md §10,
-- lib/db/comingUpClaims.ts). NOT a reuse of `send_claims`
-- (migrations/0004_send_claims.sql) — that table prunes after 3 days, too
-- short to answer "how many sky-event pushes has this device had in the
-- last 30 days." One row per (device_id, event_key) EVER — the pair is
-- UNIQUE (the primary key), which is also half of the once-ever dedupe:
-- the other half is `alert_log` (migrations/0001_init.sql), which survives
-- this table being pruned.
--
-- `event_key` is one of the five dedupe keys SKY_EVENTS_PLAN.md §10 defines:
-- `tide:<station>:<episode-start>`, `eclipse:<peak-iso>`,
-- `meteor:<shower>:<year>`, `supermoon:<full-moon-iso>`, `launch:<ll2-uuid>`
-- — the SAME string `lib/alerts/catalog.ts` uses as the `alert_log.alert_key`
-- once the send is confirmed (see `completeComingUp`), so the two tables'
-- dedupe can never disagree about which underlying event a device was told
-- about.
--
-- `status` is 'reserved' (claimed, not yet confirmed sent) or 'sent'
-- (confirmed — `sent_at` is then non-null). `claim_token` guards
-- `completeComingUp`/`releaseComingUp`: only the caller holding the CURRENT
-- token for this row may finalize or clear it, so a stale claimant that lost
-- a race to a newer claim (an abandoned reservation reclaimed by a later
-- run) can never finalize or clear someone else's.
--
-- Pruning (`pruneComingUp`, lib/db/store.ts) removes two kinds of row:
-- successful ('sent') rows older than `COMING_UP_RETENTION_MS` (30 days —
-- the cap math needs the full window), and abandoned UNSENT rows
-- (`sent_at IS NULL` and `claimed_at` older than `ABANDONED_CLAIM_MS`, 10
-- min) regardless of age, so a crashed reservation never sits forever.
CREATE TABLE coming_up_deliveries (
  device_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  claim_token TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  sent_at INTEGER,
  status TEXT NOT NULL DEFAULT 'reserved',
  PRIMARY KEY (device_id, event_key)
);

-- The cap-window scans (`claimComingUp`'s 24h/30d COUNT subqueries, and
-- `pruneComingUp`) both filter by device_id first — a per-device index keeps
-- both cheap as the table grows.
CREATE INDEX idx_coming_up_deliveries_device ON coming_up_deliveries (device_id);
