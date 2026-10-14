// The shared frame of every owner-only quality route: read the body, check the
// owner (lib/quality/owner.ts), find the database, run the handler, and never
// let an error escape as a stack trace. Responses are private and uncached.

import { badRequest, readBody } from "@/lib/db/api";
import { getD1, type D1Like } from "@/lib/db/d1Store";
import { requireOwner } from "@/lib/quality/owner";

export interface OwnerContext {
  db: D1Like;
  body: Record<string, unknown>;
  deviceId: string;
}

export function ownerJson(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function ownerRoute(req: Request, handler: (ctx: OwnerContext) => Promise<Response>): Promise<Response> {
  const body = await readBody(req);
  const gate = await requireOwner(req, body);
  if (gate instanceof Response) return gate;
  if (!body) return badRequest();
  const db = await getD1();
  if (!db) return ownerJson({ ok: false, error: "store-unavailable" }, 503);
  try {
    return await handler({ db, body, deviceId: gate.deviceId });
  } catch (e) {
    console.error("quality owner route failed", e);
    return ownerJson({ ok: false, error: "store-unavailable" }, 500);
  }
}
