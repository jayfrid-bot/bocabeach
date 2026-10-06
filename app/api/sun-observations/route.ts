// POST /api/sun-observations — where scripts/sun_cam_check.py (on the owner's
// Mac) delivers what the sky actually did at one sunrise or sunset, scored 0-100
// from a beach livestream. Stores it in `sun_event_observations`
// (migrations/0015) and fills observed_score / observed_source / observed_at on
// the matching `sun_event_predictions` rows, so the color model can be checked
// against reality. See docs/SUN_CAM_CHECK.md.
//
// AUTH: the same bearer secret the camera courier uses on workers/uw-frame's
// POST /ingest — `Authorization: Bearer <INGEST_TOKEN>`, compared in constant
// time. The secret name is the same; it has to be set on THIS worker too
// (`wrangler secret put INGEST_TOKEN`, same value). 503 when it is unset, 401
// when the token is wrong. Auth is checked BEFORE the body is read.
//
// The body is validated strictly (lib/sunObservations.ts): every field's type
// and range, no unknown fields, the cam/beach/credit against
// config/sun-cams.json, the event time against the beach's own solar times, and
// the robust peak and the temporal coverage RECOMPUTED from the series. A
// re-post of the same (slug, event, local day, cam) replaces the row only when
// its (score_version, scored_at) is newer; a duplicate or stale replay is a
// no-op (`stored: false`). The body is read as a bounded stream (32 KB).

import { getStore } from "@/lib/db/store";
import { secretEqual } from "@/lib/db/api";
import { SUN_OBSERVATION_MAX_BODY_BYTES, parseSunObservation } from "@/lib/sunObservations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: Record<string, unknown>, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

type BodyRead = { ok: true; value: unknown } | { ok: false; reason: "too-large" | "bad-json" };

/**
 * Read and parse a JSON body, never holding more than the cap. The body is read
 * as a stream and cancelled the moment the running total passes the cap, so a
 * chunked upload with no Content-Length (or a lying one) cannot make the worker
 * buffer an unbounded body. A Content-Length over the cap is refused up front.
 */
async function readJson(req: Request): Promise<BodyRead> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > SUN_OBSERVATION_MAX_BODY_BYTES) return { ok: false, reason: "too-large" };
  if (!req.body) return { ok: false, reason: "bad-json" };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > SUN_OBSERVATION_MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too-large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "bad-json" };
  }
  if (total === 0) return { ok: false, reason: "bad-json" };

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown };
  } catch {
    return { ok: false, reason: "bad-json" };
  }
}

export async function POST(req: Request): Promise<Response> {
  const token = process.env.INGEST_TOKEN;
  if (!token) return json({ ok: false, error: "not-configured" }, 503);

  const header = req.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!presented || !secretEqual(presented, token)) return json({ ok: false, error: "unauthorized" }, 401);

  const read = await readJson(req);
  if (!read.ok) {
    return read.reason === "too-large"
      ? json({ ok: false, error: "too-large", detail: "body must be at most 32 KB" }, 413)
      : json({ ok: false, error: "bad-request", detail: "body must be JSON" }, 400);
  }

  const parsed = parseSunObservation(read.value, Date.now());
  if (!parsed.ok) return json({ ok: false, error: "bad-request", detail: parsed.error }, 400);

  const store = await getStore();
  const { stored, predictionsUpdated } = await store.recordSunEventObservation(parsed.row);
  return json(
    { ok: true, slug: parsed.row.slug, event_kind: parsed.row.event_kind, cam_id: parsed.row.cam_id, stored, predictionsUpdated },
    200,
  );
}
