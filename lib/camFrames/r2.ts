// Typed accessor for the webcam archive's R2 bucket (binding `CAM_FRAMES`,
// bucket isitbeachday-cam-frames; see wrangler.jsonc). Fail closed: when the
// binding is absent — plain `next dev`, tests, a deploy that forgot the
// binding — this returns null and every caller answers 503. It never falls
// back to another store.
//
// The binding is reached exactly as lib/db/d1Store.ts reaches `DB`: a STATIC
// top-level import of @opennextjs/cloudflare plus the async form of
// getCloudflareContext. A dynamic import resolves a context whose bindings the
// OpenNext bundle never wired.
//
// The repo has no generated CloudflareEnv type, so the slice of the Worker env
// this feature reads is declared here.

import { getCloudflareContext } from "@opennextjs/cloudflare";

/** The slice of an R2 object we use (avoids a @cloudflare/workers-types dep). */
export interface R2ObjectBodyLike {
  body: ReadableStream<Uint8Array>;
  size: number;
  httpEtag?: string;
  customMetadata?: Record<string, string>;
}

export interface R2PutOptionsLike {
  httpMetadata?: { contentType?: string; cacheControl?: string };
  customMetadata?: Record<string, string>;
}

/** The slice of the R2 bucket API we use. */
export interface R2BucketLike {
  put(key: string, value: ArrayBuffer | Uint8Array, options?: R2PutOptionsLike): Promise<unknown>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  delete(keys: string | string[]): Promise<void>;
}

/** The Worker env fields the webcam archive reads. */
export interface CamFramesEnv {
  CAM_FRAMES?: R2BucketLike;
  /** Bearer token for POST /api/cam-frames (shared with the capture script). */
  INGEST_TOKEN?: string;
  /** HMAC key for signed image URLs. */
  CAM_FRAME_URL_KEY?: string;
}

/** The `CAM_FRAMES` bucket, or null when this runtime has no such binding. */
export async function getCamFramesBucket(): Promise<R2BucketLike | null> {
  try {
    const ctx = await getCloudflareContext({ async: true });
    const env = ctx?.env as CamFramesEnv | undefined;
    const bucket = env?.CAM_FRAMES;
    return bucket &&
      typeof bucket.put === "function" &&
      typeof bucket.get === "function" &&
      typeof bucket.delete === "function"
      ? bucket
      : null;
  } catch {
    return null; // no bindings (plain `next dev`, tests) -> fail closed
  }
}
