// A tiny fixed-window rate limiter on the PUSH_KV binding (shared with native
// push storage — see lib/push/nativeStore.ts for why the binding is reached
// with a static top-level import + the async form of getCloudflareContext).
//
// Used by /api/devices/unlock to slow down a brute-force guess of the shared
// unlock code: a wrong PIN is cheap to try, so this counts attempts per key
// (IP or deviceId) in a KV entry that expires on its own after the window.
//
// Not exact — KV is eventually consistent and this is read-then-write, not
// atomic — but that is fine for "slow an attacker down," which is the goal.
// Cloudflare's own edge rate limiting is a stronger defense if this app ever
// needs one; this is the zero-infra version that ships with what we already
// have.

import { getCloudflareContext } from "@opennextjs/cloudflare";

interface KVLike {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

async function getKv(): Promise<KVLike | null> {
  try {
    const ctx = await getCloudflareContext({ async: true });
    const env = ctx?.env as Record<string, unknown> | undefined;
    const kv = env?.PUSH_KV as KVLike | undefined;
    return kv && typeof kv.put === "function" ? kv : null;
  } catch {
    return null;
  }
}

// In-memory fallback for dev/tests (no Cloudflare bindings). Not shared across
// isolates, which is fine off-Cloudflare — same tradeoff every other store
// makes (see lib/db/memoryStore.ts).
const memHits = new Map<string, { count: number; resetAt: number }>();

export function resetMemoryRateLimit(): void {
  memHits.clear();
}

export interface RateLimitResult {
  limited: boolean;
  /** Seconds until the window resets — for a Retry-After header. */
  retryAfterSec: number;
}

/**
 * Count one attempt against `key` inside a `windowMs` window, capped at `max`.
 * The Nth attempt (N > max) is the one that comes back limited; the count that
 * triggered it is not "used up" again on a later, allowed attempt — a fresh
 * window starts once `windowMs` has passed since the first attempt in it.
 */
export async function checkRateLimit(key: string, max: number, windowMs: number): Promise<RateLimitResult> {
  const now = Date.now();
  const kv = await getKv();
  const storageKey = `ratelimit:${key}`;

  if (!kv) {
    const hit = memHits.get(storageKey);
    if (!hit || hit.resetAt <= now) {
      memHits.set(storageKey, { count: 1, resetAt: now + windowMs });
      return { limited: false, retryAfterSec: 0 };
    }
    hit.count += 1;
    if (hit.count > max) {
      return { limited: true, retryAfterSec: Math.ceil((hit.resetAt - now) / 1000) };
    }
    return { limited: false, retryAfterSec: 0 };
  }

  const existing = (await kv.get(storageKey, "json")) as { count: number; resetAt: number } | null;
  if (!existing || existing.resetAt <= now) {
    await kv.put(storageKey, JSON.stringify({ count: 1, resetAt: now + windowMs }), {
      expirationTtl: Math.ceil(windowMs / 1000) + 60,
    });
    return { limited: false, retryAfterSec: 0 };
  }
  const count = existing.count + 1;
  if (count > max) {
    return { limited: true, retryAfterSec: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)) };
  }
  await kv.put(storageKey, JSON.stringify({ count, resetAt: existing.resetAt }), {
    expirationTtl: Math.max(1, Math.ceil((existing.resetAt - now) / 1000) + 60),
  });
  return { limited: false, retryAfterSec: 0 };
}

/** Best-effort client IP for rate-limit keys: Cloudflare's header first, then
 *  the first X-Forwarded-For hop. Null when neither is present (local dev). */
export function clientIp(req: Request): string | null {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim() || null;
  return null;
}
