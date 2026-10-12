// Per-UTC-day call counter for POST /api/vision/clef: a budget guard so a loop
// bug (a retry storm, a runaway workflow) cannot run up a Workers AI bill.
//
// The counter is a row in D1 (`vision_daily_calls`, migrations/0018) taken with
// ONE atomic statement:
//
//   INSERT ... VALUES (day, model, 1)
//   ON CONFLICT (day, model) DO UPDATE SET count = count + 1 WHERE count < cap
//   RETURNING count
//
// A row comes back when a slot was taken; no row means the cap is spent. Two
// concurrent calls cannot both take the last slot. (A KV get-then-put counter
// could, which is why this is not KV.)
//
// FAIL CLOSED. No DB binding, or any error from it -> "cap-unavailable" and the
// route answers 503 without calling the model. A guard that cannot count must
// not wave calls through. There is deliberately no in-memory fallback: tests
// use a real SQLite database with the migration applied.
//
// Every attempt that reaches the model counts, ok or not, because a failed call
// can still be billed.

import type { D1Like } from "@/lib/db/d1Store";
import { CLEF_MODEL } from "@/lib/vision/clef";

/**
 * Most Clef calls one UTC day may make. Estimated worst-case fallback load is
 * about 420 calls a day (the longest summer day, when Gemini's two daily
 * buckets run out); 600 leaves 43% headroom over that and still stops a runaway.
 */
export const CLEF_DAILY_CAP = 600;

export type ClefCapResult =
  | { allowed: true; count: number }
  | { allowed: false; reason: "daily-cap"; retryAfterSec: number }
  | { allowed: false; reason: "cap-unavailable" };

export const TAKE_SLOT_SQL =
  "INSERT INTO vision_daily_calls (day, model, count) VALUES (?, ?, 1) " +
  "ON CONFLICT (day, model) DO UPDATE SET count = vision_daily_calls.count + 1 " +
  "WHERE vision_daily_calls.count < ? " +
  "RETURNING count";

const dayKey = (nowMs: number) => new Date(nowMs).toISOString().slice(0, 10);

/** Seconds until the next 00:00 UTC. */
export function secondsToUtcMidnight(nowMs: number): number {
  const d = new Date(nowMs);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - nowMs) / 1000));
}

/** Take one call from today's allowance. Denied calls are not counted. */
export async function takeClefDailySlot(
  db: D1Like | null,
  nowMs: number = Date.now(),
  cap: number = CLEF_DAILY_CAP,
  model: string = CLEF_MODEL,
): Promise<ClefCapResult> {
  if (!db) return { allowed: false, reason: "cap-unavailable" };
  try {
    const row = await db.prepare(TAKE_SLOT_SQL).bind(dayKey(nowMs), model, cap).first<{ count: number }>();
    if (!row) return { allowed: false, reason: "daily-cap", retryAfterSec: secondsToUtcMidnight(nowMs) };
    const count = Number(row.count);
    if (!Number.isFinite(count) || count < 1) return { allowed: false, reason: "cap-unavailable" };
    return { allowed: true, count };
  } catch {
    return { allowed: false, reason: "cap-unavailable" };
  }
}
