import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  bearerToken,
  hasJpegMagic,
  MAX_FRAME_BYTES,
  MIN_FRAME_BYTES,
  readBodyCapped,
  sha256Hex,
} from "@/lib/camFrames/ingest";
import { fakeJpeg } from "@/lib/camFrames/testFixtures";

/** A request whose body arrives in `chunks`-sized pieces, so the cap is hit mid-stream. */
function streamed(total: number, chunk: number, pulls: { n: number }): Request {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls.n += 1;
      const n = Math.min(chunk, total - sent);
      if (n <= 0) return controller.close();
      controller.enqueue(new Uint8Array(n).fill(0xab));
      sent += n;
    },
  });
  return new Request("http://localhost/x", { method: "POST", body, duplex: "half" } as RequestInit);
}

describe("limits", () => {
  it("are 600 KB and 10 KB", () => {
    expect(MAX_FRAME_BYTES).toBe(614_400);
    expect(MIN_FRAME_BYTES).toBe(10_240);
  });
});

describe("hasJpegMagic", () => {
  it("needs FF D8 FF", () => {
    expect(hasJpegMagic(fakeJpeg(100))).toBe(true);
    expect(hasJpegMagic(new Uint8Array([0xff, 0xd8, 0xff]))).toBe(true);
    expect(hasJpegMagic(new Uint8Array([0xff, 0xd8]))).toBe(false);
    expect(hasJpegMagic(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
    expect(hasJpegMagic(new TextEncoder().encode("<html>"))).toBe(false);
    expect(hasJpegMagic(new Uint8Array())).toBe(false);
  });
});

describe("sha256Hex", () => {
  it("matches node's sha256", async () => {
    const b = fakeJpeg(5000, 3);
    expect(await sha256Hex(b)).toBe(createHash("sha256").update(b).digest("hex"));
  });
});

describe("bearerToken", () => {
  it("extracts the token and is empty for anything else", () => {
    expect(bearerToken("Bearer abc123")).toBe("abc123");
    expect(bearerToken("bearer abc123")).toBe("abc123");
    expect(bearerToken("Bearer  abc123  ")).toBe("abc123");
    expect(bearerToken("Basic abc123")).toBe("");
    expect(bearerToken("Bearer")).toBe("");
    expect(bearerToken("Bearer a b")).toBe("");
    expect(bearerToken(null)).toBe("");
  });
});

describe("readBodyCapped", () => {
  it("reads a normal body whole", async () => {
    const bytes = fakeJpeg(30_000);
    const r = await readBodyCapped(new Request("http://localhost/x", { method: "POST", body: bytes as BodyInit }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(Buffer.compare(Buffer.from(r.bytes), Buffer.from(bytes))).toBe(0);
  });

  it("accepts a body of exactly the cap", async () => {
    const r = await readBodyCapped(new Request("http://localhost/x", { method: "POST", body: new Uint8Array(MAX_FRAME_BYTES) as BodyInit }));
    expect(r.ok).toBe(true);
  });

  it("refuses a body one byte over the cap", async () => {
    const r = await readBodyCapped(new Request("http://localhost/x", { method: "POST", body: new Uint8Array(MAX_FRAME_BYTES + 1) }));
    expect(r).toEqual({ ok: false, reason: "too-large" });
  });

  it("stops reading a long stream early instead of buffering it all", async () => {
    const pulls = { n: 0 };
    // 50 MB offered in 64 KB chunks; the cap must end it after about ten pulls.
    const r = await readBodyCapped(streamed(50 * 1024 * 1024, 64 * 1024, pulls));
    expect(r).toEqual({ ok: false, reason: "too-large" });
    expect(pulls.n).toBeLessThan(40);
  });

  it("reports an empty body", async () => {
    expect(await readBodyCapped(new Request("http://localhost/x", { method: "POST" }))).toEqual({ ok: false, reason: "empty" });
    expect(await readBodyCapped(new Request("http://localhost/x", { method: "POST", body: new Uint8Array() }))).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("reports a stream that errors", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(10));
        c.error(new Error("boom"));
      },
    });
    const r = await readBodyCapped(new Request("http://localhost/x", { method: "POST", body, duplex: "half" } as RequestInit));
    expect(r).toEqual({ ok: false, reason: "read-error" });
  });
});
