// POST /api/quality/owner/enroll — enroll this phone as the owner. Body { code, deviceId? },
// where `code` is the OWNER_ENROLL_CODE secret. On a match the server makes an owner session
// and returns its token ONCE: { ok: true, token }. The token is stored only as a SHA-256
// (lib/quality/ownerSessions.ts); every other owner route needs it as a Bearer token.
//
// The code travels in the BODY, never in a URL this server sees (the screen reads it from the
// URL fragment, which browsers do not send), and it is never logged. Constant-time compare,
// rate limited (lib/quality/owner.ts). 503 while OWNER_ENROLL_CODE is unset.

import { enrollOwner, ownerDb, readOwnerBody } from "@/lib/quality/owner";
import { ownerFail, ownerJson } from "@/lib/quality/ownerHeaders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const db = await ownerDb();
  if (db instanceof Response) return db;
  const read = await readOwnerBody(req);
  if (!read.ok) return ownerFail(read.error, read.status);
  try {
    const r = await enrollOwner(req, db, read.body);
    if (r instanceof Response) return r;
    return ownerJson({ ok: true, token: r.token });
  } catch (e) {
    console.error("quality owner enroll failed");
    void e; // never log the request: it holds the code
    return ownerFail("store-unavailable", 500);
  }
}
