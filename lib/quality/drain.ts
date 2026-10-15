// The drain step: send the owner pushes that alerts queued (lib/quality/alerts.ts).
// Run by POST /api/quality/drain, which workers/history-cron calls every minute after
// its archive pass. It is its own request, so its subrequests are its own: at most
// MAX_DRAIN_PER_TICK pushes, each one APNs fetch per owner phone (at most 3 phones, each
// fetch cut off after 5 seconds), plus a handful of D1 statements. The archive request
// that created the alert never talks to APNs.
//
// IDEMPOTENT. A drain CLAIMS each push (queued -> attempting, with a fresh attempt id, in one
// conditional UPDATE) BEFORE it calls APNs, and finalizes or releases it only with that attempt
// id (lib/quality/pushSlots.ts). Two drains that overlap (a cron tick and a manual one, or a slow
// tick still running) can never send the same push twice, and one that fails can never free a
// slot another drain sent. Only a DEFINITIVE refusal from Apple (an HTTP status) releases a slot. A send
// with no answer (network error, timeout) stays `attempting`: it may have been delivered. An attempt that was never finalized (the process died, or D1 failed
// right after APNs said yes) is NOT sent again: after 10 minutes it becomes `unknown`, and the
// review list says the push may not have been delivered.
//
// Only alerts that are still OPEN are sent. A queued push goes out only inside the owner's
// waking hours; one that went stale (30 min) or whose alert was answered is dropped unsent, and
// its slot is given back. A push that fails to send gives its slot back too. Nothing retries: the
// alert is still in the review list.

import type { D1Like } from "@/lib/db/d1Store";
import { inQuietHours } from "@/lib/quality/pushPolicy";
import { reviewUrl, type SendOwnerPush } from "@/lib/quality/notify";
import {
  claimQueuedPushes,
  dropClosedAlertSlots,
  dropStaleSlots,
  markPushSent,
  markStaleAttempts,
  QUEUED_MAX_AGE_MS,
  releaseAttempt,
} from "@/lib/quality/pushSlots";
import { pushCopy } from "@/lib/quality/text";
import type { HourlyAlertPayload, SeaweedAlertPayload } from "@/lib/quality/types";

export const MAX_DRAIN_PER_TICK = 3;

export interface DrainResult {
  sent: number;
  /** Slots given back: a failed send, a bad payload, or quiet hours. */
  released: number;
  /** Queued slots dropped: too old, or their alert is no longer open. */
  stale: number;
  /** Attempts left over from an earlier drain, now marked unknown (never re-sent). */
  unknown: number;
  /** Sends with no answer from Apple (network error, timeout): left `attempting`, so they become `unknown` and are never re-sent. */
  ambiguous: number;
}

export async function drainOwnerPushes(db: D1Like, nowMs: number, send: SendOwnerPush): Promise<DrainResult> {
  const out: DrainResult = { sent: 0, released: 0, stale: 0, unknown: 0, ambiguous: 0 };
  out.unknown = await markStaleAttempts(db, nowMs);
  out.stale = (await dropStaleSlots(db, nowMs - QUEUED_MAX_AGE_MS)) + (await dropClosedAlertSlots(db));

  if (inQuietHours(nowMs)) {
    // Not a time to buzz anyone: give every queued slot back. (Claim nothing.)
    const r = await db.prepare("DELETE FROM quality_push_slots WHERE state = 'queued'").run();
    out.released = r.meta?.changes ?? 0;
    return out;
  }

  for (const { alert, attemptId } of await claimQueuedPushes(db, MAX_DRAIN_PER_TICK, nowMs)) {
    let payload: SeaweedAlertPayload | HourlyAlertPayload;
    try {
      payload = JSON.parse(alert.payload_json) as SeaweedAlertPayload | HourlyAlertPayload;
    } catch {
      await releaseAttempt(db, alert.id, attemptId);
      out.released += 1;
      continue;
    }
    const copy = pushCopy(alert.slug, alert.kind, alert.signal, payload);
    const r = await send(db, { ...copy, url: reviewUrl(alert.id), tag: `quality-${alert.id}` });
    if (r.ok) {
      // Even a partial success (one phone of two) is a push that went out.
      await markPushSent(db, alert.id, attemptId, nowMs);
      out.sent += 1;
    } else if (r.ambiguous) {
      // Apple may have accepted it before the timeout. Do NOT release it: a released slot could be taken
      // again by a duplicate producer POST and the owner would be pushed twice. It stays `attempting`
      // and becomes `unknown` after 10 minutes.
      out.ambiguous += 1;
    } else {
      await releaseAttempt(db, alert.id, attemptId);
      out.released += 1;
    }
  }
  return out;
}
