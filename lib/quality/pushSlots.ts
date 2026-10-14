// The owner-push LIMITS, enforced by D1 itself (migrations/0019 `quality_push_slots`).
//
// An alert that may push takes a SLOT in one conditional INSERT. The statement is one
// atomic step in D1, so two alerts arriving at the same moment cannot both pass the
// daily count or both miss the 3-hour repeat rule:
//   - at most MAX_PUSHES_PER_DAY slots per owner day (America/New_York calendar day);
//   - none for a beach and signal that took a slot in the last DEDUPE_WINDOW_MS.
// UNIQUE (owner_day, slot) backs the daily count. A slot is 'queued' until the drain step
// sends it ('sent'); a send that fails deletes the slot, which gives the day's push and the
// repeat window back. The rules a slot answers to are the pure ones in pushPolicy.ts.

import type { D1Like } from "@/lib/db/d1Store";
import { DEDUPE_WINDOW_MS, MAX_PUSHES_PER_DAY, ownerDayKey } from "@/lib/quality/pushPolicy";
import type { AlertRow } from "@/lib/quality/types";

/** A queued slot older than this is dropped unsent: the moment has passed. */
export const QUEUED_MAX_AGE_MS = 30 * 60_000;

export type SlotResult = { reserved: true } | { reserved: false; reason: "daily-cap" | "duplicate" };

export async function reservePushSlot(
  db: D1Like,
  a: { alertId: number; slug: string; signal: string },
  nowMs: number,
): Promise<SlotResult> {
  const day = ownerDayKey(nowMs);
  const r = await db
    .prepare(
      "INSERT INTO quality_push_slots (alert_id, slug, signal, owner_day, slot, reserved_at, state) " +
        "SELECT ?1, ?2, ?3, ?4, (SELECT COALESCE(MAX(slot), 0) + 1 FROM quality_push_slots WHERE owner_day = ?4), ?5, 'queued' " +
        "WHERE (SELECT COUNT(*) FROM quality_push_slots WHERE owner_day = ?4) < ?6 " +
        "AND NOT EXISTS (SELECT 1 FROM quality_push_slots WHERE slug = ?2 AND signal = ?3 AND reserved_at > ?7) " +
        "ON CONFLICT(alert_id) DO NOTHING",
    )
    .bind(
      a.alertId,
      a.slug,
      a.signal,
      day,
      new Date(nowMs).toISOString(),
      MAX_PUSHES_PER_DAY,
      new Date(nowMs - DEDUPE_WINDOW_MS).toISOString(),
    )
    .run();
  if ((r.meta?.changes ?? 0) > 0) return { reserved: true };
  // Why not: only for the log and the caller. The decision above was already made atomically.
  const n = await db
    .prepare("SELECT COUNT(*) AS n FROM quality_push_slots WHERE owner_day = ?1")
    .bind(day)
    .first<{ n: number }>();
  return { reserved: false, reason: Number(n?.n ?? 0) >= MAX_PUSHES_PER_DAY ? "daily-cap" : "duplicate" };
}

/** Give a slot back (a failed send, or a queued push that went stale). */
export async function releasePushSlot(db: D1Like, alertId: number): Promise<void> {
  await db.prepare("DELETE FROM quality_push_slots WHERE alert_id = ?1").bind(alertId).run();
}

export interface QueuedPush {
  alert: AlertRow;
  reservedAt: string;
}

/** Slots waiting to be sent, oldest first, with their alerts. */
export async function queuedPushes(db: D1Like, limit: number): Promise<QueuedPush[]> {
  const r = await db
    .prepare(
      "SELECT a.id, a.slug, a.signal, a.kind, a.created_at, a.payload_json, a.status, a.label_id, a.dedupe_key, a.pushed, " +
        "s.reserved_at AS reserved_at FROM quality_push_slots s JOIN quality_alerts a ON a.id = s.alert_id " +
        "WHERE s.state = 'queued' ORDER BY s.reserved_at, s.alert_id LIMIT ?1",
    )
    .bind(limit)
    .all<AlertRow & { reserved_at: string }>();
  return (r.results ?? []).map(({ reserved_at, ...alert }) => ({ alert, reservedAt: reserved_at }));
}

/** Mark a slot sent and its alert pushed, together. */
export async function markPushSent(db: D1Like, alertId: number, nowMs: number): Promise<void> {
  const at = new Date(nowMs).toISOString();
  const stmts = [
    db.prepare("UPDATE quality_push_slots SET state = 'sent', sent_at = ?2 WHERE alert_id = ?1").bind(alertId, at),
    db.prepare("UPDATE quality_alerts SET pushed = 1 WHERE id = ?1").bind(alertId),
  ];
  if (typeof db.batch === "function") await db.batch(stmts);
  else for (const s of stmts) await s.run();
}

/** Queued slots reserved before `cutoffMs` are deleted unsent. Returns how many. */
export async function dropStaleSlots(db: D1Like, cutoffMs: number): Promise<number> {
  const r = await db
    .prepare("DELETE FROM quality_push_slots WHERE state = 'queued' AND reserved_at < ?1")
    .bind(new Date(cutoffMs).toISOString())
    .run();
  return r.meta?.changes ?? 0;
}
