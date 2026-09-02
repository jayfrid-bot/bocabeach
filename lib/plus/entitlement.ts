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
