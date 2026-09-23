// /api/open — "this device opened the app today." Feeds the daily and weekly
// active-user counts in the growth report (lib/db/appOpens.ts).
//
//   POST { deviceId, platform }  → 204, always.
//
// No auth, the same trust model as /api/devices: the device id is a random,
// client-minted UUID and nothing here is secret or costs money. The reply
// never says whether the row was new, so the route tells a caller nothing.

import { getD1 } from "@/lib/db/d1Store";
import { isDeviceId, readBody } from "@/lib/db/api";
import { isOpenPlatform, recordOpen } from "@/lib/db/appOpens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const body = await readBody(req);
  if (body && isDeviceId(body.deviceId) && isOpenPlatform(body.platform)) {
    await recordOpen(await getD1(), body.deviceId, body.platform, Date.now());
  }
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
