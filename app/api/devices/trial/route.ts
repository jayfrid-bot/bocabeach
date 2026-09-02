// POST /api/devices/trial — start the one free trial this device gets.
// Body { deviceId }. Grants Plus for TRIAL_DAYS and flips trial_used, so a
// second call answers 409 { ok: false, error: "trial-used" }.

import { badRequest, fail, isDeviceId, okDevice, readBody } from "@/lib/db/api";
import { getStore } from "@/lib/db/store";
import { TRIAL_DAYS } from "@/lib/db/plus";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
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
