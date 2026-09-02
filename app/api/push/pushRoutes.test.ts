// Handler-level tests for the push routes on the D1-era store: register-native,
// unregister-native and the sender loop in run. Handlers are called directly
// with a Request. The transports, the conditions pipeline and the legacy KV
// reader are all mocked, so nothing touches the network or the disk.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ConditionsResponse } from "@/lib/types";
import type { NativeSub } from "@/lib/push/nativeStore";

// Shared switches the mocks read, so each test can steer the fakes.
const ctl = vi.hoisted(() => ({
  legacySubs: [] as NativeSub[],
  removed: [] as string[],
  sendResult: { ok: true, dead: false },
  fcmSends: [] as string[],
}));

vi.mock("@/lib/push/nativeStore", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/push/nativeStore")>();
  return {
    ...actual,
    listNativeSubs: async () => ctl.legacySubs,
    removeNativeSub: async (token: string) => {
      ctl.removed.push(token);
    },
  };
});

vi.mock("@/lib/push/apns", () => ({
  getApns: () => null, // no iOS transport in these tests
  openApnsSession: () => ({ send: async () => ({ ok: true }), close: () => {} }),
  isDeadToken: () => false,
}));

vi.mock("@/lib/push/fcm", () => ({
  getFcm: () => ({ projectId: "test-project" }),
  getFcmAccessToken: async () => "access-token",
  isDeadFcmToken: () => ctl.sendResult.dead,
  sendFcm: async (_a: string, _p: string, token: string) => {
    ctl.fcmSends.push(token);
    return { ok: ctl.sendResult.ok };
  },
}));

vi.mock("@/lib/conditions", () => ({
  getConditions: async () => CONDITIONS,
}));

const { POST: registerPost } = await import("@/app/api/push/register-native/route");
const { POST: unregisterPost } = await import("@/app/api/push/unregister-native/route");
const { POST: runPost } = await import("@/app/api/push/run/route");
const { getStore, legacyDeviceId } = await import("@/lib/db/store");
const { resetMemoryStore } = await import("@/lib/db/memoryStore");

/** Just enough of a conditions response for summarizeForPush. */
const CONDITIONS = {
  score: {
    score: 82,
    rawScore: 82,
    rating: "Excellent",
    caps: [],
    subScores: [
      { key: "waterTemp", label: "Water", score: 90, weight: 0.2 },
      { key: "waves", label: "Waves", score: 85, weight: 0.2 },
    ],
  },
  snapshot: {
    lightning: { status: "ok", data: null },
    nws: { status: "ok", data: { alerts: [] } },
    cityOfficial: { status: "ok", data: null },
    waterQuality: { status: "ok", data: null },
  },
  hourlyForecast: [],
  hourlyScores: [],
} as unknown as ConditionsResponse;

const DEV = "11111111-2222-4333-8444-555555555555";
const FCM_TOKEN = "f".repeat(80);
const FCM_TOKEN_2 = "g".repeat(80);

function post(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function legacySub(over: Partial<NativeSub> = {}): NativeSub {
  return {
    token: FCM_TOKEN,
    platform: "android",
    slug: "boca-raton",
    tz: "America/New_York",
    prefs: { morning: true, safety: true },
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  resetMemoryStore();
  ctl.legacySubs = [];
  ctl.removed = [];
  ctl.sendResult = { ok: true, dead: false };
  ctl.fcmSends = [];
  process.env.CRON_SECRET = "test-cron-secret";
});

describe("POST /api/push/register-native", () => {
  it("keeps the old response shape", async () => {
    const res = await registerPost(
      post("https://x/api/push/register-native", {
        slug: "boca-raton",
        token: FCM_TOKEN,
        platform: "android",
        prefs: { morning: true, safety: true },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("stores a client without a deviceId under a legacy id", async () => {
    await registerPost(
      post("https://x/api/push/register-native", {
        slug: "boca-raton",
        token: FCM_TOKEN,
        platform: "android",
        prefs: { morning: true, safety: false },
      }),
    );
    const store = await getStore();
    const device = await store.getDevice(legacyDeviceId(FCM_TOKEN));
    expect(device).toBeTruthy();
    expect(device!.homeSlug).toBe("boca-raton");
    expect(device!.tz).toBe("America/New_York");
    expect(device!.prefs.morning).toBe(true);
    expect(device!.prefs.lightning).toBe(false); // the coarse "safety" switch
  });

  it("writes straight to the deviceId row when the client sends one", async () => {
    await registerPost(
      post("https://x/api/push/register-native", {
        slug: "boca-raton",
        token: FCM_TOKEN,
        platform: "android",
        deviceId: DEV,
        prefs: { morning: true, safety: true },
      }),
    );
    const store = await getStore();
    expect(await store.getPushToken(DEV)).toBe(FCM_TOKEN);
    expect(await store.getDevice(legacyDeviceId(FCM_TOKEN))).toBeNull();
  });

  it("moves a legacy row onto the deviceId row and deletes it", async () => {
    // First register the old way, and give the row some dedup state.
    await registerPost(
      post("https://x/api/push/register-native", {
        slug: "boca-raton",
        token: FCM_TOKEN,
        platform: "android",
        prefs: { morning: false, safety: true },
      }),
    );
    const store = await getStore();
    const legacyId = legacyDeviceId(FCM_TOKEN);
    await store.setSent(legacyId, { morningDate: "2026-09-01" });

    // Then the updated app registers with its deviceId.
    await registerPost(
      post("https://x/api/push/register-native", {
        slug: "boca-raton",
        token: FCM_TOKEN,
        platform: "android",
        deviceId: DEV,
        prefs: { morning: false, safety: true },
      }),
    );

    expect(await store.getDevice(legacyId)).toBeNull();
    const device = await store.getDevice(DEV);
    expect(device!.homeSlug).toBe("boca-raton");
    expect(device!.prefs.morning).toBe(false);
    expect(await store.getSent(DEV)).toEqual({ morningDate: "2026-09-01" });
    expect(await store.listDevices()).toHaveLength(1);
  });

  it("clears the dedup state when the beach changes", async () => {
    const store = await getStore();
    await registerPost(
      post("https://x/api/push/register-native", {
        slug: "boca-raton",
        token: FCM_TOKEN,
        platform: "android",
        deviceId: DEV,
      }),
    );
    await store.setSent(DEV, { morningDate: "2026-09-01" });
    await registerPost(
      post("https://x/api/push/register-native", {
        slug: "cocoa-beach",
        token: FCM_TOKEN,
        platform: "android",
        deviceId: DEV,
      }),
    );
    expect(await store.getSent(DEV)).toEqual({});
    expect((await store.getDevice(DEV))!.homeSlug).toBe("cocoa-beach");
  });

  it("still rejects a bad beach, platform or token", async () => {
    const cases = [
      { slug: "atlantis", token: FCM_TOKEN, platform: "android" },
      { slug: "boca-raton", token: FCM_TOKEN, platform: "blackberry" },
      { slug: "boca-raton", token: "too-short", platform: "android" },
    ];
    for (const body of cases) {
      const res = await registerPost(post("https://x/api/push/register-native", body));
      expect(res.status).toBe(400);
    }
  });
});

describe("POST /api/push/unregister-native", () => {
  it("drops a legacy row and its KV record", async () => {
    await registerPost(
      post("https://x/api/push/register-native", {
        slug: "boca-raton",
        token: FCM_TOKEN,
        platform: "android",
      }),
    );
    const res = await unregisterPost(
      post("https://x/api/push/unregister-native", { token: FCM_TOKEN }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const store = await getStore();
    expect(await store.listDevices()).toHaveLength(0);
    expect(ctl.removed).toContain(FCM_TOKEN); // KV cleared, so no resurrection
  });

  it("keeps a real device but stops pushing to it", async () => {
    await registerPost(
      post("https://x/api/push/register-native", {
        slug: "boca-raton",
        token: FCM_TOKEN,
        platform: "android",
        deviceId: DEV,
      }),
    );
    await unregisterPost(post("https://x/api/push/unregister-native", { token: FCM_TOKEN }));
    const store = await getStore();
    expect(await store.getDevice(DEV)).toBeTruthy();
    expect(await store.getPushToken(DEV)).toBeNull();
    expect(await store.listPushable()).toHaveLength(0);
  });

  it("rejects a missing token", async () => {
    const res = await unregisterPost(post("https://x/api/push/unregister-native", {}));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/push/run", () => {
  function run(query = ""): Promise<Response> {
    return runPost(
      new Request(`https://x/api/push/run${query}`, {
        method: "POST",
        headers: { "x-cron-secret": "test-cron-secret" },
      }),
    );
  }

  async function seedDevice(): Promise<void> {
    await registerPost(
      post("https://x/api/push/register-native", {
        slug: "boca-raton",
        token: FCM_TOKEN,
        platform: "android",
        deviceId: DEV,
      }),
    );
  }

  it("503s without a cron secret", async () => {
    delete process.env.CRON_SECRET;
    const res = await run();
    expect(res.status).toBe(503);
  });

  it("401s on a wrong secret", async () => {
    const res = await runPost(
      new Request("https://x/api/push/run", {
        method: "POST",
        headers: { "x-cron-secret": "wrong" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("reports truthful counts and sends a forced morning summary", async () => {
    await seedDevice();
    const res = await run("?force=morning");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      mode: "all",
      beaches: 1,
      subscriptions: 1,
      ios: 0,
      android: 1,
      sent: 1,
      pruned: 0,
    });
    expect(ctl.fcmSends).toEqual([FCM_TOKEN]);
  });

  it("counts two beaches and two devices", async () => {
    await seedDevice();
    await registerPost(
      post("https://x/api/push/register-native", {
        slug: "cocoa-beach",
        token: FCM_TOKEN_2,
        platform: "android",
      }),
    );
    const body = (await (await run("?force=morning")).json()) as Record<string, number>;
    expect(body.beaches).toBe(2);
    expect(body.subscriptions).toBe(2);
    expect(body.sent).toBe(2);
  });

  it("mode=safety does not send the forced morning summary", async () => {
    await seedDevice();
    const body = (await (await run("?mode=safety&force=morning")).json()) as Record<string, unknown>;
    expect(body.mode).toBe("safety");
    expect(body.sent).toBe(0);
    expect(ctl.fcmSends).toEqual([]);
  });

  it("mode=morning still sends it", async () => {
    await seedDevice();
    const body = (await (await run("?mode=morning&force=morning")).json()) as Record<string, unknown>;
    expect(body.mode).toBe("morning");
    expect(body.sent).toBe(1);
  });

  it("prunes a dead token from D1 and KV", async () => {
    await seedDevice();
    ctl.sendResult = { ok: false, dead: true };
    const body = (await (await run("?force=morning")).json()) as Record<string, number>;
    expect(body.pruned).toBe(1);
    expect(body.sent).toBe(0);

    const store = await getStore();
    expect(await store.getDevice(DEV)).toBeNull();
    expect(ctl.removed).toContain(FCM_TOKEN);
  });

  it("imports legacy KV subscriptions on the first run, once", async () => {
    ctl.legacySubs = [legacySub()];
    const first = (await (await run()).json()) as Record<string, number>;
    expect(first.imported).toBe(1);
    expect(first.subscriptions).toBe(1);

    const store = await getStore();
    expect(await store.getDevice(legacyDeviceId(FCM_TOKEN))).toBeTruthy();

    const second = (await (await run()).json()) as Record<string, number>;
    expect(second.imported).toBe(0);
    expect(second.subscriptions).toBe(1);
    expect(await store.listDevices()).toHaveLength(1);
  });

  it("does not re-import a token a real device already owns", async () => {
    await seedDevice();
    ctl.legacySubs = [legacySub()];
    const body = (await (await run()).json()) as Record<string, number>;
    expect(body.imported).toBe(0);
    expect(body.subscriptions).toBe(1);
  });

  it("skips a device whose morning alert is switched off", async () => {
    await seedDevice();
    const store = await getStore();
    await store.upsertDevice(DEV, { prefs: { morning: false } });
    const body = (await (await run("?force=morning")).json()) as Record<string, number>;
    expect(body.sent).toBe(0);
  });
});
