// The owner-override fingerprint query, kept in a file with NO imports so two bundles can share
// it: the Next app (lib/quality/overrides.ts, the conditions cache key) and the Worker entry's
// edge cache (lib/edgeCache.ts, bundled by wrangler outside Next). Both must compute the same
// value for the same rows, or a page cached at the edge would not follow an owner correction.

/**
 * Running seaweed verdicts for one beach: ?1 = slug, ?2 = the clock as an ISO string. The same
 * rows as `activeOverrides` (lib/quality/store.ts), superseded ones excluded: a later answer that
 * supersedes a verdict without a new one must still change the fingerprint.
 */
export const OVERRIDES_FINGERPRINT_SQL =
  "SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS maxId FROM quality_overrides " +
  "WHERE slug = ?1 AND signal = 'seaweed' AND until_utc > ?2 AND superseded = 0";

/** "0" when no verdict is running, else "<count>.<highest id>". */
export function fingerprintFromRow(r: { n: number; maxId: number } | null | undefined): string {
  return r && Number(r.n) > 0 ? `${r.n}.${r.maxId}` : "0";
}
