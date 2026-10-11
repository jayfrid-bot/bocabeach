// Pure helpers for POST /api/cam-frames (docs/CAM_ARCHIVE_PLAN.md R4/R8): the
// bounded body read and the JPEG checks. Kept out of the route file so they
// are unit-testable without a Request pipeline.

/** Largest accepted JPEG: 600 KB. */
export const MAX_FRAME_BYTES = 600 * 1024;
/** Smallest accepted JPEG: 10 KB (a smaller body is an error page or a blank frame). */
export const MIN_FRAME_BYTES = 10 * 1024;

/** True when the bytes start with the JPEG signature FF D8 FF. */
export function hasJpegMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** Hex SHA-256 of the bytes. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  let out = "";
  for (const b of new Uint8Array(digest)) out += b.toString(16).padStart(2, "0");
  return out;
}

export type BodyRead =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "too-large" | "empty" | "read-error" };

/**
 * Read a request body incrementally and stop as soon as it passes `maxBytes`.
 * The stream is cancelled at that point, so an oversized or endless body never
 * sits whole in memory. (`readBody()` in lib/db/api.ts is for 8 KB JSON; it
 * buffers the full text and must not be used here.)
 */
export async function readBodyCapped(req: Request, maxBytes: number = MAX_FRAME_BYTES): Promise<BodyRead> {
  if (!req.body) return { ok: false, reason: "empty" };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too-large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "read-error" };
  }
  if (total === 0) return { ok: false, reason: "empty" };
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return { ok: true, bytes };
}

/** The bearer token from an Authorization header, or "" when absent or malformed. */
export function bearerToken(header: string | null): string {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return m ? m[1] : "";
}
