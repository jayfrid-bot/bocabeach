// GET /api/quality/overrides?slug=<beach> — the owner's seaweed verdicts that are
// still running today, for the cam reader (scripts/cam_seaweed.py, once per beach
// per tick). docs/QUALITY_PLAN.md says what each one makes the reader do:
//
//   verdict "wrong"  that cam's pending claim is cleared, and its further moderate+
//                    claims do not confirm by persistence or second opinion until it
//                    reads below moderate (another fresh cam can still confirm it);
//   verdict "right"  the held claim is confirmed (`confirmedBy: "owner"`).
//
// An override is active until the end of the beach-local day it was made on.
// Auth: `Authorization: Bearer <INGEST_TOKEN>`, constant-time, the same secret the
// reader already holds. Read-only; the reader fails open (an error here changes
// nothing about how it reads today).

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
  const token = process.env.INGEST_TOKEN;
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
