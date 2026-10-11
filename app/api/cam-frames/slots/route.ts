// GET /api/cam-frames/slots?slug=<beach> — the capture script's cheap pre-check
// (docs/CAM_ARCHIVE_PLAN.md R4 follow-up and "Golden-hour slots (2026-10-11)").
// Answers which cams of that beach already have a frame in each slot a frame
// could land in right now:
//
//   { ok: true, slug, now, currentSlotUtc, golden: [{ kind, startUtc, endUtc }],
//     slots: { "<slot ISO>": ["cam-id", ...], ... } }
//
// `currentSlotUtc` is the slot a frame taken NOW would land in under the slot
// rule (lib/camFrames/clock.ts): a 10-minute slot inside a golden-hour window
// of the beach, else the UTC-hour slot. `slots` holds that slot, the current
// and previous three UTC-hour slots (the ingest route accepts a source frame
// time up to 3 h old, so a courier frame can land three hours back), and every
// 10-minute slot of any golden window that overlaps that range. `golden` lists
// those windows, so the script can place a courier frame's own time with the
// same rule without a second request.
//
// A cam is listed when its slot is `ready`, or `pending` with a claim made in
// the last 10 minutes (an ingest probably still running). The script then
// skips the upload, and for cams only the archive pass reads, the download
// too. Without this every tick would fetch and upload ~11 images, nearly all
// to be answered "slot-taken".
//
// It is only an optimization. The capture script treats any error as "nothing
// is filled" and carries on, and POST /api/cam-frames still decides for real.
// Auth: the same Bearer INGEST_TOKEN as the ingest route. Reads D1 only
// (one statement, no R2).

import { getLocation } from "@/config/locations";
import { secretEqual } from "@/lib/db/api";
import { getD1 } from "@/lib/db/d1Store";
import { bearerToken } from "@/lib/camFrames/ingest";
import { isValidId } from "@/lib/camFrames/keys";
import { chooseSlot, goldenSlotsIn, goldenWindowsOverlapping, windowIso } from "@/lib/camFrames/golden";
import { archiveCams } from "@/lib/camFrames/manifest";
import { filledSlots, STALE_CLAIM_MS } from "@/lib/camFrames/store";
import { hourUtcOf } from "@/lib/history/archive";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function err(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(req: Request): Promise<Response> {
  const token = process.env.INGEST_TOKEN;
  if (!token) return err("cam archive not configured (INGEST_TOKEN unset)", 503);
  if (!secretEqual(bearerToken(req.headers.get("authorization")), token)) return err("unauthorized", 401);

  const slug = new URL(req.url).searchParams.get("slug") ?? "";
  if (!isValidId(slug) || !archiveCams().some((c) => c.slug === slug)) return err("unknown-slug", 404);

  const db = await getD1();
  if (!db) return err("cam archive storage unavailable", 503);

  const loc = getLocation(slug);
  if (!loc) return err("unknown-slug", 404);

  const nowMs = Date.now();
  const rangeStartMs = Math.floor((nowMs - 3 * 3_600_000) / 3_600_000) * 3_600_000;
  const windows = goldenWindowsOverlapping(loc, rangeStartMs, nowMs);
  const current = chooseSlot(loc, nowMs);
  const wanted = new Set<string>([
    ...[0, 1, 2, 3].map((h) => hourUtcOf(nowMs - h * 3_600_000)),
    ...windows.flatMap((w) => goldenSlotsIn(w, rangeStartMs, nowMs)),
    current.slotUtc,
  ]);
  try {
    const slots = await filledSlots(db, slug, [...wanted].sort(), new Date(nowMs - STALE_CLAIM_MS).toISOString());
    return Response.json(
      {
        ok: true,
        slug,
        now: new Date(nowMs).toISOString(),
        currentSlotUtc: current.slotUtc,
        golden: windows.map((w) => ({ kind: w.kind, ...windowIso(w) })),
        slots,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return err("store-unavailable", 503);
  }
}
