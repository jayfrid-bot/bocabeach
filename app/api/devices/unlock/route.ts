// POST /api/devices/unlock — redeem a Plus code. Body { deviceId, code }.
//
// One shared code (PLUS_UNLOCK_CODE, set with `wrangler secret`) grants a year.
// It is how friends, testers and the owner get Plus before billing exists. A
// wrong code — or no code configured — answers 403 { ok: false, error: "bad-code" },
// so the endpoint never reveals whether the feature is switched on.

import { badRequest, fail, isDeviceId, okDevice, readBody, secretEqual } from "@/lib/db/api";
import { getStore } from "@/lib/db/store";
import { UNLOCK_DAYS } from "@/lib/db/plus";
import { isNativeRequest } from "@/lib/nativeRequest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  // App only, like the trial: Plus is delivered inside the phone app.
  if (!isNativeRequest(req)) return fail("app-only", 403);
  const body = await readBody(req);
  if (!body || !isDeviceId(body.deviceId)) return badRequest();
  if (typeof body.code !== "string" || body.code.length > 256) return badRequest();

  // Same env access as CRON_SECRET in /api/push/run.
  const expected = process.env.PLUS_UNLOCK_CODE ?? "";
  if (!expected || !secretEqual(body.code, expected)) return fail("bad-code", 403);

  try {
    const store = await getStore();
    const until = Date.now() + UNLOCK_DAYS * 24 * 3600 * 1000;
    return okDevice(
      await store.upsertDevice(body.deviceId, { plan: "plus", entitlementUntil: until }),
    );
  } catch (e) {
    console.error("devices/unlock: failed", e);
    return fail("store-unavailable", 500);
  }
}
