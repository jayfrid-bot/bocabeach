// enableNative / disableNative and the install token: the app claims its token
// before a push change, sends it with the registration, never loops on a 401,
// and keeps alerts shown as ON until the server has confirmed a turn-off (a
// failed turn-off is saved and retried).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const DEV = "11111111-2222-4333-8444-555555555555";
const PUSH = "f".repeat(80);

const ctl = vi.hoisted(() => ({ claimToken: null as string | null, claimCalls: 0 }));

vi.mock("@/lib/deviceId", () => ({ getDeviceId: () => DEV }));
vi.mock("@/lib/plus/installToken", () => ({
  claimInstallToken: async () => {
    ctl.claimCalls += 1;
    return { token: ctl.claimToken, device: null };
  },
}));

const { enableNative, disableNative, flushPendingUnregister } = await import("@/lib/push/native");
const store = await import("@/lib/plus/storage");

interface Call {
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}
let calls: Call[];
let replies: (Response | Error)[];
let map: Map<string, string>;

const reply = (status: number, body: unknown = { ok: status < 300 }) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  ctl.claimToken = "tok-1";
  ctl.claimCalls = 0;
  calls = [];
  replies = [];
  map = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
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
    const next = replies.shift() ?? reply(200);
    if (next instanceof Error) throw next;
    return next;
  });
});

afterEach(() => vi.unstubAllGlobals());

const PREFS = { morning: true, safety: true };

describe("enableNative", () => {
  it("claims the token first and sends it with the registration", async () => {
    await enableNative("boca-raton", PREFS);
    expect(ctl.claimCalls).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/api/push/register-native");
    expect(calls[0].headers["x-install-token"]).toBe("tok-1");
    expect(calls[0].body.deviceId).toBe(DEV);
    expect(map.get("native-push:boca-raton")).toBe(PUSH);
  });

  it("falls back to the saved token when the claim could not confirm", async () => {
    ctl.claimToken = null;
    store.writeInstallToken("saved-token");
    await enableNative("boca-raton", PREFS);
    expect(calls[0].headers["x-install-token"]).toBe("saved-token");
  });

  it("a 401 is not retried (nothing could change the answer): plain message, alerts not marked on", async () => {
    replies = [reply(401, { ok: false, error: "no-token" })];
    await expect(enableNative("boca-raton", PREFS)).rejects.toThrow(/could not confirm this is your phone/);
    expect(calls).toHaveLength(1);
    expect(map.has("native-push:boca-raton")).toBe(false);
  });

  it("never deletes the saved install token", async () => {
    store.writeInstallToken("saved-token");
    replies = [reply(401, { ok: false })];
    await expect(enableNative("boca-raton", PREFS)).rejects.toThrow();
    expect(store.readInstallToken()).toBe("saved-token");
  });

  it("a server error leaves alerts off and says how many tries", async () => {
    replies = [reply(500, { ok: false })];
    await expect(enableNative("boca-raton", PREFS)).rejects.toThrow(/\(500\)/);
    expect(map.has("native-push:boca-raton")).toBe(false);
  });

  it("a successful registration drops any queued turn-off for that push token", async () => {
    store.queuePendingUnregister(PUSH);
    await enableNative("boca-raton", PREFS);
    expect(store.readPendingUnregister()).toEqual([]);
  });
});

describe("disableNative", () => {
  beforeEach(() => {
    map.set("native-push:boca-raton", PUSH);
    store.writeInstallToken("tok-1");
  });

  it("sends the saved token, never mints one, and clears the local flag only after the server said yes", async () => {
    await disableNative("boca-raton");
    expect(calls[0].path).toBe("/api/push/unregister-native");
    expect(calls[0].headers["x-install-token"]).toBe("tok-1");
    expect(ctl.claimCalls).toBe(0);
    expect(map.has("native-push:boca-raton")).toBe(false);
  });

  it("when the network fails: alerts stay ON locally, the turn-off is queued, and the message says so", async () => {
    replies = [new Error("offline")];
    await expect(disableNative("boca-raton")).rejects.toThrow(/keep trying/);
    expect(map.get("native-push:boca-raton")).toBe(PUSH);
    expect(store.readPendingUnregister()).toEqual([PUSH]);
  });

  it("when the server fails (5xx): same — stays on, queued", async () => {
    replies = [reply(503, { ok: false })];
    await expect(disableNative("boca-raton")).rejects.toThrow();
    expect(map.get("native-push:boca-raton")).toBe(PUSH);
    expect(store.readPendingUnregister()).toEqual([PUSH]);
  });

  it("a 401 stays on and throws a plain message, but is not queued (it would never succeed)", async () => {
    replies = [reply(401, { ok: false, error: "no-token" })];
    await expect(disableNative("boca-raton")).rejects.toThrow(/could not confirm this is your phone/);
    expect(map.get("native-push:boca-raton")).toBe(PUSH);
    expect(store.readPendingUnregister()).toEqual([]);
    expect(store.readInstallToken()).toBe("tok-1"); // not deleted
  });
});

describe("flushPendingUnregister", () => {
  beforeEach(() => {
    map.set("native-push:boca-raton", PUSH);
    store.writeInstallToken("tok-1");
    store.queuePendingUnregister(PUSH);
  });

  it("retries the queued turn-off, and on success clears the queue and the local flag", async () => {
    await flushPendingUnregister();
    expect(calls).toHaveLength(1);
    expect(calls[0].body.token).toBe(PUSH);
    expect(calls[0].headers["x-install-token"]).toBe("tok-1");
    expect(store.readPendingUnregister()).toEqual([]);
    expect(map.has("native-push:boca-raton")).toBe(false);
  });

  it("keeps it queued while the server is still unreachable", async () => {
    replies = [new Error("offline")];
    await flushPendingUnregister();
    expect(store.readPendingUnregister()).toEqual([PUSH]);
    expect(map.get("native-push:boca-raton")).toBe(PUSH);
  });
});
