// POST /api/revenuecat/webhook — RevenueCat tells us when a device's Plus
// subscription starts, renews, or ends, and we mirror that onto the D1 device
// row (plan + entitlementUntil). The purchase itself happens on the phone
// through the App Store; this is the server learning the outcome.
//
// Auth: RevenueCat sends the exact Authorization header value you set in its
// dashboard (Project → Integrations → Webhooks). We compare it, constant-time,
// against REVENUECAT_WEBHOOK_SECRET (a `wrangler secret`). No secret set → 503,
// so a misconfigured deploy fails loud instead of trusting anyone.
//
// The decision of WHAT an event means lives in lib/plus/revenuecat.ts (pure,
// unit-tested). This file does auth, the store write, and always answers 200 to
// an authenticated request it understood — even a no-op — so RevenueCat doesn't
// retry a delivery we deliberately ignored.

import { timingSafeEqual } from "node:crypto";
import { isDeviceId } from "@/lib/db/api";
import { getStore } from "@/lib/db/store";
import { decideEntitlement, type RcWebhookBody } from "@/lib/plus/revenuecat";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function constantEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function POST(req: Request): Promise<Response> {
  const expected = process.env.REVENUECAT_WEBHOOK_SECRET ?? "";
  if (!expected) return Response.json({ ok: false, error: "not-configured" }, { status: 503 });

  const got = req.headers.get("authorization") ?? "";
  if (!constantEq(got, expected)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: RcWebhookBody | null = null;
  try {
    body = (await req.json()) as RcWebhookBody;
  } catch {
    return Response.json({ ok: false, error: "bad-json" }, { status: 400 });
  }

  const decision = decideEntitlement(body);
  if (decision.kind === "ignore") {
    return Response.json({ ok: true, applied: false, reason: decision.reason });
  }
  if (!isDeviceId(decision.deviceId)) {
    // A RevenueCat appUserID that isn't one of our device ids — acknowledge so
    // it isn't retried, but touch nothing.
    return Response.json({ ok: true, applied: false, reason: "app-user-id-not-a-device" });
  }

  try {
    const store = await getStore();
    // Only mirror onto a device we already know. A webhook for an unknown id
    // (a transfer, a stale alias) shouldn't conjure a row.
    const existing = await store.getDevice(decision.deviceId);
    if (!existing) {
      return Response.json({ ok: true, applied: false, reason: "unknown-device" });
    }
    await store.upsertDevice(decision.deviceId, {
      plan: decision.plan,
      entitlementUntil: decision.entitlementUntil,
    });
    return Response.json({
      ok: true,
      applied: true,
      plan: decision.plan,
      entitlementUntil: decision.entitlementUntil,
    });
  } catch (e) {
    console.error("revenuecat/webhook: store write failed", e);
    // 500 so RevenueCat retries — the event was valid, our side hiccuped.
    return Response.json({ ok: false, error: "store-unavailable" }, { status: 500 });
  }
}
