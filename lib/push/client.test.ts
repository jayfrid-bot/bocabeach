import { describe, it, expect } from "vitest";
import { urlBase64ToUint8Array } from "@/lib/push/client";

describe("urlBase64ToUint8Array", () => {
  it("decodes a base64url VAPID public key to a 65-byte EC point", () => {
    const key =
      "BAMTLd1VYiUTBGNFZ74Z8ENhftxMkGD9TZG6fbipGMfAdCAM_OSpGxjYDrWp3e7PNgPtnNKOcaU_5eR8AyMjjOU";
    const bytes = urlBase64ToUint8Array(key);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(65); // uncompressed P-256 public key
    expect(bytes[0]).toBe(0x04); // uncompressed-point marker
  });

  it("handles base64url chars (- and _) and missing padding", () => {
    // "-_" → bytes 0xfb 0xff with standard base64url decoding.
    const bytes = urlBase64ToUint8Array("-_8");
    expect(Array.from(bytes)).toEqual([0xfb, 0xff]);
  });
});
