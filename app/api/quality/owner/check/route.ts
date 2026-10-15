// POST /api/quality/owner/check — "is this phone enrolled?" Bearer owner token. 200
// { ok: true, owner: true } or the refusal from lib/quality/owner.ts.

import { ownerJson, ownerRoute } from "@/lib/quality/ownerRoute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return ownerRoute(req, async () => ownerJson({ ok: true, owner: true }));
}
