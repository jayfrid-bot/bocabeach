// Record one quality alert and, when the rules allow, push it to the owner.
// Both producers (the seaweed ingest route and the hourly watchdog) come
// through here, so the push rules live in one path (lib/quality/pushPolicy.ts).
//
// Order: store the alert first (it always lands, pushed or not), then decide,
// then send. The row is marked pushed BEFORE the send so two overlapping calls
// see each other in the daily count; a send that fails marks it unpushed again,
// so a dead phone does not use up the day's three.

import type { D1Like } from "@/lib/db/d1Store";
import { decidePush, ownerDayStartMs, type PushReason } from "@/lib/quality/pushPolicy";
import { reviewUrl, type SendOwnerPush } from "@/lib/quality/notify";
import { countPushedSince, insertAlert, lastPushedAt, setAlertPushed, type NewAlert } from "@/lib/quality/store";
import { pushCopy } from "@/lib/quality/text";

export interface RecordOutcome {
  id: number;
  /** False when the dedupe key already existed (a retry): nothing was written or sent. */
  created: boolean;
  /** True when a phone accepted the push. */
  pushed: boolean;
  reason: PushReason | "exists" | "send-failed";
}

export async function recordAlert(db: D1Like, a: NewAlert, nowMs: number, send: SendOwnerPush): Promise<RecordOutcome> {
  const { id, created } = await insertAlert(db, a);
  if (!created) return { id, created: false, pushed: false, reason: "exists" };

  const [pushedToday, lastAt] = await Promise.all([
    countPushedSince(db, new Date(ownerDayStartMs(nowMs)).toISOString()),
    lastPushedAt(db, a.slug, a.signal),
  ]);
  const decision = decidePush({
    nowMs,
    slug: a.slug,
    pushedToday,
    lastPushedSameKeyMs: lastAt ? Date.parse(lastAt) : null,
  });
  if (!decision.push) return { id, created: true, pushed: false, reason: decision.reason };

  await setAlertPushed(db, id, 1);
  const copy = pushCopy(a.slug, a.kind, a.signal, a.payload);
  const result = await send({ ...copy, url: reviewUrl(id), tag: `quality-${id}` });
  if (!result.ok) {
    await setAlertPushed(db, id, 0);
    return { id, created: true, pushed: false, reason: "send-failed" };
  }
  return { id, created: true, pushed: true, reason: "ok" };
}
