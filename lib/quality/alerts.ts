// Record one quality alert and, when the rules allow, QUEUE its owner push.
// Both producers (the seaweed ingest route and the hourly watchdog) come through
// here, so the push rules live in one path.
//
// Nothing is sent from here. The alert is stored first (it always lands), then it
// takes a push slot if it may (lib/quality/pushSlots.ts: watched beach, not 9 PM to
// 7 AM, at most 3 a day, not a repeat inside 3 hours; the last two are atomic in D1).
// The drain step (lib/quality/drain.ts, run every minute by workers/history-cron)
// sends queued pushes, so the archive request spends no subrequest on APNs.

import type { D1Like } from "@/lib/db/d1Store";
import { pushEligibility, type PushReason } from "@/lib/quality/pushPolicy";
import { reservePushSlot } from "@/lib/quality/pushSlots";
import { insertAlert, type NewAlert } from "@/lib/quality/store";

export interface RecordOutcome {
  id: number;
  /** False when the dedupe key already existed (a retry) or the hourly limit refused it: nothing was written. */
  created: boolean;
  /** True when the alert took a push slot and waits for the drain step. */
  queued: boolean;
  reason: PushReason | "queued" | "exists" | "rate-limited";
}

export async function recordAlert(
  db: D1Like,
  a: NewAlert,
  nowMs: number,
  opts?: { maxPerSlugPerHour?: number },
): Promise<RecordOutcome> {
  const ins = await insertAlert(db, a, opts);
  if (ins.limited) return { id: 0, created: false, queued: false, reason: "rate-limited" };
  if (!ins.created) return { id: ins.id, created: false, queued: false, reason: "exists" };

  const eligible = pushEligibility(nowMs, a.slug);
  if (eligible !== "ok") return { id: ins.id, created: true, queued: false, reason: eligible };
  const slot = await reservePushSlot(db, { alertId: ins.id, slug: a.slug, signal: a.signal }, nowMs);
  if (!slot.reserved) return { id: ins.id, created: true, queued: false, reason: slot.reason };
  return { id: ins.id, created: true, queued: true, reason: "queued" };
}
