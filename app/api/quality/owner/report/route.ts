// POST /api/quality/owner/report — "Report conditions". Body { deviceId, slug,
// seaweed?, clarity?, surfFt?, sandF?, note? }. Saves one quality_labels row per
// signal reported (source "report"), each with the nearest archived frames of
// that beach, so the owner can tell the app the truth from the sand
// (lib/quality/report.ts). Owner only.

import { parseReport, saveReport } from "@/lib/quality/report";
import { ownerJson, ownerRoute } from "@/lib/quality/ownerRoute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return ownerRoute(req, async ({ db, body }) => {
    const parsed = parseReport(body);
    if (!parsed.ok) return ownerJson({ ok: false, error: parsed.error }, 400);
    const r = await saveReport(db, parsed.value, Date.now());
    return ownerJson({ ok: true, saved: r.labelIds.length, frames: r.frames });
  });
}
