// Shared constants + the key format for the atomic send claim (#14, schema in
// migrations/0004_send_claims.sql). Pure — no I/O, so it is safe for both
// backends and the callers in lib/alerts/run.ts and app/api/push/run/route.ts
// to import without reaching into either store's internals.
//
// A claim's `key` is always `<deviceId>:<alertKey>:<window>`:
//  - at-beach hazards: `alertKey` is the decision's dedupKey (not the coarser
//    catalog key) — that is the granularity the 30-min repeat window already
//    keys on (lib/alerts/dedup.ts), so a lightning escalation still claims
//    its OWN key and is never blocked by the plain alert's claim in the same
//    window. `window` is that repeat window, floor(now / repeatMs).
//  - the morning digest: `alertKey` is "morning", `window` is the beach-local
//    calendar date (it fires at most once a day).
//  - "just turned Excellent": `alertKey` is "score-excellent", `window` is
//    the same beach-local date its dedup key already carries.

/** A claim with no `sent_at` after this long is assumed abandoned — the run
 *  that made it crashed or timed out mid-send — and may be re-claimed. */
export const ABANDONED_CLAIM_MS = 10 * 60 * 1000;

/** Claims older than this can never be re-claimed or matter again; the run
 *  prunes them opportunistically so the table doesn't grow forever. */
export const CLAIM_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

/** Build one claim key. Pure string formatting — see the module comment. */
export function sendClaimKey(deviceId: string, alertKey: string, window: string | number): string {
  return `${deviceId}:${alertKey}:${window}`;
}

/** The at-beach claim's window: the same 30-min (or hazard-specific) repeat
 *  bucket the dedup window already uses, so the claim and the durable dedup
 *  mark agree on when a "new" send is allowed. */
export function repeatWindow(nowMs: number, repeatMs: number): number {
  return Math.floor(nowMs / repeatMs);
}
