// Small shared pieces of the Plus backend that the API routes need but cannot
// export themselves — a Next.js route file may only export its HTTP handlers and
// the route config, so every constant and helper lives here instead.

import { SAFETY_ALERT_KEYS, type DeviceRecord } from "@/lib/db/types";

/** Length of the one free trial a device gets (`POST /api/devices/trial`). */
export const TRIAL_DAYS = 3;

/** Length of the grant a redeemed unlock code buys (`POST /api/devices/unlock`). */
export const UNLOCK_DAYS = 365;

/** Longest a single presence arm lasts. Manual "heading to the beach" asks 6 h. */
export const MAX_ARM_MS = 8 * 3600 * 1000;

/** Which channels one `/api/push/run` may send. `all` = the scheduled behavior. */
export type RunMode = "all" | "morning" | "safety";

export function parseMode(raw: string | null): RunMode {
  return raw === "morning" || raw === "safety" ? raw : "all";
}

/**
 * The push decision logic still speaks the two coarse switches the old KV record
 * carried. `morning` is its own alert key; `safety` is on when the device wants
 * any hazard alert at all.
 */
export function coarsePrefs(device: DeviceRecord): { morning: boolean; safety: boolean } {
  return {
    morning: device.prefs.morning,
    safety: SAFETY_ALERT_KEYS.some((k) => device.prefs[k]),
  };
}
