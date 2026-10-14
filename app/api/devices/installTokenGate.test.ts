// The install-token gate on the routes that change a device row: /api/devices
// (prefs, home beach, profile), /api/devices/trial, /api/devices/unlock and
// /api/presence. A device id is not a secret, so once a device has a token on
// file, only the phone that holds it may change the row. A device with no
// token on file yet keeps working as before (the migration path).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST as devicesPost, GET as devicesGet } from "@/app/api/devices/route";
import { POST as trialPost } from "@/app/api/devices/trial/route";
import { POST as unlockPost } from "@/app/api/devices/unlock/route";
import { POST as presencePost, DELETE as presenceDelete } from "@/app/api/presence/route";
import { getStore, hashInstallToken } from "@/lib/db/store";
import { resetMemoryStore } from "@/lib/db/memoryStore";
import { resetMemoryRateLimit } from "@/lib/plus/rateLimit";

const DEV = "11111111-2222-4333-8444-555555555555";
const TOKEN = "owner-install-token-for-tests";
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

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** An entitled device that already holds TOKEN. */
async function seedClaimedDevice(): Promise<void> {
  const store = await getStore();
  await store.upsertDevice(DEV, { codeUntil: Date.now() + 30 * 24 * HOUR });
  await store.setInstallTokenHash(DEV, hashInstallToken(TOKEN), Date.now());
}

const OLD_ENV = { ...process.env };
beforeEach(() => {
  resetMemoryStore();
  resetMemoryRateLimit();
  process.env.PLUS_SERVER_TRIAL = "on";
  process.env.PLUS_UNLOCK_CODE = "sandy-shoes";
});
afterEach(() => {
  process.env = { ...OLD_ENV };
  vi.restoreAllMocks();
});

describe("POST /api/devices — install token", () => {
  it("the first call for a new id mints and returns a token", async () => {
    const res = await devicesPost(req("https://x/api/devices", { deviceId: DEV, platform: "ios" }));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(typeof body.installToken).toBe("string");
    expect(await (await getStore()).getInstallTokenHash(DEV)).toBe(hashInstallToken(body.installToken as string));
  });

  it("refuses a write with no token once one is on file, and changes nothing", async () => {
    await seedClaimedDevice();
    const res = await devicesPost(
      req("https://x/api/devices", { deviceId: DEV, homeSlug: "cocoa-beach", prefs: { morning: false, lightning: false } }),
    );
    expect(res.status).toBe(401);
    expect((await json(res)).error).toBe("no-token");
    const device = (await (await getStore()).getDevice(DEV))!;
    expect(device.homeSlug).toBeNull();
    expect(device.prefs.morning).toBe(true);
    expect(device.prefs.lightning).toBe(true);
  });

  it("refuses a wrong token", async () => {
    await seedClaimedDevice();
    const res = await devicesPost(req("https://x/api/devices", { deviceId: DEV, prefs: { morning: false } }, "wrong"));
    expect(res.status).toBe(401);
    expect((await (await getStore()).getDevice(DEV))!.prefs.morning).toBe(true);
  });

  it("accepts the right token and does not mint a second one", async () => {
    await seedClaimedDevice();
    const res = await devicesPost(req("https://x/api/devices", { deviceId: DEV, prefs: { morning: false } }, TOKEN));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.installToken).toBeUndefined();
    expect((await (await getStore()).getDevice(DEV))!.prefs.morning).toBe(false);
  });

  it("a device with no token yet (never claimed) can still write; the call claims one", async () => {
    const store = await getStore();
    await store.upsertDevice(DEV, { tz: "America/New_York" }); // a pre-gate row: no hash
    const res = await devicesPost(req("https://x/api/devices", { deviceId: DEV, homeSlug: "boca-raton" }));
    expect(res.status).toBe(200);
    expect(typeof (await json(res)).installToken).toBe("string");
  });

  it("first claim is atomic: of two concurrent first calls one wins and the loser writes nothing", async () => {
    const [a, b] = await Promise.all([
      devicesPost(req("https://x/api/devices", { deviceId: DEV, homeSlug: "boca-raton" })),
      devicesPost(req("https://x/api/devices", { deviceId: DEV, homeSlug: "cocoa-beach" })),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 401]);
    const winner = a.status === 200 ? a : b;
    const winnerSlug = a.status === 200 ? "boca-raton" : "cocoa-beach";
    const body = await json(winner);
    const store = await getStore();
    expect((await store.getDevice(DEV))!.homeSlug).toBe(winnerSlug);
    expect(await store.getInstallTokenHash(DEV)).toBe(hashInstallToken(body.installToken as string));
  });

  it("keeps GET open (read only)", async () => {
    await seedClaimedDevice();
    const res = await devicesGet(new Request(`https://x/api/devices?deviceId=${DEV}`));
    expect(res.status).toBe(200);
  });

  it("returns the claimed token even when the write fails after the claim", async () => {
    const store = await getStore();
    const real = store.upsertDevice.bind(store);
    vi.spyOn(store, "upsertDevice").mockImplementation(async (id, patch) => {
      if (patch.homeSlug) throw new Error("simulated D1 failure");
      return real(id, patch);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await devicesPost(req("https://x/api/devices", { deviceId: DEV, homeSlug: "boca-raton" }));
    expect(res.status).toBe(500);
    const body = await json(res);
    expect(typeof body.installToken).toBe("string");
  });

  it("logs no token or hash", async () => {
    const spies = (["log", "info", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const first = await json(await devicesPost(req("https://x/api/devices", { deviceId: DEV })));
    await devicesPost(req("https://x/api/devices", { deviceId: DEV }, "wrong-token"));
    await devicesPost(req("https://x/api/devices", { deviceId: DEV }, first.installToken as string));
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls.map((c) => c.map(String))));
    for (const secret of [first.installToken as string, hashInstallToken(first.installToken as string), "wrong-token"]) {
      expect(logged).not.toContain(secret);
    }
  });
});

describe("POST /api/devices/trial — install token", () => {
  it("refuses without the token and leaves the trial unspent", async () => {
    await seedClaimedDevice();
    const store = await getStore();
    const res = await trialPost(req("https://x/api/devices/trial", { deviceId: DEV }));
    expect(res.status).toBe(401);
    expect((await json(res)).error).toBe("no-token");
    expect((await store.getDevice(DEV))!.trialUsed).toBe(false);
  });

  it("accepts the right token", async () => {
    await seedClaimedDevice();
    const res = await trialPost(req("https://x/api/devices/trial", { deviceId: DEV }, TOKEN));
    expect(res.status).toBe(200);
  });

  it("a device with no token on file still starts its trial", async () => {
    const res = await trialPost(req("https://x/api/devices/trial", { deviceId: DEV }));
    expect(res.status).toBe(200);
  });
});

describe("POST /api/devices/unlock — install token", () => {
  it("refuses without the token, wrong code still says bad-code first", async () => {
    await seedClaimedDevice();
    const bad = await unlockPost(req("https://x/api/devices/unlock", { deviceId: DEV, code: "nope" }));
    expect(bad.status).toBe(403);
    expect((await json(bad)).error).toBe("bad-code");
    const res = await unlockPost(req("https://x/api/devices/unlock", { deviceId: DEV, code: "sandy-shoes" }));
    expect(res.status).toBe(401);
  });

  it("accepts the right token", async () => {
    await seedClaimedDevice();
    const res = await unlockPost(req("https://x/api/devices/unlock", { deviceId: DEV, code: "sandy-shoes" }, TOKEN));
    expect(res.status).toBe(200);
  });
});

describe("/api/presence — install token", () => {
  const fix = { slug: "boca-raton", lat: 26.35, lon: -80.07, accuracyM: 15, source: "auto" };

  it("refuses to arm without the token", async () => {
    await seedClaimedDevice();
    const res = await presencePost(req("https://x/api/presence", { deviceId: DEV, ...fix, armedUntil: Date.now() + HOUR }));
    expect(res.status).toBe(401);
    expect((await json(res)).error).toBe("no-token");
    expect((await (await getStore()).getDevice(DEV))!.presence).toBeNull();
  });

  it("arms with the token, and refuses to disarm without it", async () => {
    await seedClaimedDevice();
    const armed = await presencePost(
      req("https://x/api/presence", { deviceId: DEV, ...fix, armedUntil: Date.now() + HOUR }, TOKEN),
    );
    expect(armed.status).toBe(200);

    const refused = await presenceDelete(req("https://x/api/presence", { deviceId: DEV }, undefined, "DELETE"));
    expect(refused.status).toBe(401);
    expect((await (await getStore()).getDevice(DEV))!.presence).not.toBeNull();

    const ok = await presenceDelete(req("https://x/api/presence", { deviceId: DEV }, TOKEN, "DELETE"));
    expect(ok.status).toBe(200);
    expect((await (await getStore()).getDevice(DEV))!.presence).toBeNull();
  });

  it("a device with no token on file can still arm (migration path)", async () => {
    const store = await getStore();
    await store.upsertDevice(DEV, { codeUntil: Date.now() + 30 * 24 * HOUR });
    const res = await presencePost(req("https://x/api/presence", { deviceId: DEV, ...fix, armedUntil: Date.now() + HOUR }));
    expect(res.status).toBe(200);
  });
});
