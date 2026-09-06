// POST /api/devices/trial — start the one free trial this device gets.
// Body { deviceId }. Grants Plus for TRIAL_DAYS and flips trial_used, so a
// second call answers 409 { ok: false, error: "trial-used" }.
//
// App only: Plus is sold and delivered inside the phone app (billing, location
// and push all live there), so a request without the app's User-Agent tag gets
// 403 { ok: false, error: "app-only" }. The website never offers the trial.

import { badRequest, fail, isDeviceId, okDevice, readBody } from "@/lib/db/api";
import { getStore } from "@/lib/db/store";
import { TRIAL_DAYS } from "@/lib/db/plus";
import { isNativeRequest } from "@/lib/nativeRequest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  if (!isNativeRequest(req)) return fail("app-only", 403);
  const body = await readBody(req);
  if (!body || !isDeviceId(body.deviceId)) return badRequest();
  const deviceId = body.deviceId;
  try {
    const store = await getStore();
    const existing = await store.getDevice(deviceId);
    if (existing?.trialUsed) return fail("trial-used", 409);
    const until = Date.now() + TRIAL_DAYS * 24 * 3600 * 1000;
    return okDevice(
      await store.upsertDevice(deviceId, {
        plan: "plus",
        entitlementUntil: until,
        trialUsed: true,
      }),
    );
  } catch (e) {
    console.error("devices/trial: failed", e);
    return fail("store-unavailable", 500);
  }
}
