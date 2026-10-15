// Record one quality alert and, when the rules allow, QUEUE its owner push.
// Both producers (the seaweed ingest route and the hourly watchdog) come through
// here, so the push rules live in one path.
//
// Nothing is sent from here. The alert and its push slot are written in ONE atomic D1 batch
// (lib/quality/pushSlots.ts: watched beach, not 9 PM to 7 AM, at most 3 a day, not a repeat
// inside 3 hours; the last two are conditions inside the slot INSERT). So there is no window in
// which the alert exists and its slot does not. A retry that finds the alert already stored runs
// the same batch: its alert INSERT is a no-op, and its slot INSERT reserves the missing slot if the
// alert is still open, fresh, and still eligible. The drain step (lib/quality/drain.ts, run every
// minute by workers/history-cron) sends queued pushes, so the archive request spends no subrequest
// on APNs.

import type { D1Like } from "@/lib/db/d1Store";
import { pushEligibility, type PushReason } from "@/lib/quality/pushPolicy";
import { reserveSlotStatement, slotRefusalReason, type SlotReason } from "@/lib/quality/pushSlots";
import { alertIdByKey, insertAlertStatement, runAtomic, type NewAlert } from "@/lib/quality/store";

export interface RecordOutcome {
  id: number;
  /** False when the dedupe key already existed (a retry) or the hourly limit refused it: nothing was written. */
  created: boolean;
  /** True when this call took a push slot for the alert; the drain step sends it. */
  queued: boolean;
  reason: PushReason | SlotReason | "queued" | "exists" | "rate-limited";
}

export async function recordAlert(
  db: D1Like,
  a: NewAlert,
  nowMs: number,
  opts?: { maxPerSlugPerHour?: number },
): Promise<RecordOutcome> {
  const eligible = pushEligibility(nowMs, a.slug);
  const stmts = [insertAlertStatement(db, a, opts)];
  if (eligible === "ok") stmts.push(reserveSlotStatement(db, { dedupeKey: a.dedupeKey }, a, nowMs));
  const results = await runAtomic(db, stmts);
  const created = (results[0]?.meta?.changes ?? 0) > 0;
  const queued = (results[1]?.meta?.changes ?? 0) > 0;

  const id = await alertIdByKey(db, a.dedupeKey);
  if (id == null) return { id: 0, created: false, queued: false, reason: "rate-limited" };
  if (queued) return { id, created, queued: true, reason: "queued" };
  if (!created) return { id, created: false, queued: false, reason: "exists" };
  if (eligible !== "ok") return { id, created: true, queued: false, reason: eligible };
  return { id, created: true, queued: false, reason: await slotRefusalReason(db, nowMs) };
}
