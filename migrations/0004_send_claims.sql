-- Atomic send claims (#14): the concurrency guard beneath the alerts engine's
-- 30-minute dedup window. The Cloudflare cron (every 5 min) and the GitHub
-- Actions backstop (hourly) both call /api/push/run, and both can start
-- within seconds of each other. Without this table, two overlapping runs can
-- each read "not yet sent" from alert_log before either has written its mark,
-- and both send the same alert.
--
-- `key` is `<deviceId>:<alertKey>:<window>` (see lib/db/sendClaims.ts) — a
-- device+alert combination the caller is ABOUT to send. Only the caller whose
-- INSERT (or takeover UPDATE, for an abandoned claim) actually lands may send;
-- every other concurrent caller for the same key is turned away.
--
-- `sent_at` stays NULL until the send actually completes, so a run that
-- crashed or timed out mid-send leaves a claim nobody will ever finish. A
-- claim that old (see ABANDONED_CLAIM_MS) may be taken over by a later run.
CREATE TABLE send_claims (
  key TEXT PRIMARY KEY,
  claimed_at INTEGER NOT NULL,
  sent_at INTEGER
);
