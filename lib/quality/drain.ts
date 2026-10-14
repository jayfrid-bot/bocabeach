// The drain step: send the owner pushes that alerts queued (lib/quality/alerts.ts).
// Run by POST /api/quality/drain, which workers/history-cron calls every minute after
// its archive pass. It is its own request, so its subrequests are its own: at most
// MAX_DRAIN_PER_TICK pushes, each one APNs fetch per owner phone (at most 3 phones, each
// fetch cut off after 5 seconds), plus a handful of D1 statements. The archive request
// that created the alert never talks to APNs.
//
// A queued push is sent only inside the owner's waking hours. One that went stale
// (QUEUED_MAX_AGE_MS) or fell into quiet hours is dropped unsent, and its slot is given
// back. A push that fails to send gives its slot back too. Nothing retries: the alert is
// still in the review list.

import type { D1Like } from "@/lib/db/d1Store";
import { inQuietHours } from "@/lib/quality/pushPolicy";
import { reviewUrl, type SendOwnerPush } from "@/lib/quality/notify";
import { dropStaleSlots, markPushSent, queuedPushes, QUEUED_MAX_AGE_MS, releasePushSlot } from "@/lib/quality/pushSlots";
import { pushCopy } from "@/lib/quality/text";
import type { HourlyAlertPayload, SeaweedAlertPayload } from "@/lib/quality/types";

export const MAX_DRAIN_PER_TICK = 3;

export interface DrainResult {
  sent: number;
  /** Slots given back: a failed send, or quiet hours. */
  released: number;
  /** Queued slots dropped for being too old. */
  stale: number;
}

export async function drainOwnerPushes(db: D1Like, nowMs: number, send: SendOwnerPush): Promise<DrainResult> {
  const out: DrainResult = { sent: 0, released: 0, stale: 0 };
  out.stale = await dropStaleSlots(db, nowMs - QUEUED_MAX_AGE_MS);
  const queued = await queuedPushes(db, MAX_DRAIN_PER_TICK);
  const quiet = inQuietHours(nowMs);
  for (const { alert } of queued) {
    if (quiet) {
      await releasePushSlot(db, alert.id);
      out.released += 1;
      continue;
    }
    let payload: SeaweedAlertPayload | HourlyAlertPayload;
    try {
      payload = JSON.parse(alert.payload_json) as SeaweedAlertPayload | HourlyAlertPayload;
    } catch {
      await releasePushSlot(db, alert.id);
      out.released += 1;
      continue;
    }
    const copy = pushCopy(alert.slug, alert.kind, alert.signal, payload);
    const r = await send(db, { ...copy, url: reviewUrl(alert.id), tag: `quality-${alert.id}` });
    if (r.ok) {
      await markPushSent(db, alert.id, nowMs);
      out.sent += 1;
    } else {
      await releasePushSlot(db, alert.id);
      out.released += 1;
    }
  }
  return out;
}
