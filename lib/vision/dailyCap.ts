// Per-UTC-day call counter for POST /api/vision/clef: a budget guard so a loop
// bug (a retry storm, a runaway workflow) cannot run up a Workers AI bill.
//
// Lives on the PUSH_KV binding, the same namespace lib/plus/rateLimit.ts uses
// (see lib/push/nativeStore.ts for why the binding is reached with a static
// top-level import + the async form of getCloudflareContext). One key per UTC
// day, `clef-daily:YYYY-MM-DD`, that expires on its own two days later.
//
// Every attempt that reaches the model counts, ok or not, because a failed call
// can still be billed. The count is read-then-write, not atomic; the capture
// script calls the route one frame at a time, so a one-or-two-call overshoot is
// the worst case and the cap is a bill guard, not a quota.
//
// No KV binding at all (plain `next dev`, tests) -> an in-memory counter. A KV
// binding that exists but throws -> FAIL CLOSED ("cap-unavailable"): a guard
// that cannot count must not wave calls through.

import { getCloudflareContext } from "@opennextjs/cloudflare";

/** Most Clef calls one UTC day may make. About 2x the expected load (300 reads/day if Clef were primary). */
export const CLEF_DAILY_CAP = 600;

interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

async function getKv(): Promise<KVLike | null> {
  try {
    const ctx = await getCloudflareContext({ async: true });
    const env = ctx?.env as Record<string, unknown> | undefined;
    const kv = env?.PUSH_KV as KVLike | undefined;
    return kv && typeof kv.put === "function" && typeof kv.get === "function" ? kv : null;
  } catch {
    return null;
  }
}

const memCounts = new Map<string, number>();

export function resetMemoryClefCap(): void {
  memCounts.clear();
}

export type ClefCapResult =
  | { allowed: true; count: number }
  | { allowed: false; reason: "daily-cap"; retryAfterSec: number }
  | { allowed: false; reason: "cap-unavailable" };

const dayKey = (nowMs: number) => `clef-daily:${new Date(nowMs).toISOString().slice(0, 10)}`;

/** Seconds until the next 00:00 UTC. */
export function secondsToUtcMidnight(nowMs: number): number {
  const d = new Date(nowMs);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - nowMs) / 1000));
}

/** Take one call from today's allowance. Denied calls are not counted. */
export async function takeClefDailySlot(nowMs: number = Date.now(), cap: number = CLEF_DAILY_CAP): Promise<ClefCapResult> {
  const key = dayKey(nowMs);
  const denied = (): ClefCapResult => ({ allowed: false, reason: "daily-cap", retryAfterSec: secondsToUtcMidnight(nowMs) });
  const kv = await getKv();
  if (!kv) {
    const n = memCounts.get(key) ?? 0;
    if (n >= cap) return denied();
    memCounts.set(key, n + 1);
    return { allowed: true, count: n + 1 };
  }
  try {
    const raw = await kv.get(key);
    const n = raw == null ? 0 : Number(raw);
    if (!Number.isFinite(n) || n < 0) return { allowed: false, reason: "cap-unavailable" }; // a corrupt counter: do not guess
    if (n >= cap) return denied();
    await kv.put(key, String(n + 1), { expirationTtl: 2 * 24 * 3600 });
    return { allowed: true, count: n + 1 };
  } catch {
    return { allowed: false, reason: "cap-unavailable" };
  }
}
