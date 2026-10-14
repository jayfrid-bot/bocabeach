// The enrollment throttle, kept in D1 (migrations/0019 `owner_enroll_attempts`). One counter per
// (bucket, UTC hour), bumped by ONE atomic statement that refuses to count past the limit:
//
//   INSERT ... ON CONFLICT (bucket, hour_key) DO UPDATE SET n = n + 1 WHERE n < max
//
// so concurrent attempts cannot overwrite each other (KV's read-then-write counters could).
// Buckets: one per client address (5 an hour) and one for everybody (20 an hour). Every attempt
// counts, right or wrong; the code itself is long and random, so this only slows a guesser.

import type { D1Like } from "@/lib/db/d1Store";

export const ENROLL_PER_IP = 5;
export const ENROLL_ALL = 20;

const HOUR_MS = 3_600_000;
const RETAIN_MS = 2 * 24 * HOUR_MS;

const hourKey = (ms: number) => new Date(ms).toISOString().slice(0, 13);

export interface Throttle {
  allowed: boolean;
  retryAfterSec: number;
}

/** Count one attempt against `bucket` for this hour. `allowed` is false when the hour's limit was already used up. */
export async function consumeEnrollAttempt(db: D1Like, bucket: string, nowMs: number, max: number): Promise<Throttle> {
  const r = await db
    .prepare(
      "INSERT INTO owner_enroll_attempts (bucket, hour_key, n) VALUES (?1, ?2, 1) " +
        "ON CONFLICT(bucket, hour_key) DO UPDATE SET n = n + 1 WHERE n < ?3",
    )
    .bind(bucket, hourKey(nowMs), max)
    .run();
  const nextHour = (Math.floor(nowMs / HOUR_MS) + 1) * HOUR_MS;
  return { allowed: (r.meta?.changes ?? 0) > 0, retryAfterSec: Math.max(1, Math.ceil((nextHour - nowMs) / 1000)) };
}

/** Counters older than two days. Returns how many rows went. */
export async function purgeEnrollAttempts(db: D1Like, nowMs: number): Promise<number> {
  const r = await db
    .prepare("DELETE FROM owner_enroll_attempts WHERE hour_key < ?1")
    .bind(hourKey(nowMs - RETAIN_MS))
    .run();
  return r.meta?.changes ?? 0;
}
