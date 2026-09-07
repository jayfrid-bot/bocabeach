-- Split "when does Plus end" into three independent grant sources, so a store
-- purchase, an unlock code, and the free trial can never step on each other
-- (#4: a Restore used to unconditionally overwrite a longer code grant, and
-- the trial route did the same to whatever was already there).
--
-- Effective access is the latest (max) of the three. `entitlement_until` keeps
-- holding that derived value on every write from here on, so every existing
-- read of it (listArmed's SQL filter, entitled(), the API response) keeps
-- working unchanged.
ALTER TABLE devices ADD COLUMN store_until INTEGER;
ALTER TABLE devices ADD COLUMN code_until INTEGER;
ALTER TABLE devices ADD COLUMN trial_until INTEGER;

-- Backfill: every existing row already on Plus with a still-future expiry got
-- there through an unlock code or the 3-day trial — billing only just went
-- live, so no row can hold a real store purchase yet. Put that expiry on
-- code_until, the long-lived "granted by us" bucket; `trial_used` already
-- remembers on its own whether the free trial was spent, independent of this.
UPDATE devices
SET code_until = entitlement_until
WHERE plan = 'plus'
  AND entitlement_until IS NOT NULL
  AND entitlement_until > (CAST(strftime('%s', 'now') AS INTEGER) * 1000);
