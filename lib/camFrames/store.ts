// D1 operations for the webcam archive index (migrations/0016_cam_frames.sql).
// Every function takes the D1 binding as an argument, so tests drive it with
// real SQLite and routes pass whatever `getD1()` found. Every statement is
// parameterized.
//
// Slot claim is atomic (docs/CAM_ARCHIVE_PLAN.md R4): one INSERT ... ON CONFLICT
// DO NOTHING, and the caller learns from `meta.changes` whether it won. There
// is never a SELECT-then-INSERT.
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
}

/** Rows deleted per statement in a purge pass. */
export const PURGE_BATCH = 5000;
/** A pending row older than this is a crashed ingest. */
export const PENDING_MAX_AGE_MS = 3_600_000;
/** Retention for D1 rows, measured from received_at_utc. */
export const RETENTION_DAYS = 365;

/**
 * Try to claim (slug, cam_id, slot_utc) with a `pending` row. Resolves true
 * only for the caller whose INSERT actually inserted. Throws on a D1 error.
 */
export async function claimSlot(db: D1Like, row: CamFrameRow): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT INTO cam_frames (
         slug, cam_id, slot_utc, received_at_utc, frame_at_utc, display_at_utc,
         local_date, local_hour, local_minute, utc_offset_minutes, timezone,
         r2_key, bytes, sha256, source_kind, attribution, state
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 'pending')
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
    )
    .run();
  return (res.meta?.changes ?? 0) === 1;
}

/** SHA-256 (hex) of this cam's newest READY frame, or null when it has none. */
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

/** Flip our pending row to ready. True when exactly our row changed. */
export async function markReady(
  db: D1Like,
  slug: string,
  camId: string,
  slotUtc: string,
  r2Key: string,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE cam_frames SET state = 'ready'
        WHERE slug = ?1 AND cam_id = ?2 AND slot_utc = ?3 AND r2_key = ?4 AND state = 'pending'`,
    )
    .bind(slug, camId, slotUtc, r2Key)
    .run();
  return (res.meta?.changes ?? 0) === 1;
}

/**
 * Delete our own pending row. Matches on the r2 key too and on state, so it
 * can never remove a ready frame or another caller's claim.
 */
export async function deletePending(
  db: D1Like,
  slug: string,
  camId: string,
  slotUtc: string,
  r2Key: string,
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM cam_frames
        WHERE slug = ?1 AND cam_id = ?2 AND slot_utc = ?3 AND r2_key = ?4 AND state = 'pending'`,
    )
    .bind(slug, camId, slotUtc, r2Key)
    .run();
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
