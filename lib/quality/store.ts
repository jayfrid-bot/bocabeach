// D1 operations for the data-quality loop (migrations/0019_quality_loop.sql).
// Every function takes the D1 binding as an argument, so tests drive it with
// real SQLite and routes pass whatever `getD1()` found. Every statement is
// parameterized.

import type { D1Like } from "@/lib/db/d1Store";
import type { AlertKind, AlertRow, LabelRow, LabelSource, OverrideRow, QualitySignal, Verdict } from "@/lib/quality/types";

/** An open alert older than this is marked expired when the list is read. */
export const ALERT_OPEN_MS = 24 * 3_600_000;

const ALERT_COLS = "id, slug, signal, kind, created_at, payload_json, status, label_id, dedupe_key, pushed";

export interface NewAlert {
  slug: string;
  signal: QualitySignal;
  kind: AlertKind;
  createdAt: string;
  payload: unknown;
  dedupeKey: string;
}

/**
 * Store an alert. One atomic INSERT ... ON CONFLICT DO NOTHING on the unique
 * dedupe key, so a retried POST (or a re-run archive tick) never writes twice.
 * Returns the row id and whether this call created it.
 */
export async function insertAlert(db: D1Like, a: NewAlert): Promise<{ id: number; created: boolean }> {
  const inserted = await db
    .prepare(
      "INSERT INTO quality_alerts (slug, signal, kind, created_at, payload_json, status, dedupe_key, pushed) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, 'open', ?6, 0) ON CONFLICT(dedupe_key) DO NOTHING RETURNING id",
    )
    .bind(a.slug, a.signal, a.kind, a.createdAt, JSON.stringify(a.payload), a.dedupeKey)
    .first<{ id: number }>();
  if (inserted) return { id: Number(inserted.id), created: true };
  const existing = await db
    .prepare("SELECT id FROM quality_alerts WHERE dedupe_key = ?1")
    .bind(a.dedupeKey)
    .first<{ id: number }>();
  return { id: Number(existing?.id ?? 0), created: false };
}

export async function getAlert(db: D1Like, id: number): Promise<AlertRow | null> {
  return db.prepare(`SELECT ${ALERT_COLS} FROM quality_alerts WHERE id = ?1`).bind(id).first<AlertRow>();
}

export async function setAlertPushed(db: D1Like, id: number, pushed: 0 | 1): Promise<void> {
  await db.prepare("UPDATE quality_alerts SET pushed = ?2 WHERE id = ?1").bind(id, pushed).run();
}

/** Pushes sent at or after `sinceIso` (all beaches, all signals). */
export async function countPushedSince(db: D1Like, sinceIso: string): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM quality_alerts WHERE pushed = 1 AND created_at >= ?1")
    .bind(sinceIso)
    .first<{ n: number }>();
  return Number(r?.n ?? 0);
}

/** The ISO time of the newest pushed alert for this beach and signal, or null. */
export async function lastPushedAt(db: D1Like, slug: string, signal: QualitySignal): Promise<string | null> {
  const r = await db
    .prepare("SELECT MAX(created_at) AS at FROM quality_alerts WHERE pushed = 1 AND slug = ?1 AND signal = ?2")
    .bind(slug, signal)
    .first<{ at: string | null }>();
  return r?.at ?? null;
}

/** Mark open alerts older than ALERT_OPEN_MS expired. Returns how many changed. */
export async function expireOldAlerts(db: D1Like, nowMs: number): Promise<number> {
  const cutoff = new Date(nowMs - ALERT_OPEN_MS).toISOString();
  const r = await db
    .prepare("UPDATE quality_alerts SET status = 'expired' WHERE status = 'open' AND created_at < ?1")
    .bind(cutoff)
    .run();
  return r.meta?.changes ?? 0;
}

export interface AlertWithLabel extends AlertRow {
  label_verdict: Verdict | null;
  label_correct: string | null;
}

/** Newest first, each with its label's verdict and correct value when answered. */
export async function listAlerts(db: D1Like, limit: number): Promise<AlertWithLabel[]> {
  const r = await db
    .prepare(
      "SELECT a.id, a.slug, a.signal, a.kind, a.created_at, a.payload_json, a.status, a.label_id, a.dedupe_key, a.pushed, " +
        "l.verdict AS label_verdict, l.correct_value AS label_correct " +
        "FROM quality_alerts a LEFT JOIN quality_labels l ON l.id = a.label_id " +
        "ORDER BY a.created_at DESC, a.id DESC LIMIT ?1",
    )
    .bind(limit)
    .all<AlertWithLabel>();
  return r.results ?? [];
}

export interface NewLabel {
  slug: string;
  signal: QualitySignal;
  observedAt: string;
  source: LabelSource;
  published?: unknown;
  claimed?: unknown;
  verdict: Verdict | null;
  correct?: unknown;
  camId?: string | null;
  r2Key?: string | null;
  frames?: unknown;
  note?: string | null;
  createdAt: string;
}

const json = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));

export async function insertLabel(db: D1Like, l: NewLabel): Promise<number> {
  const r = await db
    .prepare(
      "INSERT INTO quality_labels (slug, signal, observed_at_utc, source, published_value, claimed_value, verdict, " +
        "correct_value, cam_id, r2_key, frames_json, note, created_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13) RETURNING id",
    )
    .bind(
      l.slug,
      l.signal,
      l.observedAt,
      l.source,
      json(l.published),
      json(l.claimed),
      l.verdict,
      json(l.correct),
      l.camId ?? null,
      l.r2Key ?? null,
      json(l.frames),
      l.note ?? null,
      l.createdAt,
    )
    .first<{ id: number }>();
  return Number(r?.id ?? 0);
}

export async function getLabel(db: D1Like, id: number): Promise<LabelRow | null> {
  return db.prepare("SELECT * FROM quality_labels WHERE id = ?1").bind(id).first<LabelRow>();
}

/** Close an alert with its label. False when it was already answered. */
export async function markAnswered(db: D1Like, alertId: number, labelId: number): Promise<boolean> {
  const r = await db
    .prepare("UPDATE quality_alerts SET status = 'answered', label_id = ?2 WHERE id = ?1 AND status != 'answered'")
    .bind(alertId, labelId)
    .run();
  return (r.meta?.changes ?? 0) > 0;
}

export async function insertOverride(
  db: D1Like,
  o: {
    slug: string;
    signal: QualitySignal;
    camId: string;
    createdAtUtc: string;
    untilUtc: string;
    labelId: number | null;
    verdict: Verdict;
    /** The claim the owner judged ({level, coveragePct, note}); a 'right' override publishes it. */
    claim?: unknown;
  },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO quality_overrides (slug, signal, cam_id, created_at_utc, until_utc, label_id, verdict, claim_json) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )
    .bind(o.slug, o.signal, o.camId, o.createdAtUtc, o.untilUtc, o.labelId, o.verdict, json(o.claim))
    .run();
}

/** Overrides for one beach and signal that have not ended at `nowMs`. */
export async function activeOverrides(db: D1Like, slug: string, signal: QualitySignal, nowMs: number): Promise<OverrideRow[]> {
  const r = await db
    .prepare(
      "SELECT id, slug, signal, cam_id, created_at_utc, until_utc, label_id, verdict, claim_json FROM quality_overrides " +
        "WHERE slug = ?1 AND signal = ?2 AND until_utc > ?3 ORDER BY id",
    )
    .bind(slug, signal, new Date(nowMs).toISOString())
    .all<OverrideRow>();
  return r.results ?? [];
}

/** The newest `beach_hourly` snapshot row before `hourUtc` for one beach, or null. */
export async function previousHourlyRow<T>(db: D1Like, cols: string, slug: string, hourUtc: string): Promise<T | null> {
  return db
    .prepare(
      `SELECT ${cols} FROM beach_hourly WHERE slug = ?1 AND row_kind = 'snapshot' AND hour_utc < ?2 ` +
        "ORDER BY hour_utc DESC LIMIT 1",
    )
    .bind(slug, hourUtc)
    .first<T>();
}

/** The newest `beach_hourly` snapshot row for a beach, or null. */
export async function latestHourlyRow<T>(db: D1Like, cols: string, slug: string): Promise<T | null> {
  return db
    .prepare(`SELECT ${cols} FROM beach_hourly WHERE slug = ?1 AND row_kind = 'snapshot' ORDER BY hour_utc DESC LIMIT 1`)
    .bind(slug)
    .first<T>();
}
