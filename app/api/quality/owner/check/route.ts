// POST /api/quality/owner/check — "is this device the owner?" Body { deviceId },
// header x-install-token. 200 { ok: true, owner: true } or the refusal from
// lib/quality/owner.ts. The beach page uses it nowhere; the review and report
// screens call it first so a non-owner sees a closed door, not an empty list.

import { requireOwner } from "@/lib/quality/owner";
import { readBody } from "@/lib/db/api";
import { ownerJson } from "@/lib/quality/ownerRoute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const gate = await requireOwner(req, await readBody(req));
  if (gate instanceof Response) return gate;
  return ownerJson({ ok: true, owner: true });
}
