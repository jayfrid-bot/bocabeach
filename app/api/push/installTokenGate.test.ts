// The install-token gate on the push routes: /api/push/register-native and
// /api/push/unregister-native. A device id is not a secret (it is the "Support
// ID"), so knowing it must not be enough to redirect or switch off that phone's
// alerts. Handlers are called directly; the memory store stands in for D1 (the
// real SQL is covered in lib/db/installTokenSql.test.ts).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ctl = vi.hoisted(() => ({ removed: [] as string[], failRemove: false }));

vi.mock("@/lib/push/nativeStore", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/push/nativeStore")>();
  return {
    ...actual,
    listNativeSubs: async () => [],
    removeNativeSub: async (token: string) => {
      if (ctl.failRemove) throw new Error("kv down");
      ctl.removed.push(token);
    },
  };
});

const { POST: registerPost } = await import("@/app/api/push/register-native/route");
const { POST: unregisterPost } = await import("@/app/api/push/unregister-native/route");
const { getStore, legacyDeviceId } = await import("@/lib/db/store");
const { hashOfToken } = await import("@/lib/db/installGuard");
const { resetMemoryStore } = await import("@/lib/db/memoryStore");

const DEV = "11111111-2222-4333-8444-555555555555";
const DEV2 = "99999999-2222-4333-8444-555555555555";
const OWNER_PUSH = "a".repeat(80); // the phone's own FCM token
const ATTACKER_PUSH = "b".repeat(80); // the token an attacker wants alerts sent to
const THIRD_PUSH = "c".repeat(80);
const TOKEN = "owner-install-token-" + "q".repeat(30); // made by the phone
const OTHER_TOKEN = "attacker-install-token-" + "r".repeat(30);

function req(path: string, body: unknown, installToken?: string): Request {
  return new Request(`https://x/api/push/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(installToken ? { "x-install-token": installToken } : {}) },
    body: JSON.stringify(body),
  });
}
function register(over: Record<string, unknown> = {}, installToken?: string): Request {
  return req("register-native", { slug: "boca-raton", token: OWNER_PUSH, platform: "android", deviceId: DEV, ...over }, installToken);
}
const unregister = (body: Record<string, unknown>, installToken?: string) => req("unregister-native", body, installToken);

const OLD = { ...process.env };
beforeEach(() => {
  resetMemoryStore();
  ctl.removed = [];
  ctl.failRemove = false;
  process.env.INSTALL_TOKEN_ENFORCE = "on";
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...OLD };
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** A phone that already claimed TOKEN and registered OWNER_PUSH. */
async function claimedPhone(): Promise<void> {
  const res = await registerPost(register({}, TOKEN));
  expect(res.status).toBe(200);
}

describe("register-native with INSTALL_TOKEN_ENFORCE on", () => {
  it("a new device id registers with a token it made, and the server stores only the hash", async () => {
    const res = await registerPost(register({}, TOKEN));
    expect(res.status).toBe(200);
    // The server says it bound the phone's token; it never hands one back.
    expect(await res.json()).toEqual({ ok: true, installTokenBound: true });
    const store = await getStore();
    expect(await store.getPushToken(DEV)).toBe(OWNER_PUSH);
    expect(await store.getInstallTokenHash(DEV)).toBe(hashOfToken(TOKEN));
  });

  it("a retry with the same token succeeds again (lost response never locks the phone out)", async () => {
    await claimedPhone();
    const again = await registerPost(register({ token: THIRD_PUSH }, TOKEN));
    expect(again.status).toBe(200);
    expect(await (await getStore()).getPushToken(DEV)).toBe(THIRD_PUSH);
  });

  it("refuses a call with no token, and the push target stays put", async () => {
    await claimedPhone();
    const res = await registerPost(register({ token: ATTACKER_PUSH, slug: "cocoa-beach" }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("no-token");
    const store = await getStore();
    expect(await store.getPushToken(DEV)).toBe(OWNER_PUSH);
    expect((await store.getDevice(DEV))!.homeSlug).toBe("boca-raton");
  });

  it("refuses a different token: an attacker who knows the id cannot move or silence alerts", async () => {
    await claimedPhone();
    const res = await registerPost(register({ token: ATTACKER_PUSH, prefs: { morning: false, safety: false } }, OTHER_TOKEN));
    expect(res.status).toBe(401);
    const store = await getStore();
    expect(await store.listPushable()).toHaveLength(1);
    expect((await store.listPushable())[0].token).toBe(OWNER_PUSH);
    expect((await store.getDevice(DEV))!.prefs.morning).toBe(true);
  });

  it("two phones racing to claim a new id: exactly one wins and the loser writes nothing", async () => {
    const [a, b] = await Promise.all([
      registerPost(register({ token: OWNER_PUSH }, TOKEN)),
      registerPost(register({ token: ATTACKER_PUSH }, OTHER_TOKEN)),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 401]);
    const winnerPush = a.status === 200 ? OWNER_PUSH : ATTACKER_PUSH;
    const winnerToken = a.status === 200 ? TOKEN : OTHER_TOKEN;
    const store = await getStore();
    expect(await store.getPushToken(DEV)).toBe(winnerPush);
    expect(await store.getInstallTokenHash(DEV)).toBe(hashOfToken(winnerToken));
  });

  describe("an existing row that has no install token yet (the unmigrated ones)", () => {
    it("with a push token: claimed only when the request presents that same push token", async () => {
      const store = await getStore();
      await store.upsertDevice(DEV, { platform: "android", pushToken: OWNER_PUSH, homeSlug: "boca-raton" });
      // Someone who only learned the id registers THEIR push token: refused.
      const stolen = await registerPost(register({ token: ATTACKER_PUSH }, OTHER_TOKEN));
      expect(stolen.status).toBe(401);
      expect(await store.getPushToken(DEV)).toBe(OWNER_PUSH);
      expect(await store.getInstallTokenHash(DEV)).toBeNull();
      // The real phone presents its own push token: claimed.
      const real = await registerPost(register({ token: OWNER_PUSH }, TOKEN));
      expect(real.status).toBe(200);
      expect(await store.getInstallTokenHash(DEV)).toBe(hashOfToken(TOKEN));
    });

    it("with no push token: first claim wins (documented residual risk)", async () => {
      const store = await getStore();
      await store.upsertDevice(DEV, { tz: "America/New_York" });
      const res = await registerPost(register({}, TOKEN));
      expect(res.status).toBe(200);
      expect(await store.getInstallTokenHash(DEV)).toBe(hashOfToken(TOKEN));
    });
  });

  describe("moving a push token between rows (reinstall: new device id, same push token)", () => {
    it("moves it in one step: the old row keeps its record and loses the token", async () => {
      await claimedPhone();
      const res = await registerPost(register({ deviceId: DEV2, token: OWNER_PUSH }, OTHER_TOKEN));
      expect(res.status).toBe(200);
      const store = await getStore();
      expect(await store.getPushToken(DEV2)).toBe(OWNER_PUSH);
      expect(await store.getPushToken(DEV)).toBeNull();
      expect(await store.getDevice(DEV)).toBeTruthy();
      expect((await store.listPushable()).map((p) => p.device.id)).toEqual([DEV2]);
    });

    it("a refused caller detaches nobody", async () => {
      await claimedPhone();
      // DEV2 is claimed by someone else; a call without its token cannot pull DEV's token over.
      const store = await getStore();
      await store.claimInstallToken(DEV2, hashOfToken(OTHER_TOKEN), null, Date.now());
      const res = await registerPost(register({ deviceId: DEV2, token: OWNER_PUSH }, "wrong"));
      expect(res.status).toBe(401);
      expect(await store.getPushToken(DEV)).toBe(OWNER_PUSH);
    });

    it("a store failure during the move leaves the old holder in place", async () => {
      await claimedPhone();
      const store = await getStore();
      vi.spyOn(store, "transferPushToken").mockRejectedValue(new Error("simulated D1 failure"));
      vi.spyOn(console, "error").mockImplementation(() => {});
      const res = await registerPost(register({ deviceId: DEV2, token: OWNER_PUSH }, OTHER_TOKEN));
      expect(res.status).toBe(500);
      expect(await store.getPushToken(DEV)).toBe(OWNER_PUSH);
    });
  });

  describe("old builds that send no deviceId (the legacy path)", () => {
    it("still registers, with no install token", async () => {
      const res = await registerPost(req("register-native", { slug: "boca-raton", token: OWNER_PUSH, platform: "android" }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(await (await getStore()).getPushToken(legacyDeviceId(OWNER_PUSH))).toBe(OWNER_PUSH);
    });

    it("adopting a legacy row onto a real device id is the same atomic move", async () => {
      await registerPost(req("register-native", { slug: "boca-raton", token: OWNER_PUSH, platform: "android" }));
      const res = await registerPost(register({}, TOKEN));
      expect(res.status).toBe(200);
      const store = await getStore();
      expect(await store.getDevice(legacyDeviceId(OWNER_PUSH))).toBeNull();
      expect(await store.getPushToken(DEV)).toBe(OWNER_PUSH);
      expect(await store.listDevices()).toHaveLength(1);
    });

    it("a legacy call that takes a real row's push token uses the atomic move too", async () => {
      await claimedPhone();
      await registerPost(req("register-native", { slug: "boca-raton", token: OWNER_PUSH, platform: "android" }));
      const store = await getStore();
      expect(await store.getPushToken(DEV)).toBeNull();
      expect(await store.getPushToken(legacyDeviceId(OWNER_PUSH))).toBe(OWNER_PUSH);
      expect((await store.listPushable())).toHaveLength(1);
    });

    it("a deviceId shaped like a legacy id is not treated as a real one", async () => {
      const res = await registerPost(register({ deviceId: `legacy:${"A".repeat(20)}` }));
      expect(res.status).toBe(200); // falls back to the legacy path, needs no token
      expect(await (await getStore()).getDevice(`legacy:${"A".repeat(20)}`)).toBeNull();
    });
  });
});

describe("unregister-native: the push token itself is the authorization", () => {
  it("works with enforcement ON and no install token at all (an older app can still turn alerts off)", async () => {
    await claimedPhone();
    const res = await unregisterPost(unregister({ token: OWNER_PUSH }));
    expect(res.status).toBe(200);
    const store = await getStore();
    expect(await store.getPushToken(DEV)).toBeNull();
    expect(await store.getDevice(DEV)).toBeTruthy(); // the record stays
    expect(ctl.removed).toContain(OWNER_PUSH);
  });

  it("ignores a wrong or missing install token and a made-up deviceId: the row is found by the push token", async () => {
    await claimedPhone();
    expect((await unregisterPost(unregister({ token: OWNER_PUSH, deviceId: DEV2 }, OTHER_TOKEN))).status).toBe(200);
    expect(await (await getStore()).getPushToken(DEV)).toBeNull();
  });

  it("it can only turn alerts OFF: a stranger without the push token changes nothing", async () => {
    await claimedPhone();
    const res = await unregisterPost(unregister({ token: ATTACKER_PUSH, deviceId: DEV }, OTHER_TOKEN));
    expect(res.status).toBe(200); // nothing to drop for that token
    expect(await (await getStore()).getPushToken(DEV)).toBe(OWNER_PUSH);
  });

  it("a real row with no install token yet is switched off too", async () => {
    const store = await getStore();
    await store.upsertDevice(DEV, { platform: "android", pushToken: OWNER_PUSH });
    expect((await unregisterPost(unregister({ token: OWNER_PUSH }))).status).toBe(200);
    expect(await store.getPushToken(DEV)).toBeNull();
  });

  it("a legacy row goes on possession of its push token", async () => {
    await registerPost(req("register-native", { slug: "boca-raton", token: OWNER_PUSH, platform: "android" }));
    const res = await unregisterPost(unregister({ token: OWNER_PUSH }));
    expect(res.status).toBe(200);
    expect(await (await getStore()).listDevices()).toHaveLength(0);
  });

  it("a failed legacy-KV delete is an ERROR, never acknowledged as success", async () => {
    await claimedPhone();
    vi.spyOn(console, "error").mockImplementation(() => {});
    ctl.failRemove = true;
    const res = await unregisterPost(unregister({ token: OWNER_PUSH }));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("kv down");
    // The retry (the phone keeps it queued) finishes the job.
    ctl.failRemove = false;
    expect((await unregisterPost(unregister({ token: OWNER_PUSH }))).status).toBe(200);
    expect(ctl.removed).toContain(OWNER_PUSH);
  });
});

describe("INSTALL_TOKEN_ENFORCE off (the staged rollout)", () => {
  beforeEach(() => {
    delete process.env.INSTALL_TOKEN_ENFORCE;
  });

  it("a request with no token goes through as before, leaves the row UNCLAIMED, and is counted", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await registerPost(register());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true }); // no installTokenBound, and no token handed out
    const store = await getStore();
    expect(await store.getPushToken(DEV)).toBe(OWNER_PUSH);
    expect(await store.getInstallTokenHash(DEV)).toBeNull(); // the server never makes a token
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("install_token_missing"));
    expect(JSON.parse(lines[0])).toEqual({
      event: "install_token_missing",
      route: "/api/push/register-native",
      enforce: false,
      clientCap: false,
    });
    const all = JSON.stringify(log.mock.calls);
    expect(all).not.toContain(DEV);
    expect(all).not.toContain(OWNER_PUSH);
  });

  it("the log line tells a current client (capability header) from an older one", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const r = register();
    const withCap = new Request(r.url, { method: "POST", headers: { ...Object.fromEntries(r.headers), "x-client-cap": "install-token-v1" }, body: await r.text() });
    // The route itself reads the header for authorizeMinting; a tokenless current client logs clientCap: true.
    await registerPost(withCap);
    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes("install_token_missing"));
    expect(JSON.parse(line!).clientCap).toBe(true);
  });

  it("a tokenless request keeps working on a claimed row (as before the gate)", async () => {
    await claimedPhoneNoEnforce();
    const res = await registerPost(register({ token: THIRD_PUSH }));
    expect(res.status).toBe(200);
    expect(await (await getStore()).getPushToken(DEV)).toBe(THIRD_PUSH);
  });

  it("a token that IS sent is still checked: a wrong one is refused", async () => {
    await claimedPhoneNoEnforce();
    const res = await registerPost(register({ token: ATTACKER_PUSH }, OTHER_TOKEN));
    expect(res.status).toBe(401);
    expect(await (await getStore()).getPushToken(DEV)).toBe(OWNER_PUSH);
  });

  it("a token that is sent but cannot be BOUND is refused even now (no proof for a row with a push token)", async () => {
    const store = await getStore();
    await store.upsertDevice(DEV, { platform: "android", pushToken: OWNER_PUSH });
    const res = await registerPost(register({ token: ATTACKER_PUSH }, OTHER_TOKEN));
    expect(res.status).toBe(401);
    expect(await store.getPushToken(DEV)).toBe(OWNER_PUSH);
    expect(await store.getInstallTokenHash(DEV)).toBeNull();
  });

  it("claims still happen: a right token is bound, and the response says so", async () => {
    const res = await registerPost(register({}, TOKEN));
    expect(await res.json()).toEqual({ ok: true, installTokenBound: true });
    expect(await (await getStore()).getInstallTokenHash(DEV)).toBe(hashOfToken(TOKEN));
  });

  it("PROOF LAUNDERING: P -> Q -> claim. A tokenless caller cannot swap the push token of an unclaimed row and then claim it with the new one", async () => {
    const store = await getStore();
    await store.upsertDevice(DEV, { platform: "android", pushToken: OWNER_PUSH, homeSlug: "boca-raton" });
    // Step 1 (attacker, knows only the id, no token, enforcement off): put Q on the row.
    const swap = await registerPost(register({ token: ATTACKER_PUSH }));
    expect(swap.status).toBe(401);
    expect(await store.getPushToken(DEV)).toBe(OWNER_PUSH);
    // Step 2: "prove" Q and claim.
    const claim = await registerPost(register({ token: ATTACKER_PUSH }, OTHER_TOKEN));
    expect(claim.status).toBe(401);
    expect(await store.getInstallTokenHash(DEV)).toBeNull();
    // Step 3: after enforcement is on, still refused.
    process.env.INSTALL_TOKEN_ENFORCE = "on";
    expect((await registerPost(register({ token: ATTACKER_PUSH }, OTHER_TOKEN))).status).toBe(401);
    // The real phone (presents P) claims the row.
    expect((await registerPost(register({ token: OWNER_PUSH }, TOKEN))).status).toBe(200);
    expect(await store.getInstallTokenHash(DEV)).toBe(hashOfToken(TOKEN));
  });

  async function claimedPhoneNoEnforce() {
    const res = await registerPost(register({}, TOKEN));
    expect(res.status).toBe(200);
  }
});

describe("fail closed without a database", () => {
  it("on the Workers runtime a missing D1 binding is a 503, not an empty memory store", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reg = await registerPost(register({}, TOKEN));
    expect(reg.status).toBe(503);
    const unreg = await unregisterPost(unregister({ token: OWNER_PUSH }, TOKEN));
    expect(unreg.status).toBe(503);
  });
});

describe("a plain Node server (CI's next start) keeps the memory store", () => {
  it("NODE_ENV=production without the Workers runtime does not 503", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const unreg = await unregisterPost(unregister({ token: OWNER_PUSH }, TOKEN));
    expect(unreg.status).not.toBe(503);
  });
});

describe("secrets never reach the logs or the error bodies", () => {
  it("no console call carries an install token, its hash, or a push token", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    await registerPost(register({}, TOKEN));
    await registerPost(register({ token: ATTACKER_PUSH }, OTHER_TOKEN)); // 401
    await registerPost(register({ token: ATTACKER_PUSH })); // 401, no token
    await unregisterPost(unregister({ token: OWNER_PUSH }, OTHER_TOKEN)); // 401
    const store = await getStore();
    vi.spyOn(store, "transferPushToken").mockRejectedValue(new Error("boom"));
    const failed = await registerPost(register({ deviceId: DEV2 }, OTHER_TOKEN));
    expect(await failed.text()).not.toContain("boom"); // generic message, not the backend error

    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls.map((c) => c.map(String))));
    for (const secret of [TOKEN, OTHER_TOKEN, hashOfToken(TOKEN), hashOfToken(OTHER_TOKEN), OWNER_PUSH, ATTACKER_PUSH]) {
      expect(logged).not.toContain(secret);
    }
  });
});
