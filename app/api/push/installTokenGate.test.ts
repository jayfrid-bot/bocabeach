// The install-token gate on the push routes: /api/push/register-native and
// /api/push/unregister-native. A device id is not a secret (it is the "Support
// ID"), so knowing it must not be enough to redirect or switch off that phone's
// alerts. Handlers are called directly; the memory store stands in for D1.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ctl = vi.hoisted(() => ({ removed: [] as string[] }));

vi.mock("@/lib/push/nativeStore", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/push/nativeStore")>();
  return {
    ...actual,
    listNativeSubs: async () => [],
    removeNativeSub: async (token: string) => {
      ctl.removed.push(token);
    },
  };
});

const { POST: registerPost } = await import("@/app/api/push/register-native/route");
const { POST: unregisterPost } = await import("@/app/api/push/unregister-native/route");
const { getStore, hashInstallToken, legacyDeviceId } = await import("@/lib/db/store");
const { resetMemoryStore } = await import("@/lib/db/memoryStore");

const DEV = "11111111-2222-4333-8444-555555555555";
const OWNER_PUSH = "a".repeat(80); // the phone's own FCM token
const ATTACKER_PUSH = "b".repeat(80); // the token an attacker wants alerts sent to
const OWNER_TOKEN = "owner-install-token-for-tests";

function req(path: string, body: unknown, installToken?: string): Request {
  return new Request(`https://x/api/push/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(installToken ? { "x-install-token": installToken } : {}),
    },
    body: JSON.stringify(body),
  });
}

function register(over: Record<string, unknown> = {}, installToken?: string): Request {
  return req(
    "register-native",
    { slug: "boca-raton", token: OWNER_PUSH, platform: "android", deviceId: DEV, ...over },
    installToken,
  );
}

/** A device that already registered once and holds OWNER_TOKEN. */
async function seedClaimedDevice(): Promise<void> {
  const store = await getStore();
  await store.upsertDevice(DEV, { platform: "android", pushToken: OWNER_PUSH, homeSlug: "boca-raton" });
  await store.setInstallTokenHash(DEV, hashInstallToken(OWNER_TOKEN), Date.now());
}

beforeEach(() => {
  resetMemoryStore();
  ctl.removed = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/push/register-native — install token", () => {
  it("a device with no token on file registers once without one, and is handed a token", async () => {
    const res = await registerPost(register());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; installToken?: string };
    expect(body.ok).toBe(true);
    expect(typeof body.installToken).toBe("string");

    const store = await getStore();
    expect(await store.getPushToken(DEV)).toBe(OWNER_PUSH);
    // Only the hash is stored.
    expect(await store.getInstallTokenHash(DEV)).toBe(hashInstallToken(body.installToken!));
  });

  it("then refuses a second call with no token: the push target stays put", async () => {
    await registerPost(register());
    const res = await registerPost(register({ token: ATTACKER_PUSH }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("no-token");

    const store = await getStore();
    expect(await store.getPushToken(DEV)).toBe(OWNER_PUSH);
  });

  it("refuses a wrong token", async () => {
    await seedClaimedDevice();
    const res = await registerPost(register({ token: ATTACKER_PUSH }, "not-the-token"));
    expect(res.status).toBe(401);
    expect((await getStore().then((s) => s.getPushToken(DEV)))).toBe(OWNER_PUSH);
  });

  it("refuses a missing token for a row that has one on file", async () => {
    await seedClaimedDevice();
    const res = await registerPost(register({ token: ATTACKER_PUSH, slug: "cocoa-beach" }));
    expect(res.status).toBe(401);
    const store = await getStore();
    expect(await store.getPushToken(DEV)).toBe(OWNER_PUSH);
    expect((await store.getDevice(DEV))!.homeSlug).toBe("boca-raton");
  });

  it("accepts the right token, changes the target, and mints nothing new", async () => {
    await seedClaimedDevice();
    const res = await registerPost(register({ token: "c".repeat(80) }, OWNER_TOKEN));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const store = await getStore();
    expect(await store.getPushToken(DEV)).toBe("c".repeat(80));
    expect(await store.getInstallTokenHash(DEV)).toBe(hashInstallToken(OWNER_TOKEN));
  });

  it("an attacker who knows only the device id cannot turn alerts off or move them", async () => {
    await seedClaimedDevice();
    // Different beach, different token, no proof.
    const res = await registerPost(
      register({ token: ATTACKER_PUSH, slug: "cocoa-beach", prefs: { morning: false, safety: false } }),
    );
    expect(res.status).toBe(401);
    const store = await getStore();
    expect(await store.listPushable()).toHaveLength(1);
    expect((await store.listPushable())[0].token).toBe(OWNER_PUSH);
  });

  it("first claim is atomic: of two concurrent token-less registers exactly one wins", async () => {
    const [a, b] = await Promise.all([
      registerPost(register({ token: OWNER_PUSH })),
      registerPost(register({ token: ATTACKER_PUSH })),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 401]);

    const winner = a.status === 200 ? a : b;
    const winnerPush = a.status === 200 ? OWNER_PUSH : ATTACKER_PUSH;
    const body = (await winner.json()) as { installToken?: string };
    expect(typeof body.installToken).toBe("string");

    const store = await getStore();
    // The loser wrote nothing: the stored target is the winner's, and the one
    // hash on file belongs to the winner's token.
    expect(await store.getPushToken(DEV)).toBe(winnerPush);
    expect(await store.getInstallTokenHash(DEV)).toBe(hashInstallToken(body.installToken!));
  });

  it("returns the claimed token even when the write fails after the claim", async () => {
    const store = await getStore();
    const real = store.upsertDevice.bind(store);
    vi.spyOn(store, "upsertDevice").mockImplementation(async (id, patch) => {
      if (patch.pushToken) throw new Error("simulated D1 failure");
      return real(id, patch);
    });
    const res = await registerPost(register());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { installToken?: string };
    // Without this the phone would be locked out of its own row.
    expect(typeof body.installToken).toBe("string");
    expect(await store.getInstallTokenHash(DEV)).toBe(hashInstallToken(body.installToken!));
  });

  it("an old build with no deviceId still registers (its row is keyed by the push token)", async () => {
    const res = await registerPost(req("register-native", { slug: "boca-raton", token: OWNER_PUSH, platform: "android" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const store = await getStore();
    expect(await store.getPushToken(legacyDeviceId(OWNER_PUSH))).toBe(OWNER_PUSH);
  });

  it("a reinstall (new device id, same push token) still moves the token over", async () => {
    await seedClaimedDevice();
    const NEW = "99999999-2222-4333-8444-555555555555";
    const res = await registerPost(register({ deviceId: NEW, token: OWNER_PUSH }));
    expect(res.status).toBe(200);
    const store = await getStore();
    expect(await store.getPushToken(NEW)).toBe(OWNER_PUSH);
    expect(await store.getPushToken(DEV)).toBeNull();
  });
});

describe("POST /api/push/unregister-native — install token", () => {
  it("refuses a call without the row's token and leaves the push target alone", async () => {
    await seedClaimedDevice();
    const res = await unregisterPost(req("unregister-native", { token: OWNER_PUSH, deviceId: DEV }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("no-token");
    const store = await getStore();
    expect(await store.getPushToken(DEV)).toBe(OWNER_PUSH);
    expect(ctl.removed).toHaveLength(0); // the legacy KV copy is not touched either
  });

  it("refuses a wrong token", async () => {
    await seedClaimedDevice();
    const res = await unregisterPost(req("unregister-native", { token: OWNER_PUSH, deviceId: DEV }, "nope"));
    expect(res.status).toBe(401);
    expect(await (await getStore()).getPushToken(DEV)).toBe(OWNER_PUSH);
  });

  it("accepts the right token and stops pushing, keeping the device record", async () => {
    await seedClaimedDevice();
    const res = await unregisterPost(req("unregister-native", { token: OWNER_PUSH, deviceId: DEV }, OWNER_TOKEN));
    expect(res.status).toBe(200);
    const store = await getStore();
    expect(await store.getPushToken(DEV)).toBeNull();
    expect(await store.getDevice(DEV)).toBeTruthy();
    expect(ctl.removed).toContain(OWNER_PUSH);
  });

  it("the check follows the row found by push token, not the deviceId in the body", async () => {
    await seedClaimedDevice();
    // Attacker names a made-up id but knows the push token: still needs the row's token.
    const res = await unregisterPost(
      req("unregister-native", { token: OWNER_PUSH, deviceId: "00000000-2222-4333-8444-555555555555" }),
    );
    expect(res.status).toBe(401);
    expect(await (await getStore()).getPushToken(DEV)).toBe(OWNER_PUSH);
  });

  it("lets through a real row that has no token on file yet (not yet migrated)", async () => {
    const store = await getStore();
    await store.upsertDevice(DEV, { platform: "android", pushToken: OWNER_PUSH, homeSlug: "boca-raton" });
    const res = await unregisterPost(req("unregister-native", { token: OWNER_PUSH }));
    expect(res.status).toBe(200);
    expect(await store.getPushToken(DEV)).toBeNull();
  });

  it("lets through a legacy row (no deviceId): the push token is its proof", async () => {
    await registerPost(req("register-native", { slug: "boca-raton", token: OWNER_PUSH, platform: "android" }));
    const res = await unregisterPost(req("unregister-native", { token: OWNER_PUSH }));
    expect(res.status).toBe(200);
    expect(await (await getStore()).listDevices()).toHaveLength(0);
  });
});

describe("install token values never reach the logs", () => {
  it("no console call carries a raw token, a hash, or a push token", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));

    const first = await registerPost(register());
    const minted = ((await first.json()) as { installToken: string }).installToken;
    await registerPost(register({ token: ATTACKER_PUSH })); // 401
    await registerPost(register({ token: ATTACKER_PUSH }, "wrong-token")); // 401
    await registerPost(register({ token: "c".repeat(80) }, minted)); // 200
    await unregisterPost(req("unregister-native", { token: "c".repeat(80), deviceId: DEV })); // 401
    // And a 500 after a claim.
    const store = await getStore();
    vi.spyOn(store, "upsertDevice").mockRejectedValue(new Error("simulated D1 failure"));
    await registerPost(register({ deviceId: "88888888-2222-4333-8444-555555555555" }));

    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls.map((c) => c.map(String))));
    for (const secret of [minted, hashInstallToken(minted), OWNER_PUSH, ATTACKER_PUSH, "c".repeat(80), "wrong-token"]) {
      expect(logged).not.toContain(secret);
    }
  });
});
