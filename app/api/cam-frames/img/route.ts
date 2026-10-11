// GET /api/cam-frames/img?k=<r2 key>&exp=<unix seconds>&sig=<signature> —
// delivery of one archived webcam frame (docs/CAM_ARCHIVE_PLAN.md R6, R8, R9).
//
// The link is minted only inside the entitled day route
// (app/api/history/[slug]/day/route.ts) by lib/camFrames/sign.ts and lives 15
// minutes. No device id travels in the URL, so this route holds no session:
// the signature IS the permission. Order of work:
//   1. verify(k, exp, sig): well-formed key, integer exp in (now, now+20 min],
//      constant-time HMAC compare.                          403 on any failure
//   2. the cam in the key is still archived (archive:false
//      blocks delivery at once, R6).                         404 unknown, 403 disabled
//   3. R2 binding present, else fail closed.                503
//   4. R2 get; a missing object (lifecycle, removal).        404
//   5. Stream the body straight from R2.
//
// `Cache-Control: private, max-age=<seconds left on the link>`: the browser may
// reuse the image until the link would have expired anyway; shared caches may
// not keep it. Nothing here uses the Cache API or edge caching.

import { parseFrameKey } from "@/lib/camFrames/keys";
import { lookupCam } from "@/lib/camFrames/manifest";
import { getCamFramesBucket } from "@/lib/camFrames/r2";
import { verify } from "@/lib/camFrames/sign";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function err(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(req: Request): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const k = q.get("k");
  const exp = q.get("exp");
  const sig = q.get("sig");
  const nowSec = Math.floor(Date.now() / 1000);

  if (!(await verify(k, exp, sig, nowSec))) return err("bad-signature", 403);

  const parsed = parseFrameKey(k);
  if (!parsed || !k || !exp) return err("bad-signature", 403);

  const cam = lookupCam(parsed.slug, parsed.camId);
  if (cam.status === "unknown") return err("not-found", 404);
  if (cam.status === "disabled") return err("archive-disabled", 403);

  const bucket = await getCamFramesBucket();
  if (!bucket) return err("cam archive storage unavailable", 503);

  let object: Awaited<ReturnType<typeof bucket.get>>;
  try {
    object = await bucket.get(k);
  } catch {
    return err("store-unavailable", 503);
  }
  if (!object) return err("not-found", 404);

  const secondsLeft = Math.max(0, Number(exp) - nowSec);
  return new Response(object.body, {
    headers: {
      "content-type": "image/jpeg",
      "cache-control": `private, max-age=${secondsLeft}`,
      "x-content-type-options": "nosniff",
    },
  });
}
