// Route-level regression test for Codex review round-4 item 2 — "count
// conditions-load failures": when a selected `due` slug's conditions load
// throws (or resolves null), that slug must be folded into `dueRemaining`
// (via `retryableDueSlugs`, the same mechanism round-3 item 3 introduced for
// per-device retryable outcomes) so the cron makes another pass, rather than
// silently `continue`-ing past it uncounted.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ConditionsResponse } from "@/lib/types";

const ctl = vi.hoisted(() => ({
  // The FIRST conditions load for this test throws; every load after that
  // succeeds — a one-off upstream hiccup that clears by the very next pass.
  throwNextLoad: true,
  fcmSends: 0,
}));

vi.mock("@/lib/push/nativeStore", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/push/nativeStore")>();
  return { ...actual, listNativeSubs: async () => [], removeNativeSub: async () => {} };
});

vi.mock("@/lib/push/apns", () => ({
  getApns: () => null,
  openApnsSession: () => ({ send: async () => ({ ok: true }), close: () => {} }),
  isDeadToken: () => false,
}));

vi.mock("@/lib/push/fcm", () => ({
  getFcm: () => ({ projectId: "test-project" }),
  getFcmAccessToken: async () => "access-token",
  isDeadFcmToken: () => false,
  sendFcm: async () => {
    ctl.fcmSends += 1;
    return { ok: true };
  },
}));

const SUNSET_ISO = "2026-09-02T23:00:00Z";
const SUNRISE_ISO = "2026-09-02T10:00:00Z";

vi.mock("@/lib/sources/sun", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/sources/sun")>();
  return {
    ...actual,
    computeSunTimes: () => ({
      daybreak: null,
      sunrise: new Date(SUNRISE_ISO),
      solarNoon: null,
      sunset: new Date(SUNSET_ISO),
      dusk: null,
      goldenAmStart: null,
      goldenAmEnd: null,
      goldenEveStart: null,
      goldenEveEnd: null,
      blueAmStart: null,
      blueAmEnd: null,
      blueEveStart: null,
      blueEveEnd: null,
      goldenAmPeak: null,
      goldenEvePeak: null,
      maxAltitudeDeg: 60,
    }),
  };
});

vi.mock("@/lib/conditions", () => ({
  getConditions: async (): Promise<ConditionsResponse> => {
    if (ctl.throwNextLoad) {
      ctl.throwNextLoad = false;
      throw new Error("upstream fetch failed");
    }
    return {
      score: { score: 40, rawScore: 40, rating: "Fair", caps: [], subScores: [] },
      snapshot: {
        lightning: { status: "ok", data: null },
        nws: { status: "ok", data: { alerts: [] } },
        cityOfficial: { status: "ok", data: null },
        waterQuality: { status: "ok", data: null },
        generatedAt: new Date().toISOString(),
        sun: { status: "ok", data: { sunrise: SUNRISE_ISO, sunset: SUNSET_ISO } },
        hourly: {
          status: "ok",
          data: [{ time: SUNSET_ISO, cloudCoverLowPct: 10, cloudCoverMidPct: 25, cloudCoverHighPct: 0 }],
        },
        airQuality: { status: "ok", data: null },
        goesCloud: { status: "ok", data: null },
      },
      hourlyForecast: [],
      hourlyScores: [],
    } as unknown as ConditionsResponse;
  },
}));

const { POST: registerPost } = await import("@/app/api/push/register-native/route");
const { POST: runPost } = await import("@/app/api/push/run/route");
const { getStore } = await import("@/lib/db/store");
const { resetMemoryStore } = await import("@/lib/db/memoryStore");

const DEV = "77777777-8888-9999-aaaa-bbbbbbbbbbbb";
const FCM_TOKEN = "e".repeat(80);

function post(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function run(): Promise<Response> {
  return runPost(
    new Request("https://x/api/push/run", {
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
      prefs: { morning: false, safety: false },
    }),
  );
  const store = await getStore();
  await store.upsertDevice(DEV, {
    codeUntil: Date.now() + 30 * 24 * 3600 * 1000, // Plus
    prefs: { "sun-color": true, morning: false, "score-excellent": false },
  });
}

describe("POST /api/push/run — dueRemaining counts a thrown conditions load (round-4 item 2)", () => {
  const WINDOW_START = Date.parse(SUNSET_ISO) - 60 * 60_000; // the default 60-min lead

  beforeEach(() => {
    resetMemoryStore();
    ctl.throwNextLoad = true;
    ctl.fcmSends = 0;
    process.env.CRON_SECRET = "test-cron-secret";
    delete process.env.PUSH_SAFETY_ALERTS;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(WINDOW_START));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("1-beach pool: the fetcher throws on pass 1 (dueRemaining 1); pass 2 (same tick) fetch succeeds and sends once (dueRemaining 0)", async () => {
    await seedDevice();

    const body1 = (await (await run()).json()) as Record<string, unknown>;
    expect(body1.sunColor).toBe(0); // the load threw — nothing to decide off
    expect(body1.dueRemaining).toBe(1); // still due: retryable, not settled
    expect(ctl.fcmSends).toBe(0);

    const store = await getStore();
    expect(await store.lastAlert(DEV, "sun-color:sunset:2026-09-02")).toBeNull();

    const body2 = (await (await run()).json()) as Record<string, unknown>;
    expect(body2.sunColor).toBe(1); // retried and this time the load succeeded
    expect(body2.dueRemaining).toBe(0);
    expect(ctl.fcmSends).toBe(1);
    expect(await store.lastAlert(DEV, "sun-color:sunset:2026-09-02")).not.toBeNull();

    // A third pass must not send again.
    const body3 = (await (await run()).json()) as Record<string, unknown>;
    expect(body3.sunColor).toBe(0);
    expect(body3.dueRemaining).toBe(0);
    expect(ctl.fcmSends).toBe(1);
  });
});
