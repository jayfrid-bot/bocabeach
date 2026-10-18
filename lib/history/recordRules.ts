// Guards for the all-time water records (lib/db/d1Store.ts HISTORY_RECORDS_UNION
// and the memory store twin). Records last forever, so one bad reading must not
// be able to hold one. Shared so the SQL text and the in-memory mirror agree.

/** A water temperature outside this range (°F) is a sensor glitch, not a record. */
export const WATER_TEMP_MIN_F = 45;
export const WATER_TEMP_MAX_F = 95;

/** Clarity reads before this local date are not trusted: the cam low-sun fix
 *  landed on 2026-10-13, and earlier reads in low light were wrong. */
export const CLARITY_TRUSTED_FROM = "2026-10-13";

/** A water record needs its value (or a higher plausible one) in at least this
 *  many distinct archived hours of the same beach-local day. One stray hour
 *  cannot set it. */
export const WATER_RECORD_MIN_HOURS = 2;
