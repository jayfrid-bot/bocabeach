// D1 operations for the webcam archive index (migrations/0016_cam_frames.sql).
// Every function takes the D1 binding as an argument, so tests drive it with
// real SQLite and routes pass whatever `getD1()` found. Every statement is
// parameterized.
//
// Slot claim is atomic (docs/CAM_ARCHIVE_PLAN.md R4): one INSERT ... ON CONFLICT
// DO NOTHING, and the caller learns from `meta.changes` whether it won. There
// is never a SELECT-then-INSERT. Every claim carries a random `claim_id`. A
// pending row whose claim is older than 10 minutes (a crashed ingest) can be
// TAKEN OVER by one atomic UPDATE; finalize and rollback both match `claim_id`,
// so a stale claimant changes nothing once someone else holds the slot.
//
// Deletes use `DELETE ... WHERE rowid IN (SELECT rowid ... LIMIT n)`: D1 is
// built without SQLite's DELETE ... LIMIT, and the subselect form is the
// portable way to bound a delete.

import type { D1Like } from "@/lib/db/d1Store";

export type CamFrameState = "pending" | "ready";

export interface CamFrameRow {
  slug: string;
  cam_id: string;
  slot_utc: string;
  received_at_utc: string;
  frame_at_utc: string | null;
  display_at_utc: string;
  local_date: string;
  local_hour: number;
  local_minute: number;
  utc_offset_minutes: number;
  timezone: string;
  r2_key: string;
  bytes: number;
  sha256: string;
  source_kind: string;
  attribution: string | null;
  /** Random UUID of the ingest that holds this slot. */
  claim_id: string;
  /** ISO time of that claim; a pending claim older than STALE_CLAIM_MS can be taken over. */
  claimed_at_utc: string;
}

/** Rows deleted per statement in a purge pass. */
export const PURGE_BATCH = 5000;
/** A pending claim older than this is a crashed ingest and may be taken over. */
export const STALE_CLAIM_MS = 10 * 60_000;
/** A pending row older than this is dropped by the daily purge. */
export const PENDING_MAX_AGE_MS = 3_600_000;
/** Retention for D1 rows, measured from received_at_utc. */
export const RETENTION_DAYS = 365;

/**
 * Try to claim (slug, cam_id, slot_utc) with a `pending` row. Resolves true
 * only for the caller that now holds the slot: either its INSERT inserted, or
 * it atomically took over a pending claim older than STALE_CLAIM_MS (measured
 * against this row's own `claimed_at_utc`). Throws on a D1 error.
 */
export async function claimSlot(db: D1Like, row: CamFrameRow): Promise<boolean> {
  const inserted = await db
    .prepare(
      `INSERT INTO cam_frames (
         slug, cam_id, slot_utc, received_at_utc, frame_at_utc, display_at_utc,
         local_date, local_hour, local_minute, utc_offset_minutes, timezone,
         r2_key, bytes, sha256, source_kind, attribution, claim_id, claimed_at_utc, state
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, 'pending')
       ON CONFLICT (slug, cam_id, slot_utc) DO NOTHING`,
    )
    .bind(
      row.slug,
      row.cam_id,
      row.slot_utc,
      row.received_at_utc,
      row.frame_at_utc,
      row.display_at_utc,
      row.local_date,
      row.local_hour,
      row.local_minute,
      row.utc_offset_minutes,
      row.timezone,
      row.r2_key,
      row.bytes,
      row.sha256,
      row.source_kind,
      row.attribution,
      row.claim_id,
      row.claimed_at_utc,
    )
    .run();
  if ((inserted.meta?.changes ?? 0) === 1) return true;

  // The slot has a row. Take it over only if it is a pending claim gone stale.
  const staleBefore = new Date(Date.parse(row.claimed_at_utc) - STALE_CLAIM_MS).toISOString();
  const took = await db
    .prepare(
      `UPDATE cam_frames SET
         claim_id = ?4, claimed_at_utc = ?5, received_at_utc = ?6, frame_at_utc = ?7,
         display_at_utc = ?8, local_date = ?9, local_hour = ?10, local_minute = ?11,
         utc_offset_minutes = ?12, timezone = ?13, r2_key = ?14, bytes = ?15,
         sha256 = ?16, source_kind = ?17, attribution = ?18
       WHERE slug = ?1 AND cam_id = ?2 AND slot_utc = ?3
         AND state = 'pending' AND claimed_at_utc < ?19`,
    )
    .bind(
      row.slug,
      row.cam_id,
      row.slot_utc,
      row.claim_id,
      row.claimed_at_utc,
      row.received_at_utc,
      row.frame_at_utc,
      row.display_at_utc,
      row.local_date,
      row.local_hour,
      row.local_minute,
      row.utc_offset_minutes,
      row.timezone,
      row.r2_key,
      row.bytes,
      row.sha256,
      row.source_kind,
      row.attribution,
      staleBefore,
    )
    .run();
  return (took.meta?.changes ?? 0) === 1;
}

/**
 * SHA-256 (hex) of this cam's newest READY frame, or null when it has none.
 *
 * ADVISORY. The "unchanged" check built on this is best-effort, not a lock:
 * two ingests for DIFFERENT slots of one cam that overlap in time can each see
 * the other's frame as not-yet-ready and both store the same image. That costs
 * one duplicate frame at worst, so it is deliberately not serialized.
 */
export async function newestReadySha(db: D1Like, slug: string, camId: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT sha256 FROM cam_frames
        WHERE slug = ?1 AND cam_id = ?2 AND state = 'ready'
        ORDER BY slot_utc DESC LIMIT 1`,
    )
    .bind(slug, camId)
    .first<{ sha256: string }>();
  return row?.sha256 ?? null;
}

/** Flip OUR pending row (matched by claim_id) to ready. True when exactly it changed. */
export async function markReady(
  db: D1Like,
  slug: string,
  camId: string,
  slotUtc: string,
  claimId: string,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE cam_frames SET state = 'ready'
        WHERE slug = ?1 AND cam_id = ?2 AND slot_utc = ?3 AND claim_id = ?4 AND state = 'pending'`,
    )
    .bind(slug, camId, slotUtc, claimId)
    .run();
  return (res.meta?.changes ?? 0) === 1;
}

/**
 * Delete OUR pending row (matched by claim_id). It can never remove a ready
 * frame, nor a row another claimant now holds.
 */
export async function deletePending(
  db: D1Like,
  slug: string,
  camId: string,
  slotUtc: string,
  claimId: string,
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM cam_frames
        WHERE slug = ?1 AND cam_id = ?2 AND slot_utc = ?3 AND claim_id = ?4 AND state = 'pending'`,
    )
    .bind(slug, camId, slotUtc, claimId)
    .run();
}

export interface SlotRowState {
  state: CamFrameState;
  claim_id: string;
}

/** The row now at a slot (its state and claim), or null when there is none. Throws on a D1 error. */
export async function readSlot(db: D1Like, slug: string, camId: string, slotUtc: string): Promise<SlotRowState | null> {
  return db
    .prepare(`SELECT state, claim_id FROM cam_frames WHERE slug = ?1 AND cam_id = ?2 AND slot_utc = ?3`)
    .bind(slug, camId, slotUtc)
    .first<SlotRowState>();
}

/**
 * Cam ids of one beach whose slot is ready, or pending with a claim made
 * after `freshAfterIso`, for each of `slotUtcs`. Feeds the capture script's
 * cheap pre-check (GET /api/cam-frames/slots).
 */
export async function filledSlots(
  db: D1Like,
  slug: string,
  slotUtcs: string[],
  freshAfterIso: string,
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const s of slotUtcs) out[s] = [];
  if (slotUtcs.length === 0) return out;
  const marks = slotUtcs.map((_, i) => `?${i + 3}`).join(", ");
  const res = await db
    .prepare(
      `SELECT cam_id, slot_utc FROM cam_frames
        WHERE slug = ?1 AND slot_utc IN (${marks})
          AND (state = 'ready' OR (state = 'pending' AND claimed_at_utc >= ?2))
        ORDER BY cam_id`,
    )
    .bind(slug, freshAfterIso, ...slotUtcs)
    .all<{ cam_id: string; slot_utc: string }>();
  for (const r of res.results ?? []) out[r.slot_utc]?.push(r.cam_id);
  return out;
}

/** Delete up to `limit` pending rows received before `beforeIso`. Returns the count. */
export async function deleteStalePending(db: D1Like, beforeIso: string, limit: number = PURGE_BATCH): Promise<number> {
  const res = await db
    .prepare(
      `DELETE FROM cam_frames WHERE rowid IN (
         SELECT rowid FROM cam_frames
          WHERE state = 'pending' AND received_at_utc < ?1
          LIMIT ?2)`,
    )
    .bind(beforeIso, limit)
    .run();
  return res.meta?.changes ?? 0;
}

/** Delete up to `limit` rows (any state) received before `beforeIso`. Returns the count. */
export async function deleteReceivedBefore(db: D1Like, beforeIso: string, limit: number = PURGE_BATCH): Promise<number> {
  const res = await db
    .prepare(
      `DELETE FROM cam_frames WHERE rowid IN (
         SELECT rowid FROM cam_frames
          WHERE received_at_utc < ?1
          ORDER BY received_at_utc
          LIMIT ?2)`,
    )
    .bind(beforeIso, limit)
    .run();
  return res.meta?.changes ?? 0;
}

export interface PurgeResult {
  /** Rows older than the retention window that were deleted. */
  purgedOld: number;
  /** Pending rows older than 1 h that were deleted. */
  purgedPending: number;
  /** D1 statements used (never more than `maxStatements`). */
  statements: number;
  /** True when the batch cap stopped the loop with old rows possibly left. */
  more: boolean;
}

/**
 * The daily purge: one pass over stale pending rows, then bounded batches of
 * rows past retention until a batch comes back short or the statement cap is
 * reached. Retention uses the SERVER clock column `received_at_utc`.
 */
export async function purgeCamFrames(
  db: D1Like,
  nowMs: number,
  opts?: { maxStatements?: number; batch?: number; retentionDays?: number },
): Promise<PurgeResult> {
  const maxStatements = opts?.maxStatements ?? 10;
  const batch = opts?.batch ?? PURGE_BATCH;
  const retentionDays = opts?.retentionDays ?? RETENTION_DAYS;
  const result: PurgeResult = { purgedOld: 0, purgedPending: 0, statements: 0, more: false };
  if (maxStatements < 1) return { ...result, more: true };

  result.purgedPending = await deleteStalePending(db, new Date(nowMs - PENDING_MAX_AGE_MS).toISOString(), batch);
  result.statements += 1;

  const cutoff = new Date(nowMs - retentionDays * 86_400_000).toISOString();
  while (result.statements < maxStatements) {
    const n = await deleteReceivedBefore(db, cutoff, batch);
    result.statements += 1;
    result.purgedOld += n;
    if (n < batch) return result; // short batch: nothing left past retention
  }
  result.more = true; // cap reached on a full batch: the next daily run continues
  return result;
}
