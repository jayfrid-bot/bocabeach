// Bridging the old KV push store into the device table.
//
// Before Plus, a push subscription WAS the account: one KV record per device
// token, carrying the beach, the timezone, two coarse prefs and the dedup state.
// Those rows are imported into `devices` under a synthetic id so today's
// subscribers keep getting their morning summary while the app catches up and
// starts sending a real `deviceId`.
//
// Kept in its own module (not store.ts) so the backends can use it without an
// import cycle.

import type { NativeSub } from "@/lib/push/nativeStore";
import { tokenKey } from "@/lib/push/nativeStore";
import type { AlertPrefs, DevicePatch } from "@/lib/db/types";
import { SAFETY_ALERT_KEYS } from "@/lib/db/types";

/** Device id for a legacy KV subscription that has no client-minted deviceId. */
export function legacyDeviceId(token: string): string {
  return `legacy:${tokenKey(token)}`;
}

/** True for an id minted by `legacyDeviceId`. */
export function isLegacyId(id: string): boolean {
  return id.startsWith("legacy:");
}

/**
 * Map the legacy two-switch push prefs onto the full alert set: `morning` drives
 * the morning digest, `safety` drives every hazard alert. Keys outside both sets
 * keep their default (on).
 */
export function prefsFromLegacy(legacy: {
  morning?: boolean;
  safety?: boolean;
}): Partial<AlertPrefs> {
  const out: Partial<AlertPrefs> = {};
  if (typeof legacy.morning === "boolean") out.morning = legacy.morning;
  if (typeof legacy.safety === "boolean") {
    for (const k of SAFETY_ALERT_KEYS) out[k] = legacy.safety;
  }
  return out;
}

/** The patch that turns one legacy KV subscription into a device row. */
export function legacyPatch(sub: NativeSub): DevicePatch {
  return {
    platform: sub.platform,
    pushToken: sub.token,
    tz: sub.tz ?? null,
    homeSlug: sub.slug ?? null,
    prefs: prefsFromLegacy(sub.prefs ?? {}),
    plan: "free",
    sent: sub.sent ?? {},
  };
}
