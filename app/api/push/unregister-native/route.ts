// POST /api/push/unregister-native — drop a stored native device token.
// Body: { token }.
//
// Deletes the device row (D1) AND the legacy KV record. Both matter: the KV
// record is still the import source for /api/push/run, so leaving it behind
// would resurrect the subscription on the next run.
//
// Auth: a real device row that has an install token on file only lets go of
// its push token when the call carries that row's `x-install-token` (401
// `no-token`, nothing changed, otherwise). The row is the one found BY the push
// token, so the check follows what is actually being changed. A legacy row
// (no deviceId; it is just a push subscription keyed by the token) and a real
// row with no token on file yet are let through: holding the push token is the
// proof, as before.

import { checkInstallToken } from "@/lib/db/installTokenAuth";
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
    const device = await store.findByPushToken(token);
    if (device && !isLegacyId(device.id)) {
      const auth = await checkInstallToken(store, device.id, req.headers.get("x-install-token"), Date.now());
      if (auth === "denied") return Response.json({ ok: false, error: "no-token" }, { status: 401 });
    }
    if (device) {
      // A legacy row is only ever a push subscription, so it goes entirely. A
      // real device keeps its record (profile, Plus) and just stops being a
      // push destination — cleared conditionally on the token still matching,
      // same guard `prune()` uses (#5), in case a fresh registration lands
      // between the lookup above and this write.
      if (isLegacyId(device.id)) await store.deleteDevice(device.id);
      else await store.clearPushToken(device.id, token);
    }
    await removeNativeSub(token).catch(() => {});
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
