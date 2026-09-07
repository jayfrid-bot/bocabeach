// POST /api/revenuecat/webhook — RevenueCat pings us on a purchase, renewal,
// expiration, pause, cancellation or billing issue. Instead of trusting what
// the event says happened, this asks RevenueCat's own subscriber record for
// that device "is `plus` active right now, and until when" and writes THAT
// onto the device row's `store_until` grant (#7).
//
// Why not apply the event directly (the old behavior): RevenueCat documents
// that webhooks can be delivered out of order or retried late. A RENEWAL
// followed, on the wire, by a stale retried EXPIRATION would have flipped a
// renewed subscriber back to free. Re-checking the live subscriber record
// sidesteps delivery order entirely — whichever event arrives, the write
// reflects reality at the moment this request runs, and a repeat of the same
// event (or an out-of-order one) reconciles to the same answer, so this
// handler doesn't need its own de-dup table for event ids.
//
// Auth: RevenueCat sends the exact Authorization header value you set in its
// dashboard (Project → Integrations → Webhooks). We compare it, constant-time,
// against REVENUECAT_WEBHOOK_SECRET (a `wrangler secret`). No secret set → 503,
// so a misconfigured deploy fails loud instead of trusting anyone.
//
// `decideReconcile` (lib/plus/revenuecat.ts) only decides whether an event is
// worth a RevenueCat round-trip at all — an unmappable app_user_id, a TEST
// event, or an event scoped to some other entitlement never reaches RC. This
// file does auth, the RC call, the store write, and always answers 200 to an
// authenticated request it understood — even a no-op — so RevenueCat doesn't
// retry a delivery we deliberately ignored. 503/500 are reserved for "we
// could not find out the truth," where a retry is exactly what's wanted.

import { timingSafeEqual } from "node:crypto";
import { isDeviceId } from "@/lib/db/api";
import { getStore } from "@/lib/db/store";
import { NO_END_MS } from "@/lib/db/plus";
import { decideReconcile, type RcWebhookBody } from "@/lib/plus/revenuecat";
import { fetchPlusEntitlement } from "@/lib/plus/revenuecatVerify";

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

  const decision = decideReconcile(body);
  if (decision.kind === "ignore") {
    return Response.json({ ok: true, applied: false, reason: decision.reason });
  }
  if (!isDeviceId(decision.deviceId)) {
    // A RevenueCat appUserID that isn't one of our device ids — acknowledge so
    // it isn't retried, but touch nothing.
    return Response.json({ ok: true, applied: false, reason: "app-user-id-not-a-device" });
  }

  const secret = process.env.REVENUECAT_SECRET_KEY ?? "";
  if (!secret) return Response.json({ ok: false, error: "not-configured" }, { status: 503 });

  try {
    const store = await getStore();
    // Only reconcile a device we already know. A webhook for an unknown id
    // (a transfer, a stale alias) shouldn't conjure a row.
    const existing = await store.getDevice(decision.deviceId);
    if (!existing) {
      return Response.json({ ok: true, applied: false, reason: "unknown-device" });
    }

    const now = Date.now();
    // The RC secret key answers for both sandbox and production subscribers
    // (the owner tests through TestFlight sandbox) — no environment filter.
    const ent = await fetchPlusEntitlement(decision.deviceId, secret, now);
    if (!ent) {
      // RevenueCat could not be reached — 500 so it retries. Writing nothing
      // here is deliberate: an unreachable RC is "unknown," never "inactive."
      return Response.json({ ok: false, error: "billing-unavailable" }, { status: 500 });
    }

    // A store revocation (or a subscriber RC now says has nothing active)
    // clears ONLY the store grant — an independent code or trial grant is
    // untouched (#4), because upsertDevice only ever writes the field it's
    // told to.
    const device = await store.upsertDevice(decision.deviceId, {
      storeUntil: ent.active ? (ent.expiresAt ?? now + NO_END_MS) : null,
    });
    return Response.json({
      ok: true,
      applied: true,
      plan: device.plan,
      entitlementUntil: device.entitlementUntil,
    });
  } catch (e) {
    console.error("revenuecat/webhook: store write failed", e);
    // 500 so RevenueCat retries — the event was valid, our side hiccuped.
    return Response.json({ ok: false, error: "store-unavailable" }, { status: 500 });
  }
}
