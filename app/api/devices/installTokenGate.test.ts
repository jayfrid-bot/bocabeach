// The install-token gate on the routes that change a device row: /api/devices
// (prefs, home beach, profile), /api/devices/trial, /api/devices/unlock and
// /api/presence. A device id is not a secret, so only the phone that holds the
// device's token may change the row. The phone makes the token itself; the
// server binds its hash idempotently and checks it INSIDE each write.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST as devicesPost, GET as devicesGet } from "@/app/api/devices/route";
import { POST as trialPost } from "@/app/api/devices/trial/route";
import { POST as unlockPost } from "@/app/api/devices/unlock/route";
import { POST as presencePost, DELETE as presenceDelete } from "@/app/api/presence/route";
import { getStore } from "@/lib/db/store";
import { hashOfToken } from "@/lib/db/installGuard";
import { resetMemoryStore } from "@/lib/db/memoryStore";
import { resetMemoryRateLimit } from "@/lib/plus/rateLimit";

const DEV = "11111111-2222-4333-8444-555555555555";
const TOKEN = "owner-install-token-" + "q".repeat(30);
const OTHER = "attacker-install-token-" + "r".repeat(30);
const PUSH = "f".repeat(80);
const HOUR = 3600 * 1000;
const APP_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) IsItBeachDayApp/ios";

function req(url: string, body: unknown, installToken?: string, method = "POST"): Request {
  return new Request(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": APP_UA,
      ...(installToken ? { "x-install-token": installToken } : {}),
    },
    body: JSON.stringify(body),
  });
}
const json = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;

/** The phone's first call: claims TOKEN for DEV (and gives it a Plus grant). */
async function claimedEntitledPhone(): Promise<void> {
  expect((await devicesPost(req("https://x/api/devices", { deviceId: DEV, platform: "ios" }, TOKEN))).status).toBe(200);
  await (await getStore()).upsertDevice(DEV, { codeUntil: Date.now() + 30 * 24 * HOUR });
}

const OLD = { ...process.env };
beforeEach(() => {
  resetMemoryStore();
  resetMemoryRateLimit();
  process.env.INSTALL_TOKEN_ENFORCE = "on";
  process.env.PLUS_SERVER_TRIAL = "on";
  process.env.PLUS_UNLOCK_CODE = "sandy-shoes";
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...OLD };
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("POST /api/devices — enforcing", () => {
  it("binds a token the phone made, stores only its hash, says so, and returns nothing to keep", async () => {
    const res = await devicesPost(req("https://x/api/devices", { deviceId: DEV, platform: "ios" }, TOKEN));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.installTokenBound).toBe(true);
    expect(body.installToken).toBeUndefined();
    expect(await (await getStore()).getInstallTokenHash(DEV)).toBe(hashOfToken(TOKEN));
  });

  it("the same call again succeeds (a retry after a lost response)", async () => {
    await devicesPost(req("https://x/api/devices", { deviceId: DEV, platform: "ios" }, TOKEN));
    const res = await devicesPost(req("https://x/api/devices", { deviceId: DEV, tz: "America/New_York" }, TOKEN));
    expect(res.status).toBe(200);
  });

  it("refuses a write with no token, and changes nothing", async () => {
    await claimedEntitledPhone();
    const res = await devicesPost(
      req("https://x/api/devices", { deviceId: DEV, homeSlug: "cocoa-beach", prefs: { morning: false, lightning: false } }),
    );
    expect(res.status).toBe(401);
    expect((await json(res)).error).toBe("no-token");
    const device = (await (await getStore()).getDevice(DEV))!;
    expect(device.homeSlug).toBeNull();
    expect(device.prefs.morning).toBe(true);
  });

  it("refuses another phone's token, even on a brand-new write to a claimed row", async () => {
    await claimedEntitledPhone();
    const res = await devicesPost(req("https://x/api/devices", { deviceId: DEV, prefs: { morning: false } }, OTHER));
    expect(res.status).toBe(401);
    expect((await (await getStore()).getDevice(DEV))!.prefs.morning).toBe(true);
  });

  it("accepts the right token", async () => {
    await claimedEntitledPhone();
    const res = await devicesPost(req("https://x/api/devices", { deviceId: DEV, prefs: { morning: false } }, TOKEN));
    expect(res.status).toBe(200);
    expect((await (await getStore()).getDevice(DEV))!.prefs.morning).toBe(false);
  });

  it("a row with a push token but no install token needs that push token as pushProof", async () => {
    const store = await getStore();
    await store.upsertDevice(DEV, { platform: "ios", pushToken: PUSH });
    const noProof = await devicesPost(req("https://x/api/devices", { deviceId: DEV, platform: "ios" }, OTHER));
    expect(noProof.status).toBe(401);
    const wrongProof = await devicesPost(req("https://x/api/devices", { deviceId: DEV, pushProof: "g".repeat(80) }, OTHER));
    expect(wrongProof.status).toBe(401);
    expect(await store.getInstallTokenHash(DEV)).toBeNull();
    const ok = await devicesPost(req("https://x/api/devices", { deviceId: DEV, platform: "ios", pushProof: PUSH }, TOKEN));
    expect(ok.status).toBe(200);
    expect(await store.getInstallTokenHash(DEV)).toBe(hashOfToken(TOKEN));
  });

  it("a row with neither token nor push token is first-claim (documented residual risk)", async () => {
    const store = await getStore();
    await store.upsertDevice(DEV, { tz: "America/New_York" });
    expect((await devicesPost(req("https://x/api/devices", { deviceId: DEV }, TOKEN))).status).toBe(200);
  });

  it("of two phones racing to claim one id, one wins and the loser writes nothing", async () => {
    const [a, b] = await Promise.all([
      devicesPost(req("https://x/api/devices", { deviceId: DEV, homeSlug: "boca-raton" }, TOKEN)),
      devicesPost(req("https://x/api/devices", { deviceId: DEV, homeSlug: "cocoa-beach" }, OTHER)),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 401]);
    const store = await getStore();
    expect((await store.getDevice(DEV))!.homeSlug).toBe(a.status === 200 ? "boca-raton" : "cocoa-beach");
    expect(await store.getInstallTokenHash(DEV)).toBe(hashOfToken(a.status === 200 ? TOKEN : OTHER));
  });

  it("a claim then a lost-response retry then a write: all succeed with the one token", async () => {
    // (the response to the first call "never arrived": the phone just sends again)
    await devicesPost(req("https://x/api/devices", { deviceId: DEV, platform: "ios" }, TOKEN));
    await devicesPost(req("https://x/api/devices", { deviceId: DEV, platform: "ios" }, TOKEN));
    const res = await devicesPost(req("https://x/api/devices", { deviceId: DEV, homeSlug: "boca-raton" }, TOKEN));
    expect(res.status).toBe(200);
  });

  it("keeps GET open (read only)", async () => {
    await claimedEntitledPhone();
    expect((await devicesGet(new Request(`https://x/api/devices?deviceId=${DEV}`))).status).toBe(200);
  });

  it("a store failure is a generic message, not the backend error", async () => {
    await claimedEntitledPhone();
    const store = await getStore();
    vi.spyOn(store, "upsertDevice").mockRejectedValue(new Error("secret backend detail"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await devicesPost(req("https://x/api/devices", { deviceId: DEV, homeSlug: "boca-raton" }, TOKEN));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("secret backend detail");
  });
});

describe("POST /api/devices — INSTALL_TOKEN_ENFORCE off", () => {
  beforeEach(() => {
    delete process.env.INSTALL_TOKEN_ENFORCE;
  });

  it("a request with no token goes through as before and is counted by route name only", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await claimedEntitledPhone();
    const res = await devicesPost(req("https://x/api/devices", { deviceId: DEV, homeSlug: "boca-raton" }));
    expect(res.status).toBe(200);
    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes("install_token_missing"));
    expect(JSON.parse(line!)).toEqual({ event: "install_token_missing", route: "/api/devices", enforce: false, clientCap: false });
    expect(JSON.stringify(log.mock.calls)).not.toContain(DEV);
  });

  it("a token that is sent is still checked", async () => {
    await claimedEntitledPhone();
    expect((await devicesPost(req("https://x/api/devices", { deviceId: DEV, homeSlug: "boca-raton" }, OTHER))).status).toBe(401);
    expect((await devicesPost(req("https://x/api/devices", { deviceId: DEV, homeSlug: "boca-raton" }, TOKEN))).status).toBe(200);
  });

  it("a token that is sent but cannot be BOUND is a 401 even now, and the response never says it is bound", async () => {
    const store = await getStore();
    await store.upsertDevice(DEV, { platform: "ios", pushToken: PUSH });
    const res = await devicesPost(req("https://x/api/devices", { deviceId: DEV, platform: "ios" }, OTHER));
    expect(res.status).toBe(401);
    expect((await json(res)).installTokenBound).toBeUndefined();
    expect(await store.getInstallTokenHash(DEV)).toBeNull();
  });

  it("a request with NO token goes through, leaves the row unclaimed, and gets no token and no bound signal", async () => {
    const res = await devicesPost(req("https://x/api/devices", { deviceId: DEV, platform: "ios" }));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.installToken).toBeUndefined();
    expect(body.installTokenBound).toBeUndefined();
    expect(await (await getStore()).getInstallTokenHash(DEV)).toBeNull();
  });

  it("the missing-token log line says whether the client sent the capability header", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await devicesPost(req("https://x/api/devices", { deviceId: DEV }));
    const withCap = new Request("https://x/api/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-client-cap": "install-token-v1" },
      body: JSON.stringify({ deviceId: DEV }),
    });
    await devicesPost(withCap);
    const caps = log.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes("install_token_missing"))
      .map((l) => JSON.parse(l).clientCap);
    expect(caps).toEqual([false, true]);
  });
});

describe("trial, unlock, presence — always need a valid token when enforcing", () => {
  it("trial: refused without it and the trial stays unspent; a never-claimed id is refused too", async () => {
    await claimedEntitledPhone();
    const refused = await trialPost(req("https://x/api/devices/trial", { deviceId: DEV }));
    expect(refused.status).toBe(401);
    expect((await json(refused)).error).toBe("no-token");
    expect((await (await getStore()).getDevice(DEV))!.trialUsed).toBe(false);
    expect((await trialPost(req("https://x/api/devices/trial", { deviceId: DEV }, OTHER))).status).toBe(401);
    expect((await trialPost(req("https://x/api/devices/trial", { deviceId: DEV }, TOKEN))).status).toBe(200);

    const stranger = "33333333-4444-4555-8666-777777777777";
    expect((await trialPost(req("https://x/api/devices/trial", { deviceId: stranger }, TOKEN))).status).toBe(401);
    expect(await (await getStore()).getDevice(stranger)).toBeNull(); // no row created for an unauthorized id
  });

  it("trial: a row with no install token yet gets 401, then works once the phone has claimed", async () => {
    const store = await getStore();
    await store.upsertDevice(DEV, {});
    expect((await trialPost(req("https://x/api/devices/trial", { deviceId: DEV }, TOKEN))).status).toBe(401);
    await devicesPost(req("https://x/api/devices", { deviceId: DEV }, TOKEN));
    expect((await trialPost(req("https://x/api/devices/trial", { deviceId: DEV }, TOKEN))).status).toBe(200);
  });

  it("unlock: a wrong code still says bad-code first; a right code needs the token", async () => {
    await claimedEntitledPhone();
    const bad = await unlockPost(req("https://x/api/devices/unlock", { deviceId: DEV, code: "nope" }));
    expect((await json(bad)).error).toBe("bad-code");
    expect((await unlockPost(req("https://x/api/devices/unlock", { deviceId: DEV, code: "sandy-shoes" }))).status).toBe(401);
    expect((await unlockPost(req("https://x/api/devices/unlock", { deviceId: DEV, code: "sandy-shoes" }, OTHER))).status).toBe(401);
    expect((await unlockPost(req("https://x/api/devices/unlock", { deviceId: DEV, code: "sandy-shoes" }, TOKEN))).status).toBe(200);
  });

  const fix = { slug: "boca-raton", lat: 26.35, lon: -80.07, accuracyM: 15, source: "auto" };

  it("presence: arm and disarm both need the token and write nothing without it", async () => {
    await claimedEntitledPhone();
    const arm = () => req("https://x/api/presence", { deviceId: DEV, ...fix, armedUntil: Date.now() + HOUR }, undefined);
    const refused = await presencePost(arm());
    expect(refused.status).toBe(401);
    expect((await json(refused)).error).toBe("no-token");
    expect((await (await getStore()).getDevice(DEV))!.presence).toBeNull();

    const armed = await presencePost(req("https://x/api/presence", { deviceId: DEV, ...fix, armedUntil: Date.now() + HOUR }, TOKEN));
    expect(armed.status).toBe(200);

    expect((await presenceDelete(req("https://x/api/presence", { deviceId: DEV }, undefined, "DELETE"))).status).toBe(401);
    expect((await presenceDelete(req("https://x/api/presence", { deviceId: DEV }, OTHER, "DELETE"))).status).toBe(401);
    expect((await (await getStore()).getDevice(DEV))!.presence).not.toBeNull();
    expect((await presenceDelete(req("https://x/api/presence", { deviceId: DEV }, TOKEN, "DELETE"))).status).toBe(200);
    expect((await (await getStore()).getDevice(DEV))!.presence).toBeNull();
  });

  it("presence: a row with no install token yet is refused, not let through", async () => {
    const store = await getStore();
    await store.upsertDevice(DEV, { codeUntil: Date.now() + 30 * 24 * HOUR });
    const res = await presencePost(req("https://x/api/presence", { deviceId: DEV, ...fix, armedUntil: Date.now() + HOUR }, TOKEN));
    expect(res.status).toBe(401);
    expect((await store.getDevice(DEV))!.presence).toBeNull();
  });

  it("the guard is checked in the write itself: a claim that lands between the route's read and its write cannot be bypassed", async () => {
    // Not enforcing, a row nobody has claimed yet, and the caller sends a token
    // (TOKEN) that is not bound. Right after the route's entitlement read, a
    // different phone claims the row. A check-then-write would have already
    // decided "allowed"; the guard inside the write sees the new owner.
    delete process.env.INSTALL_TOKEN_ENFORCE;
    const store = await getStore();
    await store.upsertDevice(DEV, { codeUntil: Date.now() + 30 * 24 * HOUR });
    const realGet = store.getDevice.bind(store);
    vi.spyOn(store, "getDevice").mockImplementation(async (id) => {
      const d = await realGet(id);
      await store.claimInstallToken(DEV, hashOfToken(OTHER), null, Date.now());
      return d;
    });
    const res = await presencePost(req("https://x/api/presence", { deviceId: DEV, ...fix, armedUntil: Date.now() + HOUR }, TOKEN));
    expect(res.status).toBe(401);
    vi.restoreAllMocks();
    expect((await (await getStore()).getDevice(DEV))!.presence).toBeNull();
  });
});

describe("trial, unlock, presence — INSTALL_TOKEN_ENFORCE off", () => {
  beforeEach(() => {
    delete process.env.INSTALL_TOKEN_ENFORCE;
  });

  it("a request with no token passes as before; a wrong token does not", async () => {
    await claimedEntitledPhone();
    expect((await trialPost(req("https://x/api/devices/trial", { deviceId: DEV }, OTHER))).status).toBe(401);
    expect((await trialPost(req("https://x/api/devices/trial", { deviceId: DEV }))).status).toBe(200);
    expect((await unlockPost(req("https://x/api/devices/unlock", { deviceId: DEV, code: "sandy-shoes" }, OTHER))).status).toBe(401);
    expect((await unlockPost(req("https://x/api/devices/unlock", { deviceId: DEV, code: "sandy-shoes" }))).status).toBe(200);
  });
});

describe("fail closed without a database", () => {
  it("in production a missing D1 binding is a 503 on every one of these routes", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await devicesPost(req("https://x/api/devices", { deviceId: DEV }, TOKEN))).status).toBe(503);
    expect((await trialPost(req("https://x/api/devices/trial", { deviceId: DEV }, TOKEN))).status).toBe(503);
    expect((await unlockPost(req("https://x/api/devices/unlock", { deviceId: DEV, code: "sandy-shoes" }, TOKEN))).status).toBe(503);
    expect(
      (await presencePost(req("https://x/api/presence", { deviceId: DEV, slug: "boca-raton", source: "auto", armedUntil: Date.now() + HOUR }, TOKEN))).status,
    ).toBe(503);
    expect((await presenceDelete(req("https://x/api/presence", { deviceId: DEV }, TOKEN, "DELETE"))).status).toBe(503);
  });
});

describe("secrets never reach the logs", () => {
  it("no console call carries a token or its hash", async () => {
    const spies = (["log", "info", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    await devicesPost(req("https://x/api/devices", { deviceId: DEV }, TOKEN));
    await devicesPost(req("https://x/api/devices", { deviceId: DEV }, OTHER));
    await devicesPost(req("https://x/api/devices", { deviceId: DEV }));
    await trialPost(req("https://x/api/devices/trial", { deviceId: DEV }, OTHER));
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls.map((c) => c.map(String))));
    for (const secret of [TOKEN, OTHER, hashOfToken(TOKEN), hashOfToken(OTHER)]) expect(logged).not.toContain(secret);
  });
});
