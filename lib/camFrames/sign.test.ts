import { describe, it, expect, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { DEFAULT_TTL_SEC, MAX_EXP_AHEAD_SEC, sign, verify } from "@/lib/camFrames/sign";

const KEY = "unit-test-signing-key-not-a-secret";
const K = "boca-raton/boca-south/2026-10-11/1405Z-01234567.jpg";
const NOW = 1_760_192_400;

afterEach(() => {
  delete process.env.CAM_FRAME_URL_KEY;
});

describe("sign", () => {
  it("signs `k|exp` with HMAC-SHA256 and base64url, 15 minutes by default", async () => {
    const s = await sign(K, undefined, { nowSec: NOW, key: KEY });
    expect(s.exp).toBe(NOW + 900);
    expect(DEFAULT_TTL_SEC).toBe(900);
    const expected = createHmac("sha256", KEY).update(`${K}|${s.exp}`).digest("base64url");
    expect(s.sig).toBe(expected);
    expect(s.sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("reads CAM_FRAME_URL_KEY from the environment", async () => {
    process.env.CAM_FRAME_URL_KEY = KEY;
    const s = await sign(K, 600, { nowSec: NOW });
    expect(s.exp).toBe(NOW + 600);
    expect(await verify(K, s.exp, s.sig, NOW)).toBe(true);
  });

  it("throws on a malformed key, a missing signing key, or a bad ttl", async () => {
    await expect(sign("../etc/passwd", 900, { key: KEY })).rejects.toThrow();
    await expect(sign(K, 900)).rejects.toThrow(/CAM_FRAME_URL_KEY/);
    await expect(sign(K, 0, { key: KEY })).rejects.toThrow();
    await expect(sign(K, 1.5, { key: KEY })).rejects.toThrow();
    await expect(sign(K, MAX_EXP_AHEAD_SEC + 1, { key: KEY })).rejects.toThrow();
  });
});

describe("verify", () => {
  it("accepts a fresh signature, with exp as a string or a number", async () => {
    const s = await sign(K, 900, { nowSec: NOW, key: KEY });
    expect(await verify(K, String(s.exp), s.sig, NOW, { key: KEY })).toBe(true);
    expect(await verify(K, s.exp, s.sig, NOW, { key: KEY })).toBe(true);
    expect(await verify(K, s.exp, s.sig, NOW + 899, { key: KEY })).toBe(true);
  });

  it("rejects an expired link, including exp equal to now", async () => {
    const s = await sign(K, 900, { nowSec: NOW, key: KEY });
    expect(await verify(K, s.exp, s.sig, s.exp, { key: KEY })).toBe(false);
    expect(await verify(K, s.exp, s.sig, s.exp + 1, { key: KEY })).toBe(false);
  });

  it("rejects an exp more than 20 minutes ahead even with a valid signature", async () => {
    // A 20-minute link passes; 20 minutes + 1 second does not.
    const ok = await sign(K, MAX_EXP_AHEAD_SEC, { nowSec: NOW, key: KEY });
    expect(await verify(K, ok.exp, ok.sig, NOW, { key: KEY })).toBe(true);
    const exp = NOW + MAX_EXP_AHEAD_SEC + 1;
    const sig = createHmac("sha256", KEY).update(`${K}|${exp}`).digest("base64url");
    expect(await verify(K, exp, sig, NOW, { key: KEY })).toBe(false);
  });

  it("rejects a changed key, expiry or signature", async () => {
    const s = await sign(K, 900, { nowSec: NOW, key: KEY });
    const other = "boca-raton/boca-south/2026-10-11/1405Z-89abcdef.jpg";
    expect(await verify(other, s.exp, s.sig, NOW, { key: KEY })).toBe(false);
    expect(await verify(K, s.exp + 1, s.sig, NOW, { key: KEY })).toBe(false);
    const flipped = (s.sig[0] === "A" ? "B" : "A") + s.sig.slice(1);
    expect(await verify(K, s.exp, flipped, NOW, { key: KEY })).toBe(false);
    expect(await verify(K, s.exp, s.sig, NOW, { key: "a-different-key" })).toBe(false);
  });

  it.each([
    ["decimal", "1760193300.5"],
    ["negative", "-1760193300"],
    ["exponent", "1.7601933e9"],
    ["hex", "0x69ea0000"],
    ["padded with space", " 1760193300"],
    ["empty", ""],
    ["too long", "1".repeat(13)],
    ["not a string or number", { a: 1 }],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["float", 1760193300.5],
  ])("rejects a non-integer exp: %s", async (_n, exp) => {
    const sig = "A".repeat(43);
    expect(await verify(K, exp, sig, NOW, { key: KEY })).toBe(false);
  });

  it("rejects a malformed k, never reaching the HMAC", async () => {
    const sig = createHmac("sha256", KEY).update(`x|${NOW + 60}`).digest("base64url");
    for (const k of ["x", "", "../a/b/2026-10-11/1405Z-01234567.jpg", undefined, 7]) {
      expect(await verify(k, NOW + 60, sig, NOW, { key: KEY })).toBe(false);
    }
  });

  it("rejects a malformed signature (length, alphabet, type)", async () => {
    const s = await sign(K, 900, { nowSec: NOW, key: KEY });
    for (const bad of [s.sig.slice(1), `${s.sig}A`, `${s.sig.slice(0, 42)}=`, `${s.sig.slice(0, 42)}+`, "", undefined, null, 5]) {
      expect(await verify(K, s.exp, bad, NOW, { key: KEY })).toBe(false);
    }
  });

  it("refuses everything when no signing key is configured", async () => {
    const s = await sign(K, 900, { nowSec: NOW, key: KEY });
    expect(await verify(K, s.exp, s.sig, NOW)).toBe(false);
  });
});
