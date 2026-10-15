// The owner-push LIMITS and the owner-push QUEUE, both kept by D1 itself
// (migrations/0019 `quality_push_slots`).
//
// RESERVING. An alert that may push takes a SLOT in one conditional INSERT, in the same batch
// as the alert's own INSERT (lib/quality/alerts.ts), so an alert never exists without its slot
// (or the reason it has none). The statement is one atomic step in D1, so two alerts arriving
// at the same moment cannot both pass the daily count or both miss the 3-hour repeat rule:
//   - at most MAX_PUSHES_PER_DAY slots per owner day (America/New_York calendar day);
//   - none for a beach and signal that took a slot in the last DEDUPE_WINDOW_MS;
//   - only for an alert that is still open and fresh (RESERVE_FRESH_MS), so a late retry of an
//     alert the owner already answered never pushes.
// UNIQUE (owner_day, slot) backs the daily count. Every state counts toward both limits.
//
// SENDING (lib/quality/drain.ts). Idempotent across overlapping drains:
//   queued    --claim (one conditional UPDATE, sets a fresh attempt_id, BEFORE APNs)--> attempting
//   attempting --finalize, only WHERE attempt_id matches--> sent
//   attempting --release, only WHERE attempt_id matches--> (row deleted: the day's push and the
//                repeat window are given back)
//   attempting for more than ATTEMPT_UNKNOWN_MS --> unknown. NEVER sent again: the first send may
//                have reached the phone. `unknown` shows in the review list.
// A drain that lost the claim race changes nothing, so a push is sent at most once.

import type { D1Like, D1Stmt } from "@/lib/db/d1Store";
import { DEDUPE_WINDOW_MS, MAX_PUSHES_PER_DAY, ownerDayKey } from "@/lib/quality/pushPolicy";
import type { AlertRow } from "@/lib/quality/types";

/** A queued slot older than this is dropped unsent: the moment has passed. */
export const QUEUED_MAX_AGE_MS = 30 * 60_000;
/** An alert older than this no longer takes a push slot, even on a retry. */
export const RESERVE_FRESH_MS = 30 * 60_000;
/** An 'attempting' slot older than this becomes 'unknown' and is never sent again. */
export const ATTEMPT_UNKNOWN_MS = 10 * 60_000;
/** Sent and unknown slot rows are purged after this long. */
export const SLOT_RETENTION_MS = 30 * 86_400_000;

export type SlotReason = "daily-cap" | "duplicate" | "closed";
export type SlotResult = { reserved: true } | { reserved: false; reason: SlotReason };

/** Which alert a reservation is for: a stored one (by id) or one in the same batch (by its dedupe key). */
export type SlotTarget = { alertId: number } | { dedupeKey: string };

/** The one conditional INSERT that takes a slot. Pure construction; run it alone or in a batch. */
export function reserveSlotStatement(db: D1Like, target: SlotTarget, a: { slug: string; signal: string }, nowMs: number): D1Stmt {
  const by = "alertId" in target ? "a.id = ?1" : "a.dedupe_key = ?1";
  const key = "alertId" in target ? target.alertId : target.dedupeKey;
  return db
    .prepare(
      "INSERT INTO quality_push_slots (alert_id, slug, signal, owner_day, slot, reserved_at, state) " +
        "SELECT a.id, ?2, ?3, ?4, (SELECT COALESCE(MAX(slot), 0) + 1 FROM quality_push_slots WHERE owner_day = ?4), ?5, 'queued' " +
        `FROM quality_alerts a WHERE ${by} AND a.status = 'open' AND a.created_at >= ?8 ` +
        "AND (SELECT COUNT(*) FROM quality_push_slots WHERE owner_day = ?4) < ?6 " +
        "AND NOT EXISTS (SELECT 1 FROM quality_push_slots WHERE slug = ?2 AND signal = ?3 AND reserved_at > ?7) " +
        "ON CONFLICT(alert_id) DO NOTHING",
    )
    .bind(
      key,
      a.slug,
      a.signal,
      ownerDayKey(nowMs),
      new Date(nowMs).toISOString(),
      MAX_PUSHES_PER_DAY,
      new Date(nowMs - DEDUPE_WINDOW_MS).toISOString(),
      new Date(nowMs - RESERVE_FRESH_MS).toISOString(),
    );
}

/** Why a reservation was refused. For the log and the caller only: the decision was made atomically. */
export async function slotRefusalReason(db: D1Like, nowMs: number): Promise<SlotReason> {
  const n = await db
    .prepare("SELECT COUNT(*) AS n FROM quality_push_slots WHERE owner_day = ?1")
    .bind(ownerDayKey(nowMs))
    .first<{ n: number }>();
  return Number(n?.n ?? 0) >= MAX_PUSHES_PER_DAY ? "daily-cap" : "duplicate";
}

export async function reservePushSlot(
  db: D1Like,
  a: { alertId: number; slug: string; signal: string },
  nowMs: number,
): Promise<SlotResult> {
  const r = await reserveSlotStatement(db, { alertId: a.alertId }, a, nowMs).run();
  if ((r.meta?.changes ?? 0) > 0) return { reserved: true };
  const open = await db.prepare("SELECT status FROM quality_alerts WHERE id = ?1").bind(a.alertId).first<{ status: string }>();
  if (open && open.status !== "open") return { reserved: false, reason: "closed" };
  return { reserved: false, reason: await slotRefusalReason(db, nowMs) };
}

/** Give a slot back: a queued one (quiet hours, stale), or the exact attempt that failed. */
export async function releaseQueuedSlot(db: D1Like, alertId: number): Promise<void> {
  await db.prepare("DELETE FROM quality_push_slots WHERE alert_id = ?1 AND state = 'queued'").bind(alertId).run();
}

export async function releaseAttempt(db: D1Like, alertId: number, attemptId: string): Promise<boolean> {
  const r = await db
    .prepare("DELETE FROM quality_push_slots WHERE alert_id = ?1 AND attempt_id = ?2 AND state = 'attempting'")
    .bind(alertId, attemptId)
    .run();
  return (r.meta?.changes ?? 0) > 0;
}

export interface ClaimedPush {
  alert: AlertRow;
  attemptId: string;
}

/**
 * Claim up to `limit` queued pushes for OPEN alerts, oldest first. Each claim is one conditional
 * UPDATE (`state = 'queued'` must still hold, and the alert must still be open), so two drains
 * can never hold the same slot: the loser's UPDATE changes nothing and it moves on.
 */
export async function claimQueuedPushes(db: D1Like, limit: number, nowMs: number): Promise<ClaimedPush[]> {
  const cands = await db
    .prepare(
      "SELECT a.id, a.slug, a.signal, a.kind, a.created_at, a.payload_json, a.status, a.label_id, a.dedupe_key, a.pushed " +
        "FROM quality_push_slots s JOIN quality_alerts a ON a.id = s.alert_id " +
        "WHERE s.state = 'queued' AND a.status = 'open' ORDER BY s.reserved_at, s.alert_id LIMIT ?1",
    )
    .bind(limit)
    .all<AlertRow>();
  const claimed: ClaimedPush[] = [];
  for (const alert of cands.results ?? []) {
    const attemptId = crypto.randomUUID();
    const r = await db
      .prepare(
        "UPDATE quality_push_slots SET state = 'attempting', attempt_id = ?2, attempted_at = ?3 " +
          "WHERE alert_id = ?1 AND state = 'queued' AND (SELECT status FROM quality_alerts WHERE id = ?1) = 'open'",
      )
      .bind(alert.id, attemptId, new Date(nowMs).toISOString())
      .run();
    if ((r.meta?.changes ?? 0) > 0) claimed.push({ alert, attemptId });
  }
  return claimed;
}

/** Mark the claimed attempt sent and its alert pushed, together. A stale attempt id changes nothing. */
export async function markPushSent(db: D1Like, alertId: number, attemptId: string, nowMs: number): Promise<void> {
  const at = new Date(nowMs).toISOString();
  const stmts = [
    db
      .prepare("UPDATE quality_push_slots SET state = 'sent', sent_at = ?3 WHERE alert_id = ?1 AND attempt_id = ?2 AND state = 'attempting'")
      .bind(alertId, attemptId, at),
    db
      .prepare(
        "UPDATE quality_alerts SET pushed = 1 WHERE id = ?1 AND EXISTS " +
          "(SELECT 1 FROM quality_push_slots WHERE alert_id = ?1 AND attempt_id = ?2 AND state = 'sent')",
      )
      .bind(alertId, attemptId),
  ];
  if (typeof db.batch === "function") await db.batch(stmts);
  else for (const s of stmts) await s.run();
}

/** Attempts that have been 'attempting' too long become 'unknown'. They are never sent again. Returns how many. */
export async function markStaleAttempts(db: D1Like, nowMs: number): Promise<number> {
  const r = await db
    .prepare("UPDATE quality_push_slots SET state = 'unknown' WHERE state = 'attempting' AND attempted_at < ?1")
    .bind(new Date(nowMs - ATTEMPT_UNKNOWN_MS).toISOString())
    .run();
  return r.meta?.changes ?? 0;
}

/** Queued slots reserved before `cutoffMs` are deleted unsent. Returns how many. */
export async function dropStaleSlots(db: D1Like, cutoffMs: number): Promise<number> {
  const r = await db
    .prepare("DELETE FROM quality_push_slots WHERE state = 'queued' AND reserved_at < ?1")
    .bind(new Date(cutoffMs).toISOString())
    .run();
  return r.meta?.changes ?? 0;
}

/** Queued slots whose alert is no longer open (the owner already answered it) are deleted unsent. */
export async function dropClosedAlertSlots(db: D1Like): Promise<number> {
  const r = await db
    .prepare(
      "DELETE FROM quality_push_slots WHERE state = 'queued' AND alert_id IN (SELECT id FROM quality_alerts WHERE status != 'open')",
    )
    .run();
  return r.meta?.changes ?? 0;
}

/** Sent and unknown slot rows older than SLOT_RETENTION_MS. Returns how many were deleted. */
export async function purgeOldSlots(db: D1Like, nowMs: number): Promise<number> {
  const r = await db
    .prepare("DELETE FROM quality_push_slots WHERE state IN ('sent', 'unknown') AND reserved_at < ?1")
    .bind(new Date(nowMs - SLOT_RETENTION_MS).toISOString())
    .run();
  return r.meta?.changes ?? 0;
}
