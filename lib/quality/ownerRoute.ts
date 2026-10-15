// The shared frame of every owner-only quality route: find the database, check the Bearer
// owner token (lib/quality/owner.ts), read the body with the streaming size cap (never
// req.text()), run the handler, and never let an error escape as a stack trace. Every
// response carries the owner headers (private, no-store, no framing).

import type { D1Like } from "@/lib/db/d1Store";
import { ownerDb, readOwnerBody, requireOwner } from "@/lib/quality/owner";
import { ownerFail, ownerJson } from "@/lib/quality/ownerHeaders";
import type { OwnerSession } from "@/lib/quality/ownerSessions";

export { ownerJson, ownerFail };

export interface OwnerContext {
  db: D1Like;
  body: Record<string, unknown>;
  session: OwnerSession;
}

export async function ownerRoute(req: Request, handler: (ctx: OwnerContext) => Promise<Response>): Promise<Response> {
  const db = await ownerDb();
  if (db instanceof Response) return db;
  // Authenticate BEFORE reading the body: a stranger's bytes are never buffered.
  const session = await requireOwner(req, db);
  if (session instanceof Response) return session;
  const read = await readOwnerBody(req);
  if (!read.ok) return ownerFail(read.error, read.status);
  try {
    return await handler({ db, body: read.body, session });
  } catch (e) {
    console.error("quality owner route failed", e);
    return ownerFail("store-unavailable", 500);
  }
}
