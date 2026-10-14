// enableNative / disableNative and the install token: the app must send
// `x-install-token` with every change to its push target, get a token when it
// has none, keep a token the server hands back, retry once on a 401, and say so
// plainly when the server still refuses.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const DEV = "11111111-2222-4333-8444-555555555555";
const PUSH = "f".repeat(80);

const ctl = vi.hoisted(() => ({
  /** What bootstrapInstallToken resolves for each call, in order. */
  bootstrapResults: [] as (string | null)[],
  bootstrapCalls: [] as ({ forceRefresh?: boolean } | undefined)[],
}));

vi.mock("@/lib/deviceId", () => ({ getDeviceId: () => DEV }));
vi.mock("@/lib/plus/client", () => ({
  bootstrapInstallToken: async (opts?: { forceRefresh?: boolean }) => {
    ctl.bootstrapCalls.push(opts);
    return { token: ctl.bootstrapResults.shift() ?? null, device: null };
  },
}));

const { enableNative, disableNative } = await import("@/lib/push/native");
const { readInstallToken } = await import("@/lib/plus/storage");

interface Call {
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}
let calls: Call[];
let replies: Response[];
let storage: Map<string, string>;

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  ctl.bootstrapResults = [];
  ctl.bootstrapCalls = [];
  calls = [];
  replies = [];
  storage = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  });
  vi.stubGlobal("window", {
    Capacitor: {
      getPlatform: () => "android",
      isPluginAvailable: () => true,
      Plugins: {
        PushNotifications: {
          requestPermissions: async () => ({ receive: "granted" }),
          checkPermissions: async () => ({ receive: "granted" }),
          addListener: (name: string, cb: (t: { value: string }) => void) => {
            if (name === "registration") queueMicrotask(() => cb({ value: PUSH }));
            return Promise.resolve();
          },
          register: async () => {},
        },
      },
    },
  });
  vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
    calls.push({
      path,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    return replies.shift() ?? reply(200, { ok: true });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const PREFS = { morning: true, safety: true };

describe("enableNative", () => {
  it("gets a token first (minting one for a fresh device) and sends it with the registration", async () => {
    ctl.bootstrapResults = ["tok-1"];
    await enableNative("boca-raton", PREFS);
    expect(ctl.bootstrapCalls).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/api/push/register-native");
    expect(calls[0].headers["x-install-token"]).toBe("tok-1");
    expect(calls[0].body.deviceId).toBe(DEV);
    expect(storage.get("native-push:boca-raton")).toBe(PUSH);
  });

  it("sends no header when the phone has no token (the server issues one on this call)", async () => {
    ctl.bootstrapResults = [null];
    replies = [reply(200, { ok: true, installToken: "claimed-by-register" })];
    await enableNative("boca-raton", PREFS);
    expect(calls[0].headers["x-install-token"]).toBeUndefined();
    // ...and the phone keeps the token the server handed back.
    expect(readInstallToken()).toBe("claimed-by-register");
  });

  it("keeps a token returned alongside a 500 (the claim landed, the write did not)", async () => {
    ctl.bootstrapResults = [null];
    replies = [reply(500, { error: "x", installToken: "claimed-then-failed" })];
    await expect(enableNative("boca-raton", PREFS)).rejects.toThrow();
    expect(readInstallToken()).toBe("claimed-then-failed");
    expect(storage.get("native-push:boca-raton")).toBeUndefined();
  });

  it("on a 401 asks for a fresh token once and retries with it", async () => {
    ctl.bootstrapResults = ["stale", "fresh"];
    replies = [reply(401, { ok: false, error: "no-token" }), reply(200, { ok: true })];
    await enableNative("boca-raton", PREFS);
    expect(ctl.bootstrapCalls).toEqual([undefined, { forceRefresh: true }]);
    expect(calls.map((c) => c.headers["x-install-token"])).toEqual(["stale", "fresh"]);
  });

  it("if the server still refuses, says so in plain words and does not mark alerts on", async () => {
    ctl.bootstrapResults = ["stale", "stale"];
    replies = [reply(401, { ok: false }), reply(401, { ok: false })];
    await expect(enableNative("boca-raton", PREFS)).rejects.toThrow(/could not confirm this is your phone/);
    expect(calls).toHaveLength(2); // one retry, no loop
    expect(storage.get("native-push:boca-raton")).toBeUndefined();
  });
});

describe("disableNative", () => {
  beforeEach(() => {
    storage.set("native-push:boca-raton", PUSH);
    storage.set("bd:install-token", "tok-1");
  });

  it("sends the stored token and clears the local flag", async () => {
    await disableNative("boca-raton");
    expect(calls[0].path).toBe("/api/push/unregister-native");
    expect(calls[0].headers["x-install-token"]).toBe("tok-1");
    expect(ctl.bootstrapCalls).toHaveLength(0); // turning alerts off never mints a device record
    expect(storage.has("native-push:boca-raton")).toBe(false);
  });

  it("when the server refuses (401), keeps alerts shown as on and throws", async () => {
    replies = [reply(401, { ok: false, error: "no-token" })];
    await expect(disableNative("boca-raton")).rejects.toThrow(/Couldn't turn alerts off/);
    expect(storage.get("native-push:boca-raton")).toBe(PUSH);
  });

  it("an offline phone still clears locally, as before", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    await disableNative("boca-raton");
    expect(storage.has("native-push:boca-raton")).toBe(false);
  });
});
