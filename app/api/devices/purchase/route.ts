// POST /api/devices/purchase — "I just bought (or restored) Plus in the App
// Store; check with RevenueCat and turn it on." Body { deviceId }.
//
// The phone can't be trusted to say it paid, so this asks RevenueCat with the
// secret key and mirrors the answer onto the device row. It only ever moves a
// device UP: a device on a trial or a code with no store purchase keeps what
// it has (Restore must never take Plus away). Expiry is handled by the stored
// timestamp and the webhook, not here.
//
// App only, like the other purchase routes. 503 until REVENUECAT_SECRET_KEY is
// set, 502 when RevenueCat can't be reached — both distinct from "not entitled".

import { badRequest, fail, isDeviceId, okDevice, readBody } from "@/lib/db/api";
import { getStore } from "@/lib/db/store";
import { isNativeRequest } from "@/lib/nativeRequest";
import { fetchPlusEntitlement } from "@/lib/plus/revenuecatVerify";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** An entitlement RevenueCat reports with no end date (none of ours today). */
const NO_END_MS = 100 * 365 * 24 * 3600 * 1000;

export async function POST(req: Request): Promise<Response> {
  if (!isNativeRequest(req)) return fail("app-only", 403);
  const secret = process.env.REVENUECAT_SECRET_KEY ?? "";
  if (!secret) return fail("not-configured", 503);
  const body = await readBody(req);
  if (!body || !isDeviceId(body.deviceId)) return badRequest();
  const deviceId = body.deviceId;

  const now = Date.now();
  const ent = await fetchPlusEntitlement(deviceId, secret, now);
  if (!ent) return fail("billing-unavailable", 502);

  try {
    const store = await getStore();
    if (!ent.active) {
      // Nothing bought on the store side: report the row as it stands.
      const existing = await store.getDevice(deviceId);
      return existing ? okDevice(existing) : fail("not-found", 404);
    }
    return okDevice(
      await store.upsertDevice(deviceId, {
        plan: "plus",
        entitlementUntil: ent.expiresAt ?? now + NO_END_MS,
      }),
    );
  } catch (e) {
    console.error("devices/purchase: failed", e);
    return fail("store-unavailable", 500);
  }
}
