// POST /api/quality/alerts — the cam reader reports a held seaweed jump that a
// second reader did NOT back up (scripts/cam_seaweed.py, docs/QUALITY_PLAN.md).
// The alert is stored for the owner's review screen, and pushed to the owner's
// phone when the rules in lib/quality/pushPolicy.ts allow.
//
// Auth: `Authorization: Bearer <INGEST_TOKEN>`, compared in constant time (the
// same secret the cam archive uses). The reader sends only a disagreement; a
// second opinion that agreed is confirmed by the reader and never comes here.
// A retry of the same frame is a no-op (the dedupe key is unique).
//
// The body may carry the exact image the reader judged (`frame.jpegB64`, a shrunk
// JPEG of at most 150 KB). The app keeps it in R2 under `quality/` and records the
// key in the alert, so the review screen shows the judged frame. A missing, bad or
// unstorable image never fails the alert: the screen falls back to the nearest
// archived frame.

import { getD1 } from "@/lib/db/d1Store";
import { secretEqual } from "@/lib/db/api";
import { readBodyCapped } from "@/lib/camFrames/ingest";
import { getCamFramesBucket } from "@/lib/camFrames/r2";
import { MAX_ALERT_BODY_BYTES, storeAlertFrame } from "@/lib/quality/frameUpload";
import { recordAlert } from "@/lib/quality/alerts";
import { parseSeaweedAlert } from "@/lib/quality/ingest";
import { sendOwnerPush } from "@/lib/quality/notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: Request): Promise<Response> {
  const token = process.env.INGEST_TOKEN;
  if (!token) return json({ ok: false, error: "not-configured" }, 503);
  const header = req.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!presented || !secretEqual(presented, token)) return json({ ok: false, error: "unauthorized" }, 401);

  const read = await readBodyCapped(req, MAX_ALERT_BODY_BYTES);
  if (!read.ok) return json({ ok: false, error: read.reason === "too-large" ? "too-large" : "bad-request" }, read.reason === "too-large" ? 413 : 400);
  let body: Record<string, unknown> | null = null;
  try {
    const parsedBody = JSON.parse(new TextDecoder().decode(read.bytes)) as unknown;
    if (parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)) body = parsedBody as Record<string, unknown>;
  } catch {
    body = null;
  }
  if (!body) return json({ ok: false, error: "bad-request" }, 400);
  const nowMs = Date.now();
  const parsed = parseSeaweedAlert(body, nowMs);
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);

  const db = await getD1();
  if (!db) return json({ ok: false, error: "store-unavailable" }, 503);
  try {
    const { slug, payload, dedupeKey, frameJpeg } = parsed.value;
    if (frameJpeg) {
      payload.frame.r2Key = await storeAlertFrame(await getCamFramesBucket(), {
        slug,
        camId: payload.camId,
        atMs: Date.parse(payload.observedAt),
        bytes: frameJpeg,
      });
    }
    const r = await recordAlert(
      db,
      { slug, signal: "seaweed", kind: "seaweed-held-disagreed", createdAt: new Date(nowMs).toISOString(), payload, dedupeKey },
      nowMs,
      sendOwnerPush,
    );
    return json({ ok: true, id: r.id, created: r.created, pushed: r.pushed, reason: r.reason });
  } catch (e) {
    console.error("quality alerts: write failed", e);
    return json({ ok: false, error: "store-unavailable" }, 500);
  }
}
