// Pure decision table for whether a Beach Session Live Activity gets a push
// THIS run (docs/LIVE_ACTIVITY_PLAN.md "Update budget and frequent updates" +
// "One evaluation pipeline"). No I/O — lib/alerts/run.ts owns the D1
// send-claim and the actual APNs call; this only decides yes/no/why/how
// urgently, so the table itself is a plain function test, not a store/APNs
// integration test.
//
// The table, in priority order:
//   1. Lightning just turned active, or escalated to the close radius →
//      send immediately, priority 10 (bypasses the debounce below).
//   2. Else if the content changed AND it's been >= 60s since the last send
//      → send, priority 5.
//   3. Else if it's been >= 15 min since the last send → freshness
//      heartbeat, priority 5 (keeps `stale-date` from catching up to a
//      healthy-but-unchanging activity — see the plan's Codex review).
//   4. Else → nothing to send.

import type { BeachSessionContentState, BeachSessionLightningState } from "@/lib/liveActivity/state";
import { LIGHTNING_ESCALATE_MI } from "@/lib/alerts/evaluate";

/** Below this gap since the last send, an ordinary (non-lightning) content
 *  change waits rather than sending immediately. */
export const LIVE_ACTIVITY_UPDATE_MIN_GAP_MS = 60 * 1000;
/** No push in this long (and nothing else triggered one) → freshness
 *  heartbeat, so `stale-date` never catches up to a healthy activity. */
export const LIVE_ACTIVITY_HEARTBEAT_MS = 15 * 60 * 1000;
/** How far ahead of "now" every send's `stale-date` is set. */
export const LIVE_ACTIVITY_STALE_AHEAD_MS = 25 * 60 * 1000;
/** How far ahead of "now" the due-end sweep's `dismissal-date` is set. */
export const LIVE_ACTIVITY_DISMISSAL_AHEAD_MS = 15 * 60 * 1000;
/** ActivityKit's own hard ceiling — a Live Activity is ended by iOS at 8h
 *  regardless of what Beach Mode or D1 say (docs/LIVE_ACTIVITY_PLAN.md).
 *  Shared by the register route (rotation must never push this out from the
 *  ORIGINAL startedAt, Codex review #3) and the fan-out's expiry
 *  reconciliation (lib/alerts/run.ts), so the bound can't drift between the
 *  two places that enforce it. */
export const LIVE_ACTIVITY_MAX_SESSION_MS = 8 * 60 * 60 * 1000;

export type LiveActivitySendReason = "lightning" | "update" | "heartbeat";

export interface LiveActivitySendDecision {
  send: boolean;
  reason?: LiveActivitySendReason;
  priority: 5 | 10;
  staleDateMs?: number;
  /** 50 normal, 100 while lightning is active — omitted when `send` is false. */
  relevanceScore?: number;
}

/**
 * Did lightning just turn active, or escalate from "active but outside the
 * escalation radius" to "active and inside it" — the one case that jumps the
 * ordinary debounce. Mirrors the exact radius lib/alerts/evaluate.ts's own
 * lightning subject escalation uses (`LIGHTNING_ESCALATE_MI`), so the Lock
 * Screen hero promotes at precisely the distance the push alert calls
 * urgent — never its own re-derived threshold.
 */
export function lightningEscalated(
  prev: BeachSessionLightningState | undefined,
  next: BeachSessionLightningState | undefined,
): boolean {
  const prevActive = !!prev?.active;
  const nextActive = !!next?.active;
  if (!prevActive && nextActive) return true; // turned active
  if (prevActive && nextActive) {
    const prevEscalated = prev?.miles != null && prev.miles <= LIGHTNING_ESCALATE_MI;
    const nextEscalated = next?.miles != null && next.miles <= LIGHTNING_ESCALATE_MI;
    if (!prevEscalated && nextEscalated) return true; // escalated
  }
  return false;
}

export function decideLiveActivitySend(args: {
  nowMs: number;
  desired: BeachSessionContentState;
  desiredHash: string;
  /** The last state actually sent (parsed `last_state_json`), or null for a
   *  fresh/never-sent activity. */
  prevState: BeachSessionContentState | null;
  lastStateHash: string | null;
  lastSentAt: number | null;
}): LiveActivitySendDecision {
  const { nowMs, desired, desiredHash, prevState, lastStateHash, lastSentAt } = args;
  const relevanceScore = desired.lightning?.active ? 100 : 50;

  if (lightningEscalated(prevState?.lightning, desired.lightning)) {
    return {
      send: true,
      reason: "lightning",
      priority: 10,
      staleDateMs: nowMs + LIVE_ACTIVITY_STALE_AHEAD_MS,
      relevanceScore: 100,
    };
  }

  const sinceLastSend = lastSentAt == null ? Infinity : nowMs - lastSentAt;

  if (desiredHash !== lastStateHash && sinceLastSend >= LIVE_ACTIVITY_UPDATE_MIN_GAP_MS) {
    return {
      send: true,
      reason: "update",
      priority: 5,
      staleDateMs: nowMs + LIVE_ACTIVITY_STALE_AHEAD_MS,
      relevanceScore,
    };
  }

  // Codex review #8: while the read is `unavailable` (degraded/stale data),
  // never send a freshness heartbeat — that would advance stale-date and
  // implicitly claim the Lock Screen is fresher than it actually is. A real
  // CONTENT change (including the transition into/out of `unavailable`
  // itself) still sends via the hash-changed branch above; this only mutes
  // the "nothing changed, but keep it looking alive" heartbeat.
  if (!desired.unavailable && sinceLastSend >= LIVE_ACTIVITY_HEARTBEAT_MS) {
    return {
      send: true,
      reason: "heartbeat",
      priority: 5,
      staleDateMs: nowMs + LIVE_ACTIVITY_STALE_AHEAD_MS,
      relevanceScore,
    };
  }

  return { send: false, priority: 5 };
}

/** `JSON.parse` a stored `last_state_json` blob, or null for anything
 *  missing/corrupt — a bad blob must read as "no prior state" (send),
 *  never throw and sink the run. */
export function safeParseState(json: string | null | undefined): BeachSessionContentState | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as BeachSessionContentState;
  } catch {
    return null;
  }
}
