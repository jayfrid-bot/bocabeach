// POST /api/devices/trial — start the one free trial this device gets.
// Body { deviceId }. Grants Plus for TRIAL_DAYS on the dedicated `trialUntil`
// grant (#4) and flips trial_used, so a second call answers 409
// { ok: false, error: "trial-used" }.
//
// `store.claimTrial` does the "only if not already used" check and the write
// as ONE atomic conditional update (#3) — two requests racing for the same
// device's trial can't both win, and trial_used can never be reset by a
// later, unrelated write (it isn't part of the general upsert patch).
//
// App only: Plus is sold and delivered inside the phone app (billing, location
// and push all live there), so a request without the app's User-Agent tag gets
// 403 { ok: false, error: "app-only" }. The website never offers the trial.
//
// Off by default: the App Store already gives every eligible account a real
// 3-day free trial through RevenueCat (see lib/plus/billing.ts
// trialEligibility). A server-granted trial guarded only by a User-Agent
// check let anyone with a new localStorage device id mint an unlimited number
// of free trials, so this route now answers 403 { error: "server-trial-off" }
// unless env PLUS_UNLOCK_CODE's sibling `PLUS_SERVER_TRIAL` is exactly "on" —
// see docs/BILLING_SETUP.md for when to flip it (a billing outage only).

import { badRequest, fail, isDeviceId, okDevice, readBody } from "@/lib/db/api";
import { getStore } from "@/lib/db/store";
import { TRIAL_DAYS } from "@/lib/db/plus";
import { isNativeRequest } from "@/lib/nativeRequest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  if (!isNativeRequest(req)) return fail("app-only", 403);
  if (process.env.PLUS_SERVER_TRIAL !== "on") return fail("server-trial-off", 403);
  const body = await readBody(req);
  if (!body || !isDeviceId(body.deviceId)) return badRequest();
  const deviceId = body.deviceId;
  try {
    const store = await getStore();
    const until = Date.now() + TRIAL_DAYS * 24 * 3600 * 1000;
    const result = await store.claimTrial(deviceId, until);
    if (result === "trial-used") return fail("trial-used", 409);
    return okDevice(result);
  } catch (e) {
    console.error("devices/trial: failed", e);
    return fail("store-unavailable", 500);
  }
}
