// POST /api/push/import-legacy — the ONE-OFF import of pre-Plus KV push
// subscriptions into D1. Run it once by hand after deploying the build that
// removed the per-run importer from /api/push/run, then leave it.
//
//   curl -X POST -H "x-cron-secret: $CRON_SECRET" "$ORIGIN/api/push/import-legacy"
//   curl -X POST -H "x-cron-secret: $CRON_SECRET" "$ORIGIN/api/push/import-legacy?dryRun=1"
//
// Same auth as /api/push/run (header `x-cron-secret`). It imports every KV
// subscription whose push token no device row holds yet, under the synthetic
// `legacy:` id, and reports counts only. It never deletes KV records, so it is
// safe to run twice (the second run imports nothing). Nothing calls it on a
// schedule: it exists because a perpetual importer would resurrect alerts for a
// phone that turned them off whenever its KV delete lagged or failed.

import { secretEqual } from "@/lib/db/api";
import { getStore } from "@/lib/db/store";
import { listNativeSubs } from "@/lib/push/nativeStore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "not configured (CRON_SECRET unset)" }, { status: 503 });
  if (!secretEqual(req.headers.get("x-cron-secret") ?? "", secret)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  try {
    const store = await getStore();
    const subs = await listNativeSubs();
    if (dryRun) return Response.json({ ok: true, dryRun: true, kvSubscriptions: subs.length });
    const { imported, skipped } = await store.importLegacy(subs);
    return Response.json({ ok: true, kvSubscriptions: subs.length, imported, skipped });
  } catch (e) {
    console.error("import-legacy: failed", e);
    return Response.json({ ok: false, error: "import-failed" }, { status: 500 });
  }
}
