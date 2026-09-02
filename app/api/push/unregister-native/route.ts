// POST /api/push/unregister-native — drop a stored native device token.
// Body: { token }.
//
// Deletes the device row (D1) AND the legacy KV record. Both matter: the KV
// record is still the import source for /api/push/run, so leaving it behind
// would resurrect the subscription on the next run.

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
    if (device) {
      // A legacy row is only ever a push subscription, so it goes entirely. A
      // real device keeps its record (profile, Plus) and just stops being a
      // push destination.
      if (isLegacyId(device.id)) await store.deleteDevice(device.id);
      else await store.upsertDevice(device.id, { pushToken: null });
    }
    await removeNativeSub(token).catch(() => {});
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
