// GET /api/quality/overrides?slug=<beach> — the owner's seaweed verdicts in force today, for
// the cam reader (scripts/cam_seaweed.py, once per beach per tick). Each one names the EXACT
// claim it is about (cam, frame hash or time, claim time) and what it does (docs/QUALITY_PLAN.md):
//
//   action "publish"  that frame's claim publishes at `level` (confirmedBy "owner");
//   action "reject"   that frame's claim is removed, and the cam is DISPUTED for the rest of
//                     the day (its later claims then need a second opinion that agrees,
//                     another fresh cam, an owner Right, or 3 frames over 90 minutes).
//
// Only the latest verdict per exact claim is in force; the rows returned are the active,
// unsuperseded ones, and the reader applies the same supersession rule again.
// Auth: `Authorization: Bearer <QUALITY_INGEST_TOKEN>`, constant-time. Read-only; the reader
// fails open (an error here changes nothing about how it reads today).

import { getLocation } from "@/config/locations";
import { secretEqual } from "@/lib/db/api";
import { getD1 } from "@/lib/db/d1Store";
import { bearerToken } from "@/lib/camFrames/ingest";
import { overrideFromRow } from "@/lib/quality/overrides";
import { activeOverrides } from "@/lib/quality/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(req: Request): Promise<Response> {
  const token = process.env.QUALITY_INGEST_TOKEN;
  if (!token) return json({ ok: false, error: "not-configured" }, 503);
  const presented = bearerToken(req.headers.get("authorization"));
  if (!presented || !secretEqual(presented, token)) return json({ ok: false, error: "unauthorized" }, 401);

  const slug = new URL(req.url).searchParams.get("slug");
  if (!slug || !getLocation(slug)) return json({ ok: false, error: "unknown-beach" }, 404);

  const db = await getD1();
  if (!db) return json({ ok: false, error: "store-unavailable" }, 503);
  try {
    const now = Date.now();
    const rows = await activeOverrides(db, slug, "seaweed", now);
    return json({
      ok: true,
      slug,
      now: new Date(now).toISOString(),
      overrides: rows.map((r) => ({ signal: r.signal, ...overrideFromRow(r) })),
    });
  } catch (e) {
    console.error("quality overrides: read failed", e);
    return json({ ok: false, error: "store-unavailable" }, 500);
  }
}
