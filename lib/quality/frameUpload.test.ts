import { describe, expect, it } from "vitest";
import { decodeAlertFrame, MAX_ALERT_FRAME_BYTES, storeAlertFrame } from "@/lib/quality/frameUpload";
import { fakeBucket } from "@/lib/camFrames/testFixtures";
import { parseQualityFrameKey } from "@/lib/camFrames/keys";

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}
function jpegOf(n: number, magic = [0xff, 0xd8, 0xff]): Uint8Array {
  const out = new Uint8Array(n).fill(7);
  out.set(magic);
  return out;
}

describe("decodeAlertFrame", () => {
  it("accepts a JPEG between 1 KB and 150 KB", () => {
    expect(decodeAlertFrame(b64(jpegOf(1024)))?.length).toBe(1024);
    expect(decodeAlertFrame(b64(jpegOf(MAX_ALERT_FRAME_BYTES)))?.length).toBe(MAX_ALERT_FRAME_BYTES);
  });

  it("refuses too small, too large, not a JPEG, and not base64", () => {
    expect(decodeAlertFrame(b64(jpegOf(1023)))).toBeNull();
    expect(decodeAlertFrame(b64(jpegOf(MAX_ALERT_FRAME_BYTES + 1)))).toBeNull();
    expect(decodeAlertFrame(b64(jpegOf(5000, [0x89, 0x50, 0x4e])))).toBeNull(); // a PNG
    for (const bad of ["", "abc", "!!!!", "ab cd=", "====", 5, null, undefined, {}]) expect(decodeAlertFrame(bad)).toBeNull();
    expect(decodeAlertFrame("A".repeat(300_000))).toBeNull(); // far over the text limit
  });
});

describe("storeAlertFrame", () => {
  const AT = Date.parse("2026-10-13T17:20:15.000Z");

  it("puts the bytes under quality/ with a key built from the time and the bytes' own hash", async () => {
    const bucket = fakeBucket();
    const bytes = jpegOf(4000);
    const key = await storeAlertFrame(bucket, { slug: "boca-raton", camId: "boca-inlet-surf", atMs: AT, bytes });
    expect(key).toMatch(/^quality\/boca-raton\/boca-inlet-surf\/2026-10-13\/172015Z-[0-9a-f]{8}\.jpg$/);
    expect(parseQualityFrameKey(key)).not.toBeNull();
    expect(bucket.objects.get(key!)?.bytes).toEqual(bytes);
    expect(bucket.objects.get(key!)?.options?.httpMetadata?.contentType).toBe("image/jpeg");
  });

  it("the same bytes at the same time make the same key (a retry overwrites, never duplicates)", async () => {
    const bucket = fakeBucket();
    const a = await storeAlertFrame(bucket, { slug: "boca-raton", camId: "boca-inlet-surf", atMs: AT, bytes: jpegOf(4000) });
    const b = await storeAlertFrame(bucket, { slug: "boca-raton", camId: "boca-inlet-surf", atMs: AT, bytes: jpegOf(4000) });
    expect(a).toBe(b);
    expect(bucket.objects.size).toBe(1);
  });

  it("returns null, never throws, with no bucket, a put error, or a bad cam", async () => {
    expect(await storeAlertFrame(null, { slug: "boca-raton", camId: "c", atMs: AT, bytes: jpegOf(2000) })).toBeNull();
    const bucket = fakeBucket();
    bucket.failPut = true;
    const spy = (await import("vitest")).vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await storeAlertFrame(bucket, { slug: "boca-raton", camId: "c", atMs: AT, bytes: jpegOf(2000) })).toBeNull();
    expect(await storeAlertFrame(fakeBucket(), { slug: "Bad Slug", camId: "c", atMs: AT, bytes: jpegOf(2000) })).toBeNull();
    spy.mockRestore();
  });
});
