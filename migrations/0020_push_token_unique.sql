-- One device row per push token (push-token-auth).
--
-- Moving a push token between rows (a reinstall that gets a new device id but
-- keeps its APNs/FCM token) used to be two separate writes, and the index on
-- push_token (0001) was not unique, so two racing registrations could leave two
-- rows holding the same token: both got pushes, and findByPushToken picked one
-- at random. The route now moves a token in ONE batch (detach from the other
-- rows, attach to this one), and this unique index makes a second holder
-- impossible instead of merely unlikely.
--
-- First, clear any duplicates that already exist. For every push_token held by
-- more than one row, the row that changed most recently keeps it (the phone
-- that registered last is the one that has it now; ties go to the smaller id so
-- the result is deterministic). The others lose the token only — their record
-- (profile, Plus grants, prefs) is untouched, and they stop being a push
-- destination, which is what they already were in practice.
UPDATE devices
SET push_token = NULL
WHERE push_token IS NOT NULL
  AND id NOT IN (
    SELECT id FROM (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY push_token
               ORDER BY COALESCE(updated_at, 0) DESC, id ASC
             ) AS rn
      FROM devices
      WHERE push_token IS NOT NULL
    )
    WHERE rn = 1
  );

DROP INDEX IF EXISTS devices_push_token;
-- Re-runnable: a local database that applied this file under its earlier name (0019)
-- already has the index.
DROP INDEX IF EXISTS devices_push_token_unique;
CREATE UNIQUE INDEX devices_push_token_unique ON devices(push_token) WHERE push_token IS NOT NULL;
