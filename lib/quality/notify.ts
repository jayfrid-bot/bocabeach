// Push one quality alert to the OWNER's phones, and nobody else's.
//
// The owner's devices are the ones named in OWNER_DEVICE_IDS (lib/quality/
// owner.ts) that have a push token on file. iOS only, over APNs, like
// /api/push/test; an owner device on another platform is skipped. The tap opens
// the review screen on the alert.

import { getStore } from "@/lib/db/store";
import { getApns, openApnsSession } from "@/lib/push/apns";
import { ownerDeviceIds } from "@/lib/quality/owner";

export const APP_ORIGIN = "https://app.isitbeachday.com";

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
  reason?: "no-owner" | "no-owner-token" | "apns-not-configured";
}

export type SendOwnerPush = (msg: OwnerPush) => Promise<OwnerPushResult>;

/** Send to every owner iPhone. Never throws: a failure is a result. */
export const sendOwnerPush: SendOwnerPush = async (msg) => {
  const owners = ownerDeviceIds();
  if (!owners.length) return { ok: false, sent: 0, failed: 0, reason: "no-owner" };
  try {
    const targets = (await (await getStore()).listPushable()).filter(
      (p) => owners.includes(p.device.id) && p.platform === "ios",
    );
    if (!targets.length) return { ok: false, sent: 0, failed: 0, reason: "no-owner-token" };
    const apns = getApns();
    if (!apns) return { ok: false, sent: 0, failed: 0, reason: "apns-not-configured" };
    const nowSec = Math.floor(Date.now() / 1000);
    const session = openApnsSession(apns, nowSec);
    let sent = 0;
    let failed = 0;
    try {
      for (const t of targets) {
        const r = await session.send(t.token, {
          title: msg.title,
          body: msg.body,
          url: msg.url,
          tag: msg.tag,
          expiration: nowSec + 6 * 3600,
        });
        if (r.ok) sent += 1;
        else failed += 1;
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
