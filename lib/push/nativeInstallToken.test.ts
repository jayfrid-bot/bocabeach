// enableNative / disableNative and the install token: the app claims its token
// before a push change, sends it with the registration, never loops on a 401,
// and keeps alerts shown as ON until the server has confirmed a turn-off (a
// failed turn-off is saved and retried).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const DEV = "11111111-2222-4333-8444-555555555555";
const PUSH = "f".repeat(80);

const ctl = vi.hoisted(() => ({ claimToken: null as string | null, claimCalls: 0 }));
/** The OS push plugin. `auto`: answer with PUSH at once; otherwise hold the answer until the test gives one. */
const pn = { auto: true, waiting: [] as ((t: { value: string }) => void)[], pushToken: "" };

vi.mock("@/lib/deviceId", () => ({ getDeviceId: () => DEV }));
vi.mock("@/lib/plus/installToken", () => ({
  claimInstallToken: async () => {
    ctl.claimCalls += 1;
    return { token: ctl.claimToken, device: null };
  },
}));

const { enableNative, disableNative, flushPendingUnregister, resetPushOps } = await import("@/lib/push/native");
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
  resetPushOps();
  pn.auto = true;
  pn.waiting = [];
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
            if (name === "registration") {
              if (pn.auto) queueMicrotask(() => cb({ value: PUSH }));
              else pn.waiting.push(cb);
            }
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
    expect(calls[0].headers["x-client-cap"]).toBe("install-token-v1");
    expect(calls[0].body.deviceId).toBe(DEV);
    expect(map.get("native-push:boca-raton")).toBe(PUSH);
  });

  it("records 'claimed' only when the server says it bound the token", async () => {
    await enableNative("boca-raton", PREFS);
    expect(store.readInstallClaimed()).toBe(false); // plain { ok: true }
    replies = [reply(200, { ok: true, installTokenBound: true })];
    await enableNative("boca-raton", PREFS);
    expect(store.readInstallClaimed()).toBe(true);
  });

  it("drops stale per-beach markers that hold a different push token (they would be a stale proof)", async () => {
    map.set("native-push:old-beach", "old-push-token");
    await enableNative("boca-raton", PREFS);
    expect(map.has("native-push:old-beach")).toBe(false);
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

describe("one app-wide queue; the latest intent wins", () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const P = "p".repeat(80);
  const Q = "q".repeat(80);
  /** Answer the oldest enable that is waiting on the OS with this push token. */
  const osAnswers = async (value: string) => {
    await tick();
    const cb = pn.waiting.shift();
    expect(cb).toBeTruthy();
    cb!({ value });
    await tick();
  };
  /** A server that remembers what it was last told, per route, in order. */
  function server() {
    const log: string[] = [];
    let serverToken: string | null = null;
    vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { token: string };
      log.push(`${path.split("/").pop()}:${body.token.slice(0, 1)}`);
      if (path === "/api/push/register-native") serverToken = body.token;
      else if (serverToken === body.token) serverToken = null;
      return reply(200);
    });
    return { log, state: () => serverToken };
  }

  it("enable (still waiting on APNs) -> disable -> the enable's token arrives: alerts stay OFF and nothing was registered", async () => {
    pn.auto = false;
    const srv = server();
    const enable = enableNative("boca-raton", PREFS);
    await tick();
    const disable = disableNative("boca-raton");
    await osAnswers(P); // the OS finally answers the older enable
    expect(await enable).toBe("superseded");
    await disable;
    expect(srv.log).toEqual([]); // never registered, so nothing to turn off either
    expect(srv.state()).toBeNull();
    expect(map.has("native-push:boca-raton")).toBe(false);
  });

  it("the same, when alerts were already ON: the disable still turns them off at the end", async () => {
    map.set("native-push:boca-raton", P);
    pn.auto = false;
    const srv = server();
    const enable = enableNative("boca-raton", PREFS);
    await tick();
    const disable = disableNative("boca-raton");
    await osAnswers(Q);
    await Promise.all([enable, disable]);
    expect(srv.log).toEqual(["unregister-native:p"]);
    expect(map.has("native-push:boca-raton")).toBe(false);
  });

  it("two enables at once (P, then Q): the later one wins, and server and local marker agree", async () => {
    pn.auto = false;
    const srv = server();
    const first = enableNative("boca-raton", PREFS);
    await tick();
    const second = enableNative("boca-raton", PREFS);
    await osAnswers(P); // first wakes up overtaken and sends nothing
    expect(await first).toBe("superseded");
    await osAnswers(Q);
    expect(await second).toBe("on");
    expect(srv.log).toEqual(["register-native:q"]);
    expect(srv.state()).toBe(Q);
    expect(map.get("native-push:boca-raton")).toBe(Q);
    // ...so a disable now really turns the server's token off.
    await disableNative("boca-raton");
    expect(srv.state()).toBeNull();
  });

  it("a disable asked for after an enable's request went out waits for it, then turns it off", async () => {
    const srv = server();
    const enable = enableNative("boca-raton", PREFS);
    const disable = disableNative("boca-raton");
    await Promise.all([enable, disable]);
    // The enable was overtaken before it sent anything (the disable was asked for
    // first thing), so the server was never told anything and stays off.
    expect(srv.state()).toBeNull();
    expect(map.has("native-push:boca-raton")).toBe(false);
  });

  it("a queued turn-off for Q still runs when the person enables P (an enable for one token never cancels another's retry)", async () => {
    store.writeInstallToken("tok-1");
    store.queuePendingUnregister(Q);
    map.set("native-push:other", Q);
    const srv = server();
    const enable = enableNative("boca-raton", PREFS); // registers PUSH
    const flush = flushPendingUnregister();
    await Promise.all([enable, flush]);
    expect(srv.log).toContain("register-native:f");
    expect(srv.log).toContain("unregister-native:q");
    expect(store.readPendingUnregister()).toEqual([]);
  });

  it("a retry trigger that arrives during a running pass schedules one more pass after it", async () => {
    store.writeInstallToken("tok-1");
    store.queuePendingUnregister(P);
    let release: () => void = () => {};
    let calls2 = 0;
    vi.stubGlobal("fetch", (path: string, init: RequestInit) => {
      calls2 += 1;
      const first = calls2 === 1;
      return new Promise<Response>((resolve) => {
        const answer = () => resolve(first ? reply(503, { ok: false }) : reply(200));
        if (first) release = answer;
        else answer();
        void init;
      });
    });
    const one = flushPendingUnregister();
    await tick();
    // While the first pass is waiting on the network, the phone comes back online
    // and a new token needs turning off too.
    store.queuePendingUnregister(Q);
    const two = flushPendingUnregister();
    release(); // first pass: P fails (503)
    await Promise.all([one, two]);
    // The extra pass picked up Q (not in the first pass's snapshot) and retried P.
    expect(store.readPendingUnregister()).toEqual([]);
    expect(calls2).toBe(3);
  });

  it("an enable that is waiting on the OS does not strand a queued retry; it runs once the enable is done", async () => {
    store.writeInstallToken("tok-1");
    store.queuePendingUnregister(Q);
    pn.auto = false;
    const srv = server();
    const enable = enableNative("boca-raton", PREFS);
    const flush = flushPendingUnregister();
    await osAnswers(P);
    await Promise.all([enable, flush]);
    expect(srv.log).toEqual(["register-native:p", "unregister-native:q"]);
  });
});
