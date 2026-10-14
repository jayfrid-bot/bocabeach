// The exact image behind a seaweed alert. The cam reader shrinks the still it
// judged (at most 150 KB) and sends it, base64, inside the alert POST. The app
// checks it, and keeps it in the cam-frames R2 bucket under `quality/`
// (lib/camFrames/keys.ts), so the review screen can show the frame that was
// judged, not just the nearest archived one.
//
// Retention: the bucket's lifecycle rule (367 days, see wrangler.jsonc) covers
// every object in it unless that rule was written with a prefix. See
// docs/QUALITY_PLAN.md before relying on a quality frame past a year.

import { hasJpegMagic, sha256Hex } from "@/lib/camFrames/ingest";
import { buildQualityFrameKey } from "@/lib/camFrames/keys";
import type { R2BucketLike } from "@/lib/camFrames/r2";

export const MAX_ALERT_FRAME_BYTES = 150 * 1024;
/** Smaller than this is not a picture. */
export const MIN_ALERT_FRAME_BYTES = 1024;
/** The base64 text of a maximum-size frame, plus slack. */
export const MAX_ALERT_FRAME_B64_CHARS = Math.ceil((MAX_ALERT_FRAME_BYTES * 4) / 3) + 8;
/** The whole alert body: the frame plus a few KB of JSON. */
export const MAX_ALERT_BODY_BYTES = MAX_ALERT_FRAME_B64_CHARS + 16 * 1024;

/** Decode and check a base64 JPEG: JPEG signature, 1 KB to 150 KB. Null for anything else. Pure. */
export function decodeAlertFrame(b64: unknown): Uint8Array | null {
  if (typeof b64 !== "string" || b64.length === 0 || b64.length > MAX_ALERT_FRAME_B64_CHARS) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) return null;
  let raw: string;
  try {
    raw = atob(b64);
  } catch {
    return null;
  }
  if (raw.length < MIN_ALERT_FRAME_BYTES || raw.length > MAX_ALERT_FRAME_BYTES) return null;
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return hasJpegMagic(bytes) ? bytes : null;
}

/** Put the frame in R2. Returns its key, or null when it could not be stored (no bucket, a put error). Never throws. */
export async function storeAlertFrame(
  bucket: R2BucketLike | null,
  args: { slug: string; camId: string; atMs: number; bytes: Uint8Array },
): Promise<string | null> {
  if (!bucket) return null;
  try {
    const key = buildQualityFrameKey({ slug: args.slug, camId: args.camId, atMs: args.atMs, sha256Hex: await sha256Hex(args.bytes) });
    await bucket.put(key, args.bytes, { httpMetadata: { contentType: "image/jpeg" } });
    return key;
  } catch (e) {
    console.error("quality: storing the alert frame failed", e);
    return null;
  }
}
