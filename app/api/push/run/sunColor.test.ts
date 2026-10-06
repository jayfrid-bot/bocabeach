// Route-level test for the "sun-color" alert (opt-in, standalone) in
// POST /api/push/run — mirrors app/api/push/pushRoutes.test.ts's mocking
// pattern but isolated in its own file since it needs its own
// `computeSunTimes` mock (that file pins sunrise/sunset to fixed, decades-
// away instants so score-excellent's daylight gate is deterministic, which
// would make sun-color's "next event" always ~74 years out and never due).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ConditionsResponse } from "@/lib/types";

const ctl = vi.hoisted(() => ({
  conditions: null as unknown,
  fcmMessages: [] as { title: string; body: string }[],
  fcmSends: [] as string[],
  /** How many of the NEXT sendFcm calls should fail transiently (ok:false,
   *  not dead) — item 1's retry-inside-the-window test. */
  failNext: 0,
}));

vi.mock("@/lib/push/nativeStore", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/push/nativeStore")>();
  return { ...actual, listNativeSubs: async () => [], removeNativeSub: async () => {} };
});

vi.mock("@/lib/push/apns", () => ({
  getApns: () => null, // no iOS transport — every seeded device is android
  openApnsSession: () => ({ send: async () => ({ ok: true }), close: () => {} }),
  isDeadToken: () => false,
}));

vi.mock("@/lib/push/fcm", () => ({
  getFcm: () => ({ projectId: "test-project" }),
  getFcmAccessToken: async () => "access-token",
  isDeadFcmToken: () => false,
  sendFcm: async (_a: string, _p: string, token: string, msg: { title: string; body: string }) => {
    if (ctl.failNext > 0) {
      ctl.failNext -= 1;
      return { ok: false }; // transient — never counted as sent
    }
    ctl.fcmSends.push(token);
    ctl.fcmMessages.push({ title: msg.title, body: msg.body });
    return { ok: true };
  },
}));

vi.mock("@/lib/conditions", () => ({
  // `generatedAt` is stamped fresh at CALL time (reading the test's own
  // faked clock) rather than baked into the static `conditions()` fixture —
  // predictNextSunEvent scores off the snapshot's own `generatedAt`, not
  // the route's wall clock (Requirement item 4), so it must land on the
  // same fixed 2026-09-02 day as SUNRISE_ISO/SUNSET_ISO for `nextSunEvent`
  // to pick the right event at all.
  getConditions: async () => {
    const c = ctl.conditions as ConditionsResponse;
    return { ...c, snapshot: { ...c.snapshot, generatedAt: new Date().toISOString() } };
  },
}));

// boca-raton's real coordinates/timezone (config/locations.ts) — sunset
// pinned to SUNSET_ISO below regardless of which calendar day is queried,
// so `sunColorSlugNeed`'s own computeSunTimes call and the conditions
// snapshot's `sun.data` always agree on the same event.
const SUNSET_ISO = "2026-09-02T23:00:00Z";
const SUNRISE_ISO = "2026-09-02T10:00:00Z"; // already passed relative to every "now" this file uses

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

const { POST: registerPost } = await import("@/app/api/push/register-native/route");
const { POST: runPost } = await import("@/app/api/push/run/route");
const { getStore } = await import("@/lib/db/store");
const { resetMemoryStore } = await import("@/lib/db/memoryStore");

const DEV = "33333333-4444-5555-8666-777777777777";
const FCM_TOKEN = "s".repeat(80);

/** A vivid-scoring (Great, score ~73) cloud mix at the exact sunset hour —
 *  lowPct=10 (under the "costs nothing" bar), mid/high combined 25%. Score
 *  is well below the Excellent threshold (90) so score-excellent — left on
 *  its default — stays a harmless "candidate", never an actual send. */
function conditions(): ConditionsResponse {
  return {
    score: { score: 40, rawScore: 40, rating: "Fair", caps: [], subScores: [] },
    snapshot: {
      lightning: { status: "ok", data: null },
      nws: { status: "ok", data: { alerts: [] } },
      cityOfficial: { status: "ok", data: null },
      waterQuality: { status: "ok", data: null },
      sun: { status: "ok", data: { sunrise: SUNRISE_ISO, sunset: SUNSET_ISO } },
      hourly: {
        status: "ok",
        data: [{ time: SUNSET_ISO, cloudCoverLowPct: 10, cloudCoverMidPct: 35, cloudCoverHighPct: 10 }],
      },
      airQuality: { status: "ok", data: null },
      goesCloud: { status: "ok", data: null },
    },
    hourlyForecast: [],
    hourlyScores: [],
  } as unknown as ConditionsResponse;
}

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

async function seedDevice(prefsOver: Record<string, boolean> = {}): Promise<void> {
  await registerPost(
    post("https://x/api/push/register-native", {
      slug: "boca-raton",
      token: FCM_TOKEN,
      platform: "android",
      deviceId: DEV,
      prefs: { morning: false, safety: false, ...prefsOver },
    }),
  );
  const store = await getStore();
  await store.upsertDevice(DEV, {
    codeUntil: Date.now() + 30 * 24 * 3600 * 1000, // Plus
    prefs: { "sun-color": true },
  });
}

describe("POST /api/push/run — sun-color alert", () => {
  beforeEach(() => {
    resetMemoryStore();
    ctl.conditions = conditions();
    ctl.fcmMessages = [];
    ctl.fcmSends = [];
    ctl.failNext = 0;
    process.env.CRON_SECRET = "test-cron-secret";
    delete process.env.PUSH_SAFETY_ALERTS;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends exactly once inside the send window (default: Great-or-better, 60-minute lead)", async () => {
    vi.useFakeTimers();
    // The window's own start for a 60-min lead: sunset − 60min.
    vi.setSystemTime(new Date(Date.parse(SUNSET_ISO) - 60 * 60_000));
    await seedDevice();

    const body = (await (await run()).json()) as Record<string, unknown>;
    expect(body.sunColor).toBe(1);
    expect(ctl.fcmMessages).toHaveLength(1);
    expect(ctl.fcmMessages[0].title).toBe("Great sunset coming");
    expect(ctl.fcmMessages[0].body).toMatch(/rated Great/);

    const store = await getStore();
    expect(await store.lastAlert(DEV, "sun-color:sunset:2026-09-02")).not.toBeNull();
  });

  it("Codex review item 1: a transient failure on tick 1 retries and succeeds on tick 2 (5 min later) — exactly one push, never two", async () => {
    vi.useFakeTimers();
    const windowStart = Date.parse(SUNSET_ISO) - 60 * 60_000;
    vi.setSystemTime(new Date(windowStart));
    await seedDevice();

    // Tick 1 (+0): the send transport fails transiently.
    ctl.failNext = 1;
    const body1 = (await (await run()).json()) as Record<string, unknown>;
    expect(body1.sunColor).toBe(0);
    expect(ctl.fcmMessages).toEqual([]);
    // The claim must have been released immediately (item 1's `releaseSend`)
    // rather than sitting unclaimable until ABANDONED_CLAIM_MS (10 min) —
    // proven by tick 2, 5 min later, succeeding at all.

    // Tick 2 (+5 min) — still inside the 10-minute window.
    vi.setSystemTime(new Date(windowStart + 5 * 60_000));
    const body2 = (await (await run()).json()) as Record<string, unknown>;
    expect(body2.sunColor).toBe(1);
    expect(ctl.fcmMessages).toHaveLength(1);
    expect(ctl.fcmMessages[0].title).toBe("Great sunset coming");

    // A third tick (+10, past the window's own close) must not send again.
    vi.setSystemTime(new Date(windowStart + 10 * 60_000));
    const body3 = (await (await run()).json()) as Record<string, unknown>;
    expect(body3.sunColor).toBe(0);
    expect(ctl.fcmMessages).toHaveLength(1);
  });

  it("never sends when sun-color is off (the default)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(SUNSET_ISO) - 60 * 60_000));
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
    await store.upsertDevice(DEV, { codeUntil: Date.now() + 30 * 24 * 3600 * 1000 }); // sun-color left at its off default

    const body = (await (await run()).json()) as Record<string, unknown>;
    expect(body.sunColor).toBe(0);
    expect(ctl.fcmMessages).toEqual([]);
  });

  it("never sends before the window opens", async () => {
    vi.useFakeTimers();
    // 61 minutes before sunset — one minute short of the 60-min lead's window.
    vi.setSystemTime(new Date(Date.parse(SUNSET_ISO) - 61 * 60_000));
    await seedDevice();

    const body = (await (await run()).json()) as Record<string, unknown>;
    expect(body.sunColor).toBe(0);
    expect(ctl.fcmMessages).toEqual([]);
  });

  it("never fires after the event has already happened", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(SUNSET_ISO) + 5 * 60_000)); // 5 min after sunset
    // Leave score-excellent on its default (daylight-gated candidate) so the
    // beach's conditions genuinely get fetched this tick even though the
    // event has passed — proving the rejection is the decision's own event
    // math, not just "the beach was never selected".
    await seedDevice();

    const body = (await (await run()).json()) as Record<string, unknown>;
    expect(body.sunColor).toBe(0);
    expect(ctl.fcmMessages).toEqual([]);
  });

  it("does not send twice: a second run inside the same window sends nothing further", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(SUNSET_ISO) - 60 * 60_000));
    await seedDevice();

    await run();
    ctl.fcmMessages = [];
    const body = (await (await run()).json()) as Record<string, unknown>;
    expect(body.sunColor).toBe(0);
    expect(ctl.fcmMessages).toEqual([]);
  });

  it("Amazing-only: a Great-but-not-Amazing score never sends when the device asked for Amazing only", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(SUNSET_ISO) - 60 * 60_000));
    await seedDevice();
    const store = await getStore();
    await store.upsertDevice(DEV, { sunColorMinBand: "epic" });

    const body = (await (await run()).json()) as Record<string, unknown>;
    expect(body.sunColor).toBe(0);
    expect(ctl.fcmMessages).toEqual([]);
  });

  it("a 30-minute lead opens (and closes) its own, earlier window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(SUNSET_ISO) - 30 * 60_000));
    await seedDevice();
    const store = await getStore();
    await store.upsertDevice(DEV, { sunColorLeadMin: 30 });

    const body = (await (await run()).json()) as Record<string, unknown>;
    expect(body.sunColor).toBe(1);
    expect(ctl.fcmMessages).toHaveLength(1);
  });
});
