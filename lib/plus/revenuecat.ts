// Pure read of a RevenueCat webhook event: does it name one of our devices,
// and should this particular event make us go check that device's real
// subscriber record? No I/O — the route (app/api/revenuecat/webhook) does the
// store write and the auth check; this decides whether to bother, so it can
// be unit-tested against real event shapes with no network.
//
// This used to also decide WHAT the event meant — "RENEWAL → plus until this
// date", "EXPIRATION → free" — and write that straight onto the device. That
// trusted delivery order: a RENEWAL that RevenueCat retries late could arrive
// AFTER a newer EXPIRATION and silently restore access RevenueCat itself had
// already ended (#7). RevenueCat's own docs say webhooks can arrive out of
// order and recommend treating the CURRENT subscriber record as the truth,
// not the event. So every event that reaches this far now just triggers a
// fresh read of that record (`lib/plus/revenuecatVerify.ts`) and the answer —
// not the event — is what gets written. That also fixes the Android pause
// case (RevenueCat's own record already reflects its pause-vs-revoke rules)
// and the "lifetime product" case (one shared NO_END_MS constant, same as
// the purchase route) — there is no longer a second, separate opinion of
// what "active" means to get out of sync with those.
//
// RevenueCat is configured (see docs/BILLING_SETUP.md) to use OUR deviceId as
// the appUserID, so `event.app_user_id` maps straight to a D1 device row. An
// event whose app_user_id is a RevenueCat anonymous id ($RCAnonymousID:…)
// can't be mapped and is ignored (the client always identifies with the
// deviceId).

export interface RcEvent {
  type?: string;
  app_user_id?: string;
  original_app_user_id?: string;
  // Most event types carry this; a few (TRANSFER, TEST) don't. When present,
  // it is the entitlements the event actually concerns — used to skip a
  // RevenueCat round-trip for an event about some OTHER entitlement in the
  // same project, rather than let it drive our (only) "plus" entitlement.
  entitlement_ids?: string[];
}

export interface RcWebhookBody {
  event?: RcEvent;
  api_version?: string;
}

export type RcDecision =
  | { kind: "reconcile"; deviceId: string }
  | { kind: "ignore"; reason: string };

/**
 * Should this event make us go ask RevenueCat "what does this subscriber
 * actually have right now"? Everything about WHETHER access changes is
 * decided by that answer, never by this function or the event's own type —
 * see the file header. SUBSCRIPTION_PAUSED, CANCELLATION and BILLING_ISSUE
 * all reconcile too: RevenueCat's subscriber record is the one place that
 * already knows the real rules (grace periods, Android pause-vs-revoke,
 * whether a cancellation has actually lapsed yet).
 */
export function decideReconcile(body: RcWebhookBody | null): RcDecision {
  const ev = body?.event;
  if (!ev || typeof ev.type !== "string") return { kind: "ignore", reason: "no-event" };
  if (ev.type === "TEST") return { kind: "ignore", reason: "test" };

  const id = ev.app_user_id ?? ev.original_app_user_id;
  if (!id || id.startsWith("$RCAnonymousID")) {
    return { kind: "ignore", reason: "unmappable-app-user-id" };
  }

  // Present and non-empty → must actually be about our one entitlement.
  // Absent (or empty) → the event type doesn't scope by entitlement (or RC
  // sent nothing to filter on), so don't skip it on that basis.
  if (Array.isArray(ev.entitlement_ids) && ev.entitlement_ids.length > 0 && !ev.entitlement_ids.includes("plus")) {
    return { kind: "ignore", reason: "other-entitlement" };
  }

  return { kind: "reconcile", deviceId: id };
}
