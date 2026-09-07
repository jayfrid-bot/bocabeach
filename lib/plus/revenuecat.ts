// Pure mapping from a RevenueCat webhook event to what it means for a device's
// Plus entitlement. No I/O — the route (app/api/revenuecat/webhook) does the
// store write and the auth check; this decides WHAT to write, so it can be
// unit-tested against real event shapes with no network.
//
// The truth about entitlement is the EXPIRATION TIMESTAMP, not the event: the
// server's `entitled(device, now)` already treats Plus as off once
// entitlementUntil passes, so even if a webhook is missed the access lapses on
// its own. These events just keep the stored value in step and flip the plan
// label promptly.
//
// RevenueCat is configured (see docs/BILLING_SETUP.md) to use OUR deviceId as the
// appUserID, so `event.app_user_id` maps straight to a D1 device row. An event
// whose app_user_id is a RevenueCat anonymous id ($RCAnonymousID:…) can't be
// mapped and is ignored (the client always identifies with the deviceId).

import type { Plan } from "@/lib/db/types";

export interface RcEvent {
  type?: string;
  app_user_id?: string;
  original_app_user_id?: string;
  expiration_at_ms?: number | null;
  // Other fields (product_id, entitlement_ids, store, environment…) exist but
  // this simple one-entitlement model doesn't need them.
}

export interface RcWebhookBody {
  event?: RcEvent;
  api_version?: string;
}

export type RcDecision =
  | { kind: "apply"; deviceId: string; plan: Plan; entitlementUntil: number | null }
  | { kind: "ignore"; reason: string };

/** Events that mean "Plus is active now" — set plan=plus and carry the expiry. */
const ACTIVE = new Set([
  "INITIAL_PURCHASE",
  "RENEWAL",
  "UNCANCELLATION",
  "PRODUCT_CHANGE",
  "NON_RENEWING_PURCHASE",
  "SUBSCRIPTION_EXTENDED",
]);

/** Events that mean "Plus is over now" — flip plan=free. */
const INACTIVE = new Set(["EXPIRATION", "SUBSCRIPTION_PAUSED"]);

/**
 * CANCELLATION is deliberately NOT here: a cancel only turns off auto-renew, and
 * the person keeps Plus until it expires. EXPIRATION does the actual flip.
 * BILLING_ISSUE is also left alone — RevenueCat keeps the entitlement through the
 * grace period and sends EXPIRATION if it ultimately lapses.
 */
export function decideEntitlement(body: RcWebhookBody | null): RcDecision {
  const ev = body?.event;
  if (!ev || typeof ev.type !== "string") return { kind: "ignore", reason: "no-event" };
  if (ev.type === "TEST") return { kind: "ignore", reason: "test" };

  const id = ev.app_user_id ?? ev.original_app_user_id;
  if (!id || id.startsWith("$RCAnonymousID")) {
    return { kind: "ignore", reason: "unmappable-app-user-id" };
  }

  if (ACTIVE.has(ev.type)) {
    const until = typeof ev.expiration_at_ms === "number" ? ev.expiration_at_ms : null;
    return { kind: "apply", deviceId: id, plan: "plus", entitlementUntil: until };
  }
  if (INACTIVE.has(ev.type)) {
    return { kind: "apply", deviceId: id, plan: "free", entitlementUntil: null };
  }
  // CANCELLATION, BILLING_ISSUE, TRANSFER, SUBSCRIBER_ALIAS, and anything new:
  // acknowledge (200) without touching entitlement.
  return { kind: "ignore", reason: `no-op:${ev.type}` };
}
