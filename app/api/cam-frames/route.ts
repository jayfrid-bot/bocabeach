// POST /api/cam-frames — webcam archive ingest (docs/CAM_ARCHIVE_PLAN.md R1-R8).
//
// The capture script (scripts/cam_seaweed.py, GitHub Actions) posts one raw JPEG
// per cam per tick: `?slug=<beach>&cam=<cam id>[&frameAt=<ISO>]`, body = the
// image bytes, `Authorization: Bearer $INGEST_TOKEN`. The server keeps ONE
// frame per cam per UTC-hour SLOT of the frame's display time (see
// lib/camFrames/clock.ts) — the same hour key beach_hourly uses — so a cam that
// repeats one image for hours, or a script that posts every ten minutes, stores
// a single shot per hour.
//
// Order of work (each step can end the request):
//   1. Bearer INGEST_TOKEN, constant-time compare.              401 / 503
//   2. slug + cam in the archive manifest.                       404 unknown, 403 archive:false
//   3. Content-Length over 600 KB refused up front.              413
//   4. Bindings present (DB, CAM_FRAMES), else fail closed.      503
//   5. Body read incrementally, aborted past 600 KB.             413 / 400
//   6. JPEG magic FF D8 FF and at least 10 KB.                   400
//   7. sha-256, three clocks (clock.ts), R2 key (keys.ts).
//   8. Atomic slot claim: INSERT ... ON CONFLICT DO NOTHING.     {stored:false, reason:"slot-taken"}
//   9. Newest READY frame has the same sha: delete pending.      {stored:false, reason:"unchanged"}
//  10. R2 put. On failure delete the pending row.                502
//  11. Mark ready. On failure try to delete the R2 object.       500
//  12.                                                           {stored:true, key, slotUtc, displayAtUtc}
//
// Subrequests per stored frame: claim, sha lookup, R2 put, mark ready = 4.
// `attribution` is read from the cam config here and stored on the row, so a
// later config edit never rewrites the credit of a frame already kept.

import { getLocation } from "@/config/locations";
import { secretEqual } from "@/lib/db/api";
import { getD1 } from "@/lib/db/d1Store";
import { frameClocks } from "@/lib/camFrames/clock";
import {
  bearerToken,
  hasJpegMagic,
  MAX_FRAME_BYTES,
  MIN_FRAME_BYTES,
  readBodyCapped,
  sha256Hex,
} from "@/lib/camFrames/ingest";
import { buildFrameKey } from "@/lib/camFrames/keys";
import { lookupCam } from "@/lib/camFrames/manifest";
import { getCamFramesBucket } from "@/lib/camFrames/r2";
import { claimSlot, deletePending, markReady, newestReadySha, type CamFrameRow } from "@/lib/camFrames/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function err(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status });
}

export async function POST(req: Request): Promise<Response> {
  // 1. auth
  const token = process.env.INGEST_TOKEN;
  if (!token) return err("cam archive not configured (INGEST_TOKEN unset)", 503);
  if (!secretEqual(bearerToken(req.headers.get("authorization")), token)) return err("unauthorized", 401);

  // 2. which cam
  const url = new URL(req.url);
  const slug = url.searchParams.get("slug") ?? "";
  const camId = url.searchParams.get("cam") ?? "";
  const lookup = lookupCam(slug, camId);
  if (lookup.status === "unknown") return err("unknown-cam", 404);
  if (lookup.status === "disabled") return err("archive-disabled", 403);
  const cam = lookup.cam;
  const loc = getLocation(slug);
  if (!loc) return err("unknown-cam", 404);

  // 3. size, up front
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_FRAME_BYTES) return err("too-large", 413);

  // 4. bindings, fail closed
  const [db, bucket] = await Promise.all([getD1(), getCamFramesBucket()]);
  if (!db || !bucket) return err("cam archive storage unavailable", 503);

  // 5. body
  const body = await readBodyCapped(req);
  if (!body.ok) {
    if (body.reason === "too-large") return err("too-large", 413);
    return err(body.reason === "empty" ? "empty-body" : "bad-body", 400);
  }
  const bytes = body.bytes;

  // 6. is it a real JPEG of a believable size
  if (!hasJpegMagic(bytes)) return err("not-a-jpeg", 400);
  if (bytes.byteLength < MIN_FRAME_BYTES) return err("too-small", 400);

  // 7. identity of this frame
  const sha = await sha256Hex(bytes);
  const clocks = frameClocks({
    nowMs: Date.now(),
    frameAtRaw: url.searchParams.get("frameAt"),
    timezone: cam.timezone,
  });
  const key = buildFrameKey({
    slug,
    camId,
    localDate: clocks.localDate,
    displayAtUtc: clocks.displayAtUtc,
    sha256Hex: sha,
  });
  const row: CamFrameRow = {
    slug,
    cam_id: camId,
    slot_utc: clocks.slotUtc,
    received_at_utc: clocks.receivedAtUtc,
    frame_at_utc: clocks.frameAtUtc,
    display_at_utc: clocks.displayAtUtc,
    local_date: clocks.localDate,
    local_hour: clocks.localHour,
    local_minute: clocks.localMinute,
    utc_offset_minutes: clocks.utcOffsetMinutes,
    timezone: clocks.timezone,
    r2_key: key,
    bytes: bytes.byteLength,
    sha256: sha,
    source_kind: cam.sourceKind,
    attribution: cam.attribution,
  };

  // 8. atomic claim
  try {
    if (!(await claimSlot(db, row))) return Response.json({ stored: false, reason: "slot-taken" });
  } catch {
    return err("store-unavailable", 503);
  }

  // From here we own a pending row: every exit below must settle it.
  const release = () => deletePending(db, slug, camId, clocks.slotUtc, key).catch(() => undefined);

  // 9. unchanged since the newest stored frame?
  try {
    if ((await newestReadySha(db, slug, camId)) === sha) {
      await release();
      return Response.json({ stored: false, reason: "unchanged" });
    }
  } catch {
    await release();
    return err("store-unavailable", 503);
  }

  // 10. R2
  try {
    await bucket.put(key, bytes, {
      httpMetadata: { contentType: "image/jpeg" },
      customMetadata: { slug, cam: camId, displayAtUtc: clocks.displayAtUtc },
    });
  } catch {
    await release();
    return err("object-store-failed", 502);
  }

  // 11. finalize
  try {
    if (!(await markReady(db, slug, camId, clocks.slotUtc, key))) throw new Error("claim lost");
  } catch {
    await bucket.delete(key).catch(() => undefined);
    await release();
    return err("finalize-failed", 500);
  }

  return Response.json({ stored: true, key, slotUtc: clocks.slotUtc, displayAtUtc: clocks.displayAtUtc });
}
