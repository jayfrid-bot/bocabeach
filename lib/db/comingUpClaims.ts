// Shared constants for the "coming-up" sky-events alert ledger
// (`coming_up_deliveries`, migrations/0011_coming_up_deliveries.sql,
// docs/SKY_EVENTS_PLAN.md §10). Pure — no I/O — mirrors lib/db/sendClaims.ts's
// shape: both store backends (lib/db/d1Store.ts, lib/db/memoryStore.ts) and
// lib/alerts/comingUp.ts import these instead of hardcoding the cap numbers
// or the abandonment window in more than one place.
//
// This ledger is NOT a reuse of send_claims — `ABANDONED_CLAIM_MS` is the
// same 10-minute "the run that claimed this crashed" window, but the
// RETENTION story is different: send_claims prunes after 3 days
// (CLAIM_RETENTION_MS), too short to answer "how many sky-event pushes has
// this device had in the last 30 days." coming_up_deliveries keeps a
// successful row for the full 30-day cap window instead — see
// `COMING_UP_RETENTION_MS` below.

export { ABANDONED_CLAIM_MS } from "@/lib/db/sendClaims";

/** At most one sky-event inclusion (appended or standalone) per device per
 *  rolling 24 hours (§10's "Global caps"). */
export const COMING_UP_MAX_PER_24H = 1;

/** At most three sky-event inclusions per device per rolling 30 days. */
export const COMING_UP_MAX_PER_30D = 3;

export const COMING_UP_24H_MS = 24 * 60 * 60 * 1000;
export const COMING_UP_30D_MS = 30 * COMING_UP_24H_MS;

/** How long a SUCCESSFUL (sent) row survives before `pruneComingUp` deletes
 *  it — the ledger's own 30-day retention, distinct from send_claims' 3-day
 *  one, since the cap math needs the full 30-day history (§10). An
 *  ABANDONED (never sent) row is pruned on a much shorter clock —
 *  `ABANDONED_CLAIM_MS` — regardless of its own age. */
export const COMING_UP_RETENTION_MS = COMING_UP_30D_MS;
