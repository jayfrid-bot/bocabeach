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
// the score against the series it came from. A re-post of the same
// (slug, event, local day, cam) replaces the row (a re-score).

import { getStore } from "@/lib/db/store";
import { secretEqual } from "@/lib/db/api";
import { SUN_OBSERVATION_MAX_BODY_BYTES, parseSunObservation } from "@/lib/sunObservations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: Record<string, unknown>, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

/** Read and parse a JSON body under the size cap; null on any failure. */
async function readJson(req: Request): Promise<unknown | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > SUN_OBSERVATION_MAX_BODY_BYTES) return null;
  let text: string;
  try {
    text = await req.text();
  } catch {
    return null;
  }
  if (!text || new TextEncoder().encode(text).length > SUN_OBSERVATION_MAX_BODY_BYTES) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export async function POST(req: Request): Promise<Response> {
  const token = process.env.INGEST_TOKEN;
  if (!token) return json({ ok: false, error: "not-configured" }, 503);

  const header = req.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!presented || !secretEqual(presented, token)) return json({ ok: false, error: "unauthorized" }, 401);

  const body = await readJson(req);
  if (body === null) return json({ ok: false, error: "bad-request", detail: "body must be JSON of at most 32 KB" }, 400);

  const parsed = parseSunObservation(body, Date.now());
  if (!parsed.ok) return json({ ok: false, error: "bad-request", detail: parsed.error }, 400);

  const store = await getStore();
  const { predictionsUpdated } = await store.recordSunEventObservation(parsed.row);
  return json({ ok: true, slug: parsed.row.slug, event_kind: parsed.row.event_kind, cam_id: parsed.row.cam_id, predictionsUpdated }, 200);
}
