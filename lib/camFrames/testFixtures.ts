// Test fixtures for the webcam archive. Only *.test.ts files import this.

import type { R2BucketLike, R2PutOptionsLike } from "@/lib/camFrames/r2";
import type { CamFrameRow } from "@/lib/camFrames/store";

/** A fake JPEG: real signature (FF D8 FF E0) and end marker, filler between. `seed` varies the bytes. */
export function fakeJpeg(size: number = 20_000, seed: number = 1): Uint8Array {
  const out = new Uint8Array(size);
  out[0] = 0xff;
  out[1] = 0xd8;
  out[2] = 0xff;
  out[3] = 0xe0;
  for (let i = 4; i < size - 2; i++) out[i] = (i * 31 + seed * 17) & 0xff;
  out[size - 2] = 0xff;
  out[size - 1] = 0xd9;
  return out;
}

export interface FakeBucket extends R2BucketLike {
  objects: Map<string, { bytes: Uint8Array; options?: R2PutOptionsLike }>;
  /** Make the next put() reject. */
  failPut: boolean;
  /** Make delete() reject. */
  failDelete: boolean;
  deleted: string[];
}

export function fakeBucket(): FakeBucket {
  const bucket: FakeBucket = {
    objects: new Map(),
    failPut: false,
    failDelete: false,
    deleted: [],
    async put(key, value, options) {
      if (bucket.failPut) throw new Error("r2 put failed (test)");
      bucket.objects.set(key, { bytes: value instanceof Uint8Array ? value : new Uint8Array(value), options });
      return {};
    },
    async get(key) {
      const o = bucket.objects.get(key);
      if (!o) return null;
      return { body: new Blob([o.bytes as BlobPart]).stream() as ReadableStream<Uint8Array>, size: o.bytes.byteLength };
    },
    async delete(keys) {
      if (bucket.failDelete) throw new Error("r2 delete failed (test)");
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        bucket.deleted.push(k);
        bucket.objects.delete(k);
      }
    },
  };
  return bucket;
}

/** Two distinct claim ids (UUID shape; the first 8 characters go in R2 keys). */
export const CLAIM_A = "cccccccc-0000-4000-8000-000000000001";
export const CLAIM_B = "dddddddd-0000-4000-8000-000000000002";

/** A complete row for store tests; override any field. */
export function frameRow(over: Partial<CamFrameRow> = {}): CamFrameRow {
  return {
    slug: "boca-raton",
    cam_id: "boca-south",
    slot_utc: "2026-10-11T14:00:00.000Z",
    slot_kind: "hour",
    received_at_utc: "2026-10-11T14:20:00.000Z",
    frame_at_utc: null,
    display_at_utc: "2026-10-11T14:20:00.000Z",
    local_date: "2026-10-11",
    local_hour: 10,
    local_minute: 20,
    utc_offset_minutes: -240,
    timezone: "America/New_York",
    r2_key: "boca-raton/boca-south/2026-10-11/1420Z-01234567-cccccccc.jpg",
    bytes: 20_000,
    sha256: "0123456789abcdef".repeat(4),
    source_kind: "feed",
    attribution: "Live still courtesy Palm Beach County ERM / video-monitoring.com",
    claim_id: CLAIM_A,
    claimed_at_utc: over.received_at_utc ?? "2026-10-11T14:20:00.000Z",
    ...over,
  };
}
