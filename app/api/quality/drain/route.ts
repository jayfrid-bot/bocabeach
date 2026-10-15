// POST /api/quality/drain — send the owner pushes that alerts queued. workers/history-cron
// calls it every minute, right after its archive pass. It is a separate request on purpose:
// the archive request only RECORDS alerts, so it spends no subrequest on APNs, and this one
// has a small budget of its own (at most 3 pushes, each one APNs fetch per owner phone, 5 s
// timeout each, plus a few D1 statements). See lib/quality/drain.ts.
//
// Auth: `x-cron-secret: <CRON_SECRET>`, the same secret and compare as /api/history/archive.

import { secretEqual } from "@/lib/db/api";
import { getD1 } from "@/lib/db/d1Store";
import { drainOwnerPushes } from "@/lib/quality/drain";
import { sendOwnerPush } from "@/lib/quality/notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return json({ error: "not-configured" }, 503);
  if (!secretEqual(req.headers.get("x-cron-secret") ?? "", secret)) return json({ error: "unauthorized" }, 401);
  const db = await getD1();
  if (!db) return json({ ok: true, sent: 0, released: 0, stale: 0, note: "no database" });
  try {
    return json({ ok: true, ...(await drainOwnerPushes(db, Date.now(), sendOwnerPush)) });
  } catch (e) {
    console.error("quality drain failed", e);
    return json({ ok: false, error: "drain-failed" }, 500);
  }
}
