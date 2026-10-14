// POST /api/push/unregister-native — drop a stored native device token.
// Body: { token }.
//
// Deletes the device row (D1) AND the legacy KV record, so no copy of the
// subscription is left anywhere that could ever be imported again. A failed KV
// delete is an ERROR (500), never reported as success: the phone keeps its
// turn-off queued and retries, and the D1 clear above is idempotent.
//
// Auth: the PUSH TOKEN itself. Holding it is enough, with or without an install
// token and with INSTALL_TOKEN_ENFORCE on or off. That is deliberate: the only
// thing this route can do is turn alerts OFF for the phone that holds that
// token, and it lets an older app (which has no install token to send) switch
// its alerts off even after enforcement is on. A made-up deviceId in the body
// buys nothing: the row is found by the push token. (Moving a push token ONTO a
// row is a different matter; that is /api/push/register-native, guarded.)

import { fail, storeFailure } from "@/lib/db/api";
import { getStore } from "@/lib/db/store";
import { removeNativeSub } from "@/lib/push/nativeStore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  let token = "";
  try {
    token = ((await req.json()) as { token?: string })?.token ?? "";
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof token !== "string" || !token) {
    return Response.json({ error: "missing token" }, { status: 400 });
  }
  try {
    const store = await getStore();
    await store.clearPushRegistration(token);
  } catch (e) {
    return storeFailure(e, "unregister-native: failed");
  }
  try {
    await removeNativeSub(token);
  } catch (e) {
    console.error("unregister-native: legacy KV delete failed", e);
    return fail("store-unavailable", 500);
  }
  return Response.json({ ok: true });
}
