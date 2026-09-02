// Repeat control for the alerts engine. One rule: a dedup key stays quiet for
// its repeat window (30 min by default) after it fires.
//
// Escalations get their OWN key (`lightning:2mi`, `flag:double-red`,
// `rip:moderate`, `severe:<event>`), so a worsening hazard is never swallowed by
// the window its milder self opened. That is the whole point of keeping the
// dedup key finer than the preference key.

import type { AlertMark } from "@/lib/db/types";
import type { AlertDecision } from "@/lib/alerts/catalog";

/** May this key fire again? */
export function shouldFire(last: AlertMark | null, now: number, repeatMs: number): boolean {
  if (!last) return true;
  if (!Number.isFinite(last.sentAt)) return true;
  return now - last.sentAt >= repeatMs;
}

export interface DedupSplit {
  /** Decisions to send now. */
  fire: AlertDecision[];
  /** Decisions held back — either inside their repeat window, or superseded. */
  held: AlertDecision[];
  /**
   * Dedup keys that were open but dropped in favor of an escalation. The caller
   * still marks these, so the milder alert does not fire one run later saying a
   * quieter version of what the person just read.
   */
  supersededKeys: string[];
}

/**
 * Split decisions into "send now" and "hold". `lastOf` answers with the last
 * mark for a dedup key (the store's `lastAlert`).
 *
 * A decision that another firing decision `supersedes` is held even when its own
 * window is open: the escalation says the same thing, better.
 */
export async function splitByDedup(
  decisions: AlertDecision[],
  now: number,
  lastOf: (key: string) => Promise<AlertMark | null>,
): Promise<DedupSplit> {
  const open: AlertDecision[] = [];
  const held: AlertDecision[] = [];
  for (const d of decisions) {
    const last = await lastOf(d.dedupKey);
    if (shouldFire(last, now, d.repeatMs)) open.push(d);
    else held.push(d);
  }
  const superseded = new Set<string>();
  for (const d of open) for (const k of d.supersedes ?? []) superseded.add(k);
  const fire: AlertDecision[] = [];
  const supersededKeys: string[] = [];
  for (const d of open) {
    if (superseded.has(d.dedupKey)) {
      held.push(d);
      supersededKeys.push(d.dedupKey);
    } else {
      fire.push(d);
    }
  }
  return { fire, held, supersededKeys };
}
