-- D1 tracks which migrations have already been applied (the `d1_migrations`
-- bookkeeping table `wrangler d1 migrations apply` maintains), so this file
-- runs exactly once per database — the two ALTER TABLE ADD COLUMN statements
-- below are NOT wrapped in an "IF NOT EXISTS" guard (SQLite has no such
-- clause for ADD COLUMN, unlike CREATE TABLE/INDEX) and rely entirely on
-- that once-only tracking to stay safe. Do not hand-run this file twice
-- against the same database outside that mechanism.
--
-- Install token identity (Codex combined-review #1). A device gets exactly
-- one install token, minted by POST /api/devices the first time it sees a
-- row with no `token_hash` yet. The raw token is handed back to the caller
-- ONCE, in that response, and never stored anywhere — only its sha256 hex
-- digest (`token_hash`) lives here, so a leaked D1 export can never be used
-- to impersonate a device. `token_issued_at` is diagnostics only.
--
-- `/api/live-activity/register`, `/end`, and `/api/hazards` require a
-- matching `x-install-token` header once a device has a hash on file; every
-- other route accepts it optionally. See lib/db/store.ts's
-- `getInstallTokenHash` / `setInstallTokenHash` for the mint/verify contract.
--
-- `token_used_at`: set once, the first time this token is ever presented and
-- verified (lib/db/installTokenAuth.ts `requireInstallToken`, shared by
-- register/end/hazards), by a single `UPDATE ... WHERE token_used_at IS
-- NULL` — cheap on every later authenticated call since it's then a no-op.
-- `token_used_at` closed a hole in a since-deleted recovery endpoint,
-- POST /api/devices/recover (round-2 #2 followup): deviceId is NOT a secret
-- (this whole system's trust model — see the top-of-file note in
-- app/api/devices/route.ts), so entitlement alone was not proof of
-- ownership — anyone who merely knew a Plus user's deviceId could have
-- called /recover, passed the RevenueCat entitlement check (keyed on the
-- same public deviceId), and minted themselves a valid token for a device
-- actively in use by someone else. That endpoint no longer exists — there is
-- no server-side recovery route today (lib/plus/client.ts's
-- `bootstrapInstallToken` doc) — but `token_used_at` stays: it is still
-- diagnostics on when a token was first actually presented, and other code
-- may key off "never used yet" again later. This file was never applied to
-- the remote database, so the column is added here rather than in a new
-- migration.
--
-- This migration still runs exactly once per database per the header note
-- above (D1's own bookkeeping) — edited in place is safe specifically
-- because nothing has applied it remotely yet.
ALTER TABLE devices ADD COLUMN token_hash TEXT;
ALTER TABLE devices ADD COLUMN token_issued_at INTEGER;
ALTER TABLE devices ADD COLUMN token_used_at INTEGER;

CREATE INDEX IF NOT EXISTS devices_token_hash ON devices(token_hash);
