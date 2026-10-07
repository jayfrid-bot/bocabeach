// POST /api/push/test — send ONE real alert push to ONE device, so the owner
// can see how an alert looks on a phone (e.g. a banner while the app is open)
// without waiting for weather. Owner tooling, not a user feature.
//
// Auth: `Authorization: Bearer <INGEST_TOKEN>` (same secret as
// /api/sun-observations, compared in constant time). Body: { deviceId }.
// iOS only (APNs). Writes nothing: no alert_log row, no dedupe state, so a
// test can never suppress a real alert later.

import { getApns, openApnsSession } from "@/lib/push/apns";
import { getStore } from "@/lib/db/store";
import { isDeviceId, readBody, secretEqual } from "@/lib/db/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: Request): Promise<Response> {
  const token = process.env.INGEST_TOKEN;
  if (!token) return json({ ok: false, error: "not-configured" }, 503);
  const header = req.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!presented || !secretEqual(presented, token)) return json({ ok: false, error: "unauthorized" }, 401);

  const body = await readBody(req);
  const deviceId = body?.deviceId;
  if (!isDeviceId(deviceId)) return json({ ok: false, error: "bad-request", detail: "deviceId required" }, 400);

  // Tokens are never on a DeviceRecord; the push run reads them the same way.
  const target = (await (await getStore()).listPushable()).find((p) => p.device.id === deviceId);
  if (!target) return json({ ok: false, error: "no-push-token" }, 404);
  if (target.platform !== "ios") return json({ ok: false, error: "ios-only" }, 400);

  const apns = getApns();
  if (!apns) return json({ ok: false, error: "apns-not-configured" }, 503);

  const nowSec = Math.floor(Date.now() / 1000);
  const session = openApnsSession(apns, nowSec);
  try {
    const r = await session.send(target.token, {
      title: "Test alert",
      body: "If you can read this with the app open, alerts now show in the foreground.",
      url: "https://app.isitbeachday.com/",
      tag: "test",
      expiration: nowSec + 10 * 60,
    });
    return json({ ok: r.ok, status: r.status ?? null });
  } finally {
    session.close();
  }
}
