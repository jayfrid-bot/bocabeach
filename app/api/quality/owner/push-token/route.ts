// POST /api/quality/owner/push-token — the owner's phone tells the server where to send owner
// pushes. Body { token, platform: "ios" }, Bearer owner token. The APNs token is stored on the
// owner SESSION (lib/quality/ownerSessions.ts) and is the only place owner pushes go
// (lib/quality/notify.ts). The general push registration (/api/push/register-native) is never
// read for this, and cannot redirect it.

import { setSessionPushToken } from "@/lib/quality/ownerSessions";
import { ownerFail, ownerJson, ownerRoute } from "@/lib/quality/ownerRoute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** APNs device tokens are hex. */
const APNS_RE = /^[0-9a-fA-F]{32,200}$/;

export async function POST(req: Request): Promise<Response> {
  return ownerRoute(req, async ({ db, body, session }) => {
    if (body.platform !== "ios" || typeof body.token !== "string" || !APNS_RE.test(body.token)) {
      return ownerFail("bad-request", 400);
    }
    // False when this session was revoked while the request was in flight: nothing was changed, and the
    // phone must hear it (it will enroll again).
    if (!(await setSessionPushToken(db, session.id, body.token.toLowerCase(), Date.now()))) return ownerFail("unauthorized", 401);
    return ownerJson({ ok: true });
  });
}
