// Route-level regression test for Codex review round-3 item 3 — "dueRemaining
// counts retryable work": a slug whose device hit a transient send failure
// (or an unsettled lost-claim race) THIS pass is still due, and must be
// folded back into the `dueRemaining` the JSON response reports, not just the
// narrower "excluded by the round-robin cap" count `dueRemaining` already
// tracked before round 3. Mirrors app/api/push/run/sunColorMismatch.test.ts's
// mocking pattern (own conditions fixture, matched estimate/snapshot sun
// times — no round-3-item-1 mismatch in play here, this test is only about
// item 3's retry accounting).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ConditionsResponse } from "@/lib/types";

const ctl = vi.hoisted(() => ({
  // The FIRST send this test makes fails transiently (ok:false, not dead);
  // every send after that succeeds — simulates a one-off FCM hiccup that
  // clears up by the very next pass.
  failNextSend: true,
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
    if (ctl.failNextSend) {
      ctl.failNextSend = false;
      return { ok: false }; // transient — NOT a dead token
    }
    return { ok: true };
  },
}));

// The ESTIMATE and the SNAPSHOT agree exactly — this test isn't exercising
// round-3 item 1's convergence logic, just item 3's retry accounting, so the
// event is unambiguously in-window from the first pass.
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
  getConditions: async (): Promise<ConditionsResponse> =>
    ({
      score: { score: 40, rawScore: 40, rating: "Fair", caps: [], subScores: [] },
      snapshot: {
        lightning: { status: "ok", data: null },
        nws: { status: "ok", data: { alerts: [] } },
        cityOfficial: { status: "ok", data: null },
        waterQuality: { status: "ok", data: null },
        generatedAt: new Date().toISOString(), // stamped fresh each call, reading the test's faked clock
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
    }) as unknown as ConditionsResponse,
}));

const { POST: registerPost } = await import("@/app/api/push/register-native/route");
const { POST: runPost } = await import("@/app/api/push/run/route");
const { getStore } = await import("@/lib/db/store");
const { resetMemoryStore } = await import("@/lib/db/memoryStore");

const DEV = "55555555-6666-7777-8888-999999999999";
const FCM_TOKEN = "f".repeat(80);

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
    // Only sun-color drives selection/dueRemaining here.
    prefs: { "sun-color": true, morning: false, "score-excellent": false },
  });
}

describe("POST /api/push/run — dueRemaining counts retryable work (round-3 item 3)", () => {
  const WINDOW_START = Date.parse(SUNSET_ISO) - 60 * 60_000; // the default 60-min lead

  beforeEach(() => {
    resetMemoryStore();
    ctl.failNextSend = true;
    ctl.fcmSends = 0;
    process.env.CRON_SECRET = "test-cron-secret";
    delete process.env.PUSH_SAFETY_ALERTS;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(WINDOW_START));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("1-beach pool: a transient send failure on pass 1 reports dueRemaining 1; pass 2 (same tick) retries and succeeds — dueRemaining 0", async () => {
    await seedDevice();

    const body1 = (await (await run()).json()) as Record<string, unknown>;
    expect(body1.sunColor).toBe(0); // the transient failure — nothing actually sent
    expect(body1.dueRemaining).toBe(1); // still due: retryable, not settled
    expect(ctl.fcmSends).toBe(1); // the one failed attempt

    const store = await getStore();
    expect(await store.lastAlert(DEV, "sun-color:sunset:2026-09-02")).toBeNull(); // never sent — no alert_log entry

    // Same tick (nowMs unchanged) — the cron's own pass 2, exactly the
    // retry dueRemaining>0 is meant to trigger.
    const body2 = (await (await run()).json()) as Record<string, unknown>;
    expect(body2.sunColor).toBe(1); // retried and succeeded
    expect(body2.dueRemaining).toBe(0); // settled — nothing left to retry
    expect(ctl.fcmSends).toBe(2);
    expect(await store.lastAlert(DEV, "sun-color:sunset:2026-09-02")).not.toBeNull();

    // And a third pass must not send again — the event is now latched via
    // the ordinary alert_log dedupe, same as every other successful send.
    const body3 = (await (await run()).json()) as Record<string, unknown>;
    expect(body3.sunColor).toBe(0);
    expect(body3.dueRemaining).toBe(0);
    expect(ctl.fcmSends).toBe(2);
  });
});
