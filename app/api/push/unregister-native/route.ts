// POST /api/push/unregister-native — drop a stored native device token.
// Body: { token }.
//
// Deletes the device row (D1) AND the legacy KV record. Both matter: the KV
// record is still the import source for /api/push/run, so leaving it behind
// would resurrect the subscription on the next run.
//
// Auth: a real device row only lets go of its push token when the call carries
// that row's `x-install-token` (401 `no-token`, nothing changed, otherwise). The
// check is part of the one statement that clears the token
// (`store.clearPushRegistration`), and it follows the row found BY the push
// token, so a made-up deviceId in the body buys nothing. A legacy row (no
// deviceId; it is only a push subscription keyed by the token) goes on
// possession of the push token, as before. While INSTALL_TOKEN_ENFORCE is off,
// a call with no token is let through as before; a token that is sent is still
// checked.

import { fail, storeFailure } from "@/lib/db/api";
import { guardForWrite } from "@/lib/db/installTokenAuth";
import { getStore, isLegacyId } from "@/lib/db/store";
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
    await store.clearPushRegistration(token, guardForWrite(req, "/api/push/unregister-native"));
    // The statement above decided what changed. Looking now only chooses the
    // answer: a real row that STILL holds the token refused the caller.
    const still = await store.findByPushToken(token);
    if (still && !isLegacyId(still.id)) return fail("no-token", 401);
    await removeNativeSub(token).catch(() => {});
    return Response.json({ ok: true });
  } catch (e) {
    return storeFailure(e, "unregister-native: failed");
  }
}
