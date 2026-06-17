import { describe, it, expect } from "vitest";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { buildGoogleJwt, isDeadFcmToken } from "@/lib/push/fcm";

function rsaPem(): { pem: string; publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"] } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { pem: privateKey.export({ type: "pkcs8", format: "pem" }) as string, publicKey };
}

describe("buildGoogleJwt", () => {
  it("produces an RS256 JWT with FCM scope/audience and a valid signature", () => {
    const { pem, publicKey } = rsaPem();
    const jwt = buildGoogleJwt(
      { clientEmail: "svc@proj.iam.gserviceaccount.com", privateKey: pem },
      1_700_000_000,
    );
    const [h, p, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    expect(claims.iss).toBe("svc@proj.iam.gserviceaccount.com");
    expect(claims.scope).toBe("https://www.googleapis.com/auth/firebase.messaging");
    expect(claims.aud).toBe("https://oauth2.googleapis.com/token");
    expect(claims.iat).toBe(1_700_000_000);
    expect(claims.exp).toBe(1_700_003_600); // iat + 1h
    const ok = createVerify("RSA-SHA256")
      .update(`${h}.${p}`)
      .verify(publicKey, Buffer.from(s, "base64url"));
    expect(ok).toBe(true);
  });
});

describe("isDeadFcmToken", () => {
  it("prunes 404 / UNREGISTERED, keeps transient errors and successes", () => {
    expect(isDeadFcmToken({ ok: false, status: 404, reason: "NOT_FOUND" })).toBe(true);
    expect(isDeadFcmToken({ ok: false, status: 400, reason: "UNREGISTERED" })).toBe(true);
    expect(isDeadFcmToken({ ok: false, status: 400, reason: "INVALID_ARGUMENT" })).toBe(false);
    expect(isDeadFcmToken({ ok: false, status: 503, reason: "UNAVAILABLE" })).toBe(false);
    expect(isDeadFcmToken({ ok: true, status: 200 })).toBe(false);
  });
});
