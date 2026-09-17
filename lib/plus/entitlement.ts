// Is this phone entitled to Beach Day Plus, and when should it ask the server
// again? Pure — the hook in lib/plus/client.ts is a thin wrapper over these.

import type { DeviceRecord, PlusCache } from "@/lib/plus/types";

/** How long a cached entitlement is trusted before the app re-checks it. */
export const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Plus, and not expired. The same rule the server applies (`entitled()` in
 * lib/db/types.ts), read from the phone's cache so the dashboard can decide
 * what to render on the very first frame, offline included.
 */
export function isEntitled(cache: PlusCache | null, now: number): boolean {
  if (!cache || cache.plan !== "plus") return false;
  return (cache.until ?? 0) > now;
}

/**
 * Time to ask the server again.
 *
 * A phone that has NEVER talked to the server has no cache and returns false —
 * a fresh free install must not fire a request (and a 404) on every launch.
 * The first save, trial, unlock or Restore writes a cache; from then on the
 * answer is re-checked whenever it is older than six hours (or the clock moved
 * backwards, which would otherwise freeze the cache forever).
 */
export function shouldRefresh(cache: PlusCache | null, now: number): boolean {
  if (!cache) return false;
  const age = now - cache.checkedAt;
  return age >= CACHE_MAX_AGE_MS || age < 0;
}

/** The cache line for a device record the server just returned. */
export function cacheFromDevice(device: DeviceRecord, now: number): PlusCache {
  return { plan: device.plan, until: device.entitlementUntil ?? null, checkedAt: now };
}

/**
 * Whether a device record the server just returned is entitled RIGHT NOW.
 *
 * Restore and post-purchase sync must not declare success off `plan ===
 * "plus"` alone: a trial or code can leave that label on the row long after
 * `entitlementUntil` has passed, since expiry is enforced by timestamp, not by
 * clearing the plan. Built on the same `isEntitled` the rest of the app reads,
 * so there is exactly one definition of "entitled" on the phone.
 */
export function deviceEntitled(device: DeviceRecord | null, now: number): boolean {
  if (!device) return false;
  return isEntitled(cacheFromDevice(device, now), now);
}

/**
 * Is `entitlementUntil` on this device the store grant (as opposed to a trial
 * or code)? Ties go to the store — a store renewal landing the same
 * millisecond as an unrelated code is the case self-healing exists for.
 */
export function isStoreBased(device: DeviceRecord | null): boolean {
  if (!device || device.grants.storeUntil == null) return false;
  const store = device.grants.storeUntil;
  const code = device.grants.codeUntil ?? -Infinity;
  const trial = device.grants.trialUntil ?? -Infinity;
  return store >= code && store >= trial;
}

/** Only self-heal a store-based grant — a trial or code grant has nothing for
 *  RevenueCat to confirm, so re-syncing it would do nothing (or, worse, wipe
 *  it: syncPurchase only ever writes the `store_until` column). */
export const SELF_HEAL_WINDOW_MS = 48 * 60 * 60 * 1000;
/** How far back a lapse still counts as "just happened" — a webhook outage
 *  discovered days later still deserves one resync, not silence forever. */
export const SELF_HEAL_LAPSE_MS = 7 * 24 * 60 * 60 * 1000;
/** Never resync more than once in this window, even if every check qualifies. */
export const SELF_HEAL_THROTTLE_MS = 6 * 60 * 60 * 1000;

/**
 * Should the app quietly re-ask RevenueCat right now, instead of waiting for
 * the next webhook? Guards against a paying subscriber losing access to a
 * webhook outage in either direction:
 *
 *   - the grant is about to expire soon (within `SELF_HEAL_WINDOW_MS`) and a
 *     renewal webhook may simply not have arrived yet, or
 *   - the grant lapsed recently (within `SELF_HEAL_LAPSE_MS`) and the renewal
 *     that should have extended it may have been missed entirely.
 *
 * Only fires for a cache whose plan came from the store (`storeBased`) —
 * syncPurchase() only ever writes `store_until`, so re-syncing a trial or
 * code grant can't do anything for it. Throttled independently by the caller
 * passing `lastSyncedAt`, so a component re-rendering every minute doesn't
 * spam RevenueCat every minute too.
 */
export function shouldSelfHeal(input: {
  cache: PlusCache | null;
  now: number;
  storeBased: boolean;
  billingAvailable: boolean;
  lastSyncedAt: number | null;
}): boolean {
  const { cache, now, storeBased, billingAvailable, lastSyncedAt } = input;
  if (!billingAvailable || !storeBased || !cache) return false;
  if (lastSyncedAt != null && now - lastSyncedAt < SELF_HEAL_THROTTLE_MS) return false;
  const until = cache.until ?? 0;
  if (until === 0) return false; // no store grant at all — nothing to heal
  const msToExpiry = until - now;
  // About to expire: still entitled, but within the self-heal window.
  if (msToExpiry > 0 && msToExpiry <= SELF_HEAL_WINDOW_MS) return true;
  // Recently lapsed: no longer entitled, but the lapse is fresh enough that a
  // missed renewal webhook is a plausible explanation.
  if (msToExpiry <= 0 && -msToExpiry <= SELF_HEAL_LAPSE_MS) return true;
  return false;
}

/** "3 days left", "Ends today" — how long the current grant runs. */
export function entitlementRemaining(cache: PlusCache | null, now: number): string | null {
  if (!isEntitled(cache, now)) return null;
  const ms = (cache?.until ?? 0) - now;
  const days = ms / 86_400_000;
  // Rounded, not floored: a trial started seconds ago has 2.99 days on it and
  // must not read "2 days left" the moment it is bought.
  if (days >= 1) {
    const n = Math.round(days);
    return n === 1 ? "1 day left" : `${n} days left`;
  }
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  return hours === 1 ? "1 hour left" : `${hours} hours left`;
}
