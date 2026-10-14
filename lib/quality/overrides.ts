// Server-side loader for the seaweed overrides (lib/quality/seaweedOverrides.ts
// has the rules). Kept apart from that file because this one reaches D1, and the
// dashboard (a client bundle) imports lib/sources/sargassum.ts.

import { getD1 } from "@/lib/db/d1Store";
import { activeOverrides } from "@/lib/quality/store";
import type { SeaweedOverride } from "@/lib/quality/seaweedOverrides";
import type { OverrideRow } from "@/lib/quality/types";

/** One stored override as the pure code and the reader see it. */
export function overrideFromRow(r: OverrideRow): SeaweedOverride {
  let claim: SeaweedOverride["claim"] = null;
  try {
    if (r.claim_json) claim = JSON.parse(r.claim_json) as SeaweedOverride["claim"];
  } catch {
    claim = null;
  }
  return { camId: r.cam_id, verdict: r.verdict === "right" ? "right" : "wrong", createdAtUtc: r.created_at_utc, untilUtc: r.until_utc, claim };
}

/** Running seaweed overrides for one beach. Any failure (no database, a query error) is "none". */
export async function loadSeaweedOverrides(slug: string, nowMs: number = Date.now()): Promise<SeaweedOverride[]> {
  try {
    const db = await getD1();
    if (!db) return [];
    const rows = await activeOverrides(db, slug, "seaweed", nowMs);
    return rows.map(overrideFromRow);
  } catch (e) {
    console.error("quality: loading seaweed overrides failed", slug, e);
    return [];
  }
}
