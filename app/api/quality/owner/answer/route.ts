// POST /api/quality/owner/answer — the owner's Right / Wrong tap.
// Body { alertId, verdict: "right" | "wrong", correct? }, where
// `correct` is { level } for seaweed, { word } for clarity, { value } for
// surf, sand and score. One atomic batch writes the label, closes the alert and, for a seaweed
// claim made today, the override that binds to that exact claim (lib/quality/answer.ts).
// A second tap on the same alert supersedes the first. `why` says when no live override
// was made. Owner only (Bearer owner token).

import { answerAlert } from "@/lib/quality/answer";
import { ownerJson, ownerRoute } from "@/lib/quality/ownerRoute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return ownerRoute(req, async ({ db, body }) => {
    const alertId = body.alertId;
    if (typeof alertId !== "number" || !Number.isInteger(alertId) || alertId < 1) {
      return ownerJson({ ok: false, error: "bad-request" }, 400);
    }
    if (body.verdict !== "right" && body.verdict !== "wrong") {
      return ownerJson({ ok: false, error: "bad-request" }, 400);
    }
    const r = await answerAlert(db, { alertId, verdict: body.verdict, correct: body.correct }, Date.now());
    if (r.ok) return ownerJson({ ok: true, labelId: r.labelId, overrideAdded: r.overrideAdded, ...(r.why ? { why: r.why } : {}) });
    const status = r.error === "not-found" ? 404 : 400;
    return ownerJson({ ok: false, error: r.error }, status);
  });
}
