// POST /api/quality/owner/list — the review screen's data: open alerts first,
// then recent ones, each with its archived frame (a signed 15-minute link), what
// was published against what was claimed, and the other cams. Owner only
// (lib/quality/owner.ts).

import { loadReview } from "@/lib/quality/review";
import { ownerJson, ownerRoute } from "@/lib/quality/ownerRoute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return ownerRoute(req, async ({ db }) => {
    const now = Date.now();
    const review = await loadReview(db, now);
    return ownerJson({ ok: true, now: new Date(now).toISOString(), ...review });
  });
}
