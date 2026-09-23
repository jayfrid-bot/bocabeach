import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { buildApnsJwt, isDeadToken, openApnsSession, openLiveActivitySessions } from "@/lib/push/apns";

// --- A fake node:http2 for openApnsSession's `send` / `sendLiveActivityUpdate` ---
// Captures every `client.request(headers)` + the body passed to `.end(body)`,
// and answers with a scripted status (200 by default) synchronously off the
// `response`/`data`/`end` handlers openApnsSession registers — no real
// network, no real device token.
interface FakeRequest {
  headers: Record<string, string | number>;
  body: string;
}
let capturedRequests: FakeRequest[] = [];
let scriptedStatus = 200;
let scriptedBody = "";

function fakeClient() {
  return {
    on: () => {},
    close: () => {},
    request(headers: Record<string, string | number>) {
      const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
      const req = {
        on(event: string, cb: (...args: unknown[]) => void) {
          (listeners[event] ??= []).push(cb);
          return req;
        },
        setEncoding() {
          /* no-op */
        },
        end(body: string) {
          capturedRequests.push({ headers, body });
          for (const cb of listeners.response ?? []) cb({ ":status": scriptedStatus });
          for (const cb of listeners.data ?? []) cb(scriptedBody);
          for (const cb of listeners.end ?? []) cb();
        },
      };
      return req;
    },
  };
}

let connectedHosts: string[] = [];

vi.mock("node:http2", () => {
  const connect = (host: string) => {
    connectedHosts.push(host);
    return fakeClient();
  };
  return { connect, default: { connect } };
});

function testCfg() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    keyId: "K",
    teamId: "T",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    bundleId: "com.isitbeachday.app",
    production: true,
  };
}

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

describe("openApnsSession — alert `send` stays byte-for-byte unchanged", () => {
  beforeEach(() => {
    capturedRequests = [];
    scriptedStatus = 200;
    scriptedBody = "";
  });

  it("sends the same headers/topic/payload shape as before the Live Activity path was added", async () => {
    const session = openApnsSession(testCfg(), 1_700_000_000);
    const r = await session.send("deadbeef".repeat(8), {
      title: "Lightning nearby",
      body: "2 mi away",
      url: "/boca-raton",
      tag: "safety:lightning:boca-raton",
      expiration: 1_700_003_600,
    });
    session.close();

    expect(r).toEqual({ ok: true, status: 200 });
    expect(capturedRequests).toHaveLength(1);
    const { headers, body } = capturedRequests[0];
    expect(headers[":method"]).toBe("POST");
    expect(headers[":path"]).toBe(`/3/device/${"deadbeef".repeat(8)}`);
    expect(headers["apns-topic"]).toBe("com.isitbeachday.app");
    expect(headers["apns-push-type"]).toBe("alert");
    expect(headers["apns-expiration"]).toBe("1700003600");
    expect(headers["apns-collapse-id"]).toBe("safety:lightning:boca-raton");
    expect(headers["apns-priority"]).toBeUndefined(); // the alert path never sets this
    expect(JSON.parse(body)).toEqual({
      aps: { alert: { title: "Lightning nearby", body: "2 mi away" }, sound: "default" },
      url: "/boca-raton",
    });
  });
});

describe("sendLiveActivityUpdate — the liveactivity push-type path", () => {
  beforeEach(() => {
    capturedRequests = [];
    scriptedStatus = 200;
    scriptedBody = "";
  });

  it("uses apns-push-type: liveactivity and the .push-type.liveactivity topic", async () => {
    const session = openApnsSession(testCfg(), 1_700_000_000);
    const r = await session.sendLiveActivityUpdate("cafebabe".repeat(8), {
      contentState: { score: 82, updatedAt: 1_700_000_000_000 },
      event: "update",
      timestampMs: 1_700_000_000_000,
      staleDateMs: 1_700_001_500_000,
      relevanceScore: 50,
      priority: 5,
    });
    session.close();

    expect(r).toEqual({ ok: true, status: 200 });
    expect(capturedRequests).toHaveLength(1);
    const { headers, body } = capturedRequests[0];
    expect(headers[":path"]).toBe(`/3/device/${"cafebabe".repeat(8)}`);
    expect(headers["apns-push-type"]).toBe("liveactivity");
    expect(headers["apns-topic"]).toBe("com.isitbeachday.app.push-type.liveactivity");
    expect(headers["apns-priority"]).toBe("5");
    expect(JSON.parse(body)).toEqual({
      aps: {
        timestamp: 1_700_000_000,
        event: "update",
        "content-state": { score: 82, updatedAt: 1_700_000_000_000 },
        "stale-date": 1_700_001_500,
        "relevance-score": 50,
      },
    });
  });

  it("an 'end' event carries dismissal-date and omits stale-date/relevance-score when unset", async () => {
    const session = openApnsSession(testCfg(), 1_700_000_000);
    await session.sendLiveActivityUpdate("cafebabe".repeat(8), {
      contentState: { score: 0, updatedAt: 1_700_000_000_000, unavailable: true },
      event: "end",
      timestampMs: 1_700_000_000_000,
      dismissalDateMs: 1_700_000_900_000,
      priority: 10,
    });
    session.close();
    const { headers, body } = capturedRequests[0];
    expect(headers["apns-priority"]).toBe("10");
    const payload = JSON.parse(body);
    expect(payload.aps.event).toBe("end");
    expect(payload.aps["dismissal-date"]).toBe(1_700_000_900);
    expect(payload.aps["stale-date"]).toBeUndefined();
    expect(payload.aps["relevance-score"]).toBeUndefined();
  });

  it("maps a 410 to a dead-token result, same rule as the alert path (isDeadToken)", async () => {
    scriptedStatus = 410;
    scriptedBody = JSON.stringify({ reason: "Unregistered" });
    const session = openApnsSession(testCfg(), 1_700_000_000);
    const r = await session.sendLiveActivityUpdate("cafebabe".repeat(8), {
      contentState: { score: 1, updatedAt: 0 },
      event: "update",
      timestampMs: 1_700_000_000_000,
      priority: 5,
    });
    session.close();
    expect(r.ok).toBe(false);
    expect(isDeadToken(r)).toBe(true);
  });
});

describe("openLiveActivitySessions — one client per environment (Codex review #5)", () => {
  beforeEach(() => {
    capturedRequests = [];
    scriptedStatus = 200;
    scriptedBody = "";
    connectedHosts = [];
  });

  it("routes a sandbox row to the sandbox host even when this server's own config is production", async () => {
    const sessions = openLiveActivitySessions(testCfg(), 1_700_000_000); // testCfg().production === true
    await sessions.sendLiveActivityUpdate(
      "cafebabe".repeat(8),
      { contentState: { score: 1, updatedAt: 0 }, event: "update", timestampMs: 1_700_000_000_000, priority: 5 },
      "sandbox",
    );
    sessions.close();
    expect(connectedHosts).toEqual(["https://api.sandbox.push.apple.com"]);
  });

  it("routes a production row to the production host", async () => {
    const sessions = openLiveActivitySessions(testCfg(), 1_700_000_000);
    await sessions.sendLiveActivityUpdate(
      "cafebabe".repeat(8),
      { contentState: { score: 1, updatedAt: 0 }, event: "update", timestampMs: 1_700_000_000_000, priority: 5 },
      "production",
    );
    sessions.close();
    expect(connectedHosts).toEqual(["https://api.push.apple.com"]);
  });

  it("a null environment falls back to the server's own cfg.production", async () => {
    const sessions = openLiveActivitySessions({ ...testCfg(), production: false }, 1_700_000_000);
    await sessions.sendLiveActivityUpdate(
      "cafebabe".repeat(8),
      { contentState: { score: 1, updatedAt: 0 }, event: "update", timestampMs: 1_700_000_000_000, priority: 5 },
      null,
    );
    sessions.close();
    expect(connectedHosts).toEqual(["https://api.sandbox.push.apple.com"]);
  });

  it("opens each environment's connection at most once, even across several sends", async () => {
    const sessions = openLiveActivitySessions(testCfg(), 1_700_000_000);
    const args = [
      { contentState: { score: 1, updatedAt: 0 }, event: "update" as const, timestampMs: 1, priority: 5 as const },
    ];
    await sessions.sendLiveActivityUpdate("cafebabe".repeat(8), args[0], "sandbox");
    await sessions.sendLiveActivityUpdate("cafebabe".repeat(8), args[0], "sandbox");
    await sessions.sendLiveActivityUpdate("cafebabe".repeat(8), args[0], "production");
    sessions.close();
    expect(connectedHosts.sort()).toEqual(["https://api.push.apple.com", "https://api.sandbox.push.apple.com"]);
  });
});
