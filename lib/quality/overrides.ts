// Server-side loader for the seaweed overrides (lib/quality/seaweedOverrides.ts has the
// rules). Kept apart from that file because this one reaches D1, and the dashboard (a
// client bundle) imports lib/sources/sargassum.ts.

import { getD1, type D1Like } from "@/lib/db/d1Store";
import { activeOverrides } from "@/lib/quality/store";
import type { SeaweedOverride } from "@/lib/quality/seaweedOverrides";
import type { OverrideRow } from "@/lib/quality/types";

/** One stored override as the pure code and the reader see it. */
export function overrideFromRow(r: OverrideRow): SeaweedOverride {
  return {
    id: r.id,
    camId: r.cam_id,
    verdict: r.verdict,
    action: r.action,
    level: r.level,
    coveragePct: r.coverage_pct,
    note: r.note,
    frameSha: r.frame_sha,
    frameAt: r.frame_at,
    claimedAt: r.claimed_at,
    localDate: r.local_date,
    createdAtUtc: r.created_at_utc,
    untilUtc: r.until_utc,
  };
}

/** Running seaweed overrides for one beach. Any failure (no database, a query error) is "none". */
export async function loadSeaweedOverrides(slug: string, nowMs: number = Date.now()): Promise<SeaweedOverride[]> {
  try {
    const db = await getD1();
    if (!db) return [];
    return (await activeOverrides(db, slug, "seaweed", nowMs)).map(overrideFromRow);
  } catch (e) {
    console.error("quality: loading seaweed overrides failed", slug, e);
    return [];
  }
}

/**
 * A short fingerprint of the verdicts in force for a beach, part of the conditions cache
 * key (lib/conditions.ts): when the owner answers, the fingerprint changes and the next
 * request builds a fresh snapshot instead of serving the cached one. "0" when there are none
 * or the database cannot be reached.
 */
export async function overridesVersion(slug: string, db?: D1Like | null, nowMs: number = Date.now()): Promise<string> {
  try {
    const d = db === undefined ? await getD1() : db;
    if (!d) return "0";
    const r = await d
      .prepare(
        "SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS maxId FROM quality_overrides " +
          "WHERE slug = ?1 AND signal = 'seaweed' AND until_utc > ?2",
      )
      .bind(slug, new Date(nowMs).toISOString())
      .first<{ n: number; maxId: number }>();
    return r && Number(r.n) > 0 ? `${r.n}.${r.maxId}` : "0";
  } catch {
    return "0";
  }
}
