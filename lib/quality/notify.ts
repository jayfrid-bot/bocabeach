// Push one quality alert to the OWNER's phone, and nobody else's.
//
// The owner's phone is the APNs token stored on an owner session (migrations/0019
// `owner_sessions`), set through the authenticated owner route
// POST /api/quality/owner/push-token when the owner opens the app. This file never reads
// the general devices table or the push-token store, so another person's push
// registration can neither receive these alerts nor redirect them. iOS only (APNs). The
// tap opens the review screen on the alert.

import type { D1Like } from "@/lib/db/d1Store";
import { getApns, isDeadToken, openApnsSession } from "@/lib/push/apns";
import { clearSessionPushToken, sessionsWithPushToken } from "@/lib/quality/ownerSessions";

export const APP_ORIGIN = "https://app.isitbeachday.com";

/** Each APNs call is cut off after this long. */
export const APNS_TIMEOUT_MS = 5000;
/** At most this many owner phones get a push. */
export const MAX_OWNER_PHONES = 3;

/** Where a tap on the push goes. */
export function reviewUrl(alertId: number): string {
  return `${APP_ORIGIN}/admin/review?alert=${alertId}`;
}

export interface OwnerPush {
  title: string;
  body: string;
  url: string;
  /** Collapse id, so a repeat for the same alert replaces the first. */
  tag: string;
}

export interface OwnerPushResult {
  /** True when at least one owner phone accepted it. */
  ok: boolean;
  sent: number;
  failed: number;
  /** Why nothing was sent, when sent is 0 and failed is 0. */
  reason?: "no-owner-token" | "apns-not-configured";
}

export type SendOwnerPush = (db: D1Like, msg: OwnerPush) => Promise<OwnerPushResult>;

/** Send to every enrolled owner phone with a push token. Never throws: a failure is a result. */
export const sendOwnerPush: SendOwnerPush = async (db, msg) => {
  try {
    // One send per distinct token (the database keeps them unique among active sessions; this is the belt).
    const seen = new Set<string>();
    const targets = (await sessionsWithPushToken(db, MAX_OWNER_PHONES * 2)).filter((t) => !seen.has(t.push_token) && seen.add(t.push_token)).slice(0, MAX_OWNER_PHONES);
    if (!targets.length) return { ok: false, sent: 0, failed: 0, reason: "no-owner-token" };
    const apns = getApns();
    if (!apns) return { ok: false, sent: 0, failed: 0, reason: "apns-not-configured" };
    const nowSec = Math.floor(Date.now() / 1000);
    const session = openApnsSession(apns, nowSec, { timeoutMs: APNS_TIMEOUT_MS });
    let sent = 0;
    let failed = 0;
    try {
      for (const t of targets) {
        const r = await session.send(t.push_token, {
          title: msg.title,
          body: msg.body,
          url: msg.url,
          tag: msg.tag,
          expiration: nowSec + 6 * 3600,
        });
        if (r.ok) sent += 1;
        else {
          failed += 1;
          if (isDeadToken(r)) await clearSessionPushToken(db, t.id, t.push_token);
        }
      }
    } finally {
      session.close();
    }
    return { ok: sent > 0, sent, failed };
  } catch (e) {
    console.error("quality: owner push failed", e);
    return { ok: false, sent: 0, failed: 1 };
  }
};
