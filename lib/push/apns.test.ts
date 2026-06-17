import { describe, it, expect } from "vitest";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { buildApnsJwt, isDeadToken } from "@/lib/push/apns";

function p256Pem(): { pem: string; publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"] } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { pem: privateKey.export({ type: "pkcs8", format: "pem" }) as string, publicKey };
}

describe("buildApnsJwt", () => {
  it("produces an ES256 JWT with the right header/claims and a valid signature", () => {
    const { pem, publicKey } = p256Pem();
    const jwt = buildApnsJwt(
      { keyId: "ABC123KEYX", teamId: "TEAM123456", privateKey: pem },
      1_700_000_000,
    );
    const [h, p, s] = jwt.split(".");
    expect(h && p && s).toBeTruthy();
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({
      alg: "ES256",
      kid: "ABC123KEYX",
    });
    expect(JSON.parse(Buffer.from(p, "base64url").toString())).toEqual({
      iss: "TEAM123456",
      iat: 1_700_000_000,
    });
    // The signature must verify as raw r||s (JOSE/ieee-p1363), not DER.
    const ok = createVerify("SHA256")
      .update(`${h}.${p}`)
      .verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
    expect(ok).toBe(true);
  });

  it("floors a fractional iat to whole seconds", () => {
    const { pem } = p256Pem();
    const jwt = buildApnsJwt({ keyId: "K", teamId: "T", privateKey: pem }, 1700.987);
    expect(JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()).iat).toBe(1700);
  });
});

describe("isDeadToken", () => {
  it("prunes 410 and 400/BadDeviceToken, keeps transient failures and successes", () => {
    expect(isDeadToken({ ok: false, status: 410, reason: "Unregistered" })).toBe(true);
    expect(isDeadToken({ ok: false, status: 400, reason: "BadDeviceToken" })).toBe(true);
    expect(isDeadToken({ ok: false, status: 400, reason: "PayloadTooLarge" })).toBe(false);
    expect(isDeadToken({ ok: false, status: 429, reason: "TooManyRequests" })).toBe(false);
    expect(isDeadToken({ ok: false, reason: "network error" })).toBe(false);
    expect(isDeadToken({ ok: true, status: 200 })).toBe(false);
  });
});
