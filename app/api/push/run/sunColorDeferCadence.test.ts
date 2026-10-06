// Route-level regression test for Codex review round-4 item 1 — "a
// persisted defer must itself be a due window on real 5-min ticks". Round-3
// item 1 introduced `sent.sunColorDeferUntilMs`, but the FIRST cut left
// `sunColorSlugNeed` returning `candidate: true` for the whole wait, and
// `candidate` alone still triggers a real conditions fetch in this route —
// so the deferral never actually stopped the wasted re-fetching it was
// meant to stop. This file drives the real route at the cron's own 5-minute
// cadence (unlike sunColorMismatch.test.ts's scenario (b), which only checks
// the pass right after the window opens) to prove: no fetch AT ALL while
// still waiting, and exactly one fetch+send once the deferred window is
// actually open.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ConditionsResponse } from "@/lib/types";

const ctl = vi.hoisted(() => ({
  conditions: null as unknown,
  fcmMessages: [] as { title: string; body: string }[],
  conditionsCalls: [] as string[],
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
  sendFcm: async (_a: string, _p: string, token: string, msg: { title: string; body: string }) => {
    ctl.fcmMessages.push({ title: msg.title, body: msg.body });
    return { ok: true };
  },
}));

vi.mock("@/lib/conditions", () => ({
  getConditions: async (slug: string) => {
    ctl.conditionsCalls.push(slug);
    const c = ctl.conditions as ConditionsResponse;
    return { ...c, snapshot: { ...c.snapshot, generatedAt: new Date().toISOString() } };
  },
}));

// The ESTIMATE always says: sunrise already passed, sunset at SUNSET_ISO.
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

const { POST: registerPost } = await import("@/app/api/push/register-native/route");
const { POST: runPost } = await import("@/app/api/push/run/route");
const { getStore } = await import("@/lib/db/store");
const { resetMemoryStore } = await import("@/lib/db/memoryStore");

const DEV = "66666666-7777-8888-9999-aaaaaaaaaaaa";
const FCM_TOKEN = "d".repeat(80);

function conditions(opts: { snapshotSunsetIso: string; hourlyTimeIso: string }): ConditionsResponse {
  return {
    score: { score: 40, rawScore: 40, rating: "Fair", caps: [], subScores: [] },
    snapshot: {
      lightning: { status: "ok", data: null },
      nws: { status: "ok", data: { alerts: [] } },
      cityOfficial: { status: "ok", data: null },
      waterQuality: { status: "ok", data: null },
      sun: { status: "ok", data: { sunrise: SUNRISE_ISO, sunset: opts.snapshotSunsetIso } },
      hourly: {
        status: "ok",
        data: [{ time: opts.hourlyTimeIso, cloudCoverLowPct: 10, cloudCoverMidPct: 35, cloudCoverHighPct: 10 }],
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

const FIVE_MIN = 5 * 60_000;

describe("POST /api/push/run — a persisted sun-color defer is itself a due window on real 5-min ticks (round-4 item 1)", () => {
  const T0 = Date.parse(SUNSET_ISO) - 60 * 60_000; // the ESTIMATE's own window start (60-min lead)

  beforeEach(() => {
    resetMemoryStore();
    ctl.fcmMessages = [];
    ctl.conditionsCalls = [];
    process.env.CRON_SECRET = "test-cron-secret";
    delete process.env.PUSH_SAFETY_ALERTS;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("real window opens at +11: +0 fetches and defers, +5/+10 fetch NOTHING, +15 fetches and sends exactly once", async () => {
    vi.setSystemTime(new Date(T0));
    await seedDevice();
    const realSunset = new Date(Date.parse(SUNSET_ISO) + 11 * 60_000).toISOString();
    ctl.conditions = conditions({ snapshotSunsetIso: realSunset, hourlyTimeIso: realSunset });

    // +0: the ESTIMATE is due, so this pass DOES fetch — and finds the real
    // window opening soon (11 min, within the 15-min defer tolerance), so it
    // defers rather than sending or latching.
    const body0 = (await (await run()).json()) as Record<string, unknown>;
    expect(body0.sunColor).toBe(0);
    expect(ctl.conditionsCalls).toEqual(["boca-raton"]);

    // +5: still short of the deferred window (which opens at +11) — must
    // NOT fetch at all (the round-4 item 1 fix: `candidate` alone used to
    // still trigger a fetch here).
    vi.setSystemTime(new Date(T0 + FIVE_MIN));
    const body5 = (await (await run()).json()) as Record<string, unknown>;
    expect(body5.sunColor).toBe(0);
    expect(ctl.conditionsCalls).toEqual(["boca-raton"]); // still just the one call

    // +10: same — the deferred window hasn't opened yet.
    vi.setSystemTime(new Date(T0 + 2 * FIVE_MIN));
    const body10 = (await (await run()).json()) as Record<string, unknown>;
    expect(body10.sunColor).toBe(0);
    expect(ctl.conditionsCalls).toEqual(["boca-raton"]);

    // +15: now inside the deferred window (which opened at +11) — fetches
    // again, finds the real snapshot genuinely in its own send window, and
    // sends exactly once.
    vi.setSystemTime(new Date(T0 + 3 * FIVE_MIN));
    const body15 = (await (await run()).json()) as Record<string, unknown>;
    expect(body15.sunColor).toBe(1);
    expect(ctl.fcmMessages).toHaveLength(1);
    expect(ctl.conditionsCalls).toEqual(["boca-raton", "boca-raton"]);

    const store = await getStore();
    expect(await store.lastAlert(DEV, "sun-color:sunset:2026-09-02")).not.toBeNull();

    // A pass right after must not send again.
    vi.setSystemTime(new Date(T0 + 3 * FIVE_MIN + 60_000));
    const body16 = (await (await run()).json()) as Record<string, unknown>;
    expect(body16.sunColor).toBe(0);
    expect(ctl.fcmMessages).toHaveLength(1);
  });

  it("variant: real window opens at +14 (just inside the +15 tick) — sent at +15", async () => {
    vi.setSystemTime(new Date(T0));
    await seedDevice();
    const realSunset = new Date(Date.parse(SUNSET_ISO) + 14 * 60_000).toISOString();
    ctl.conditions = conditions({ snapshotSunsetIso: realSunset, hourlyTimeIso: realSunset });

    const body0 = (await (await run()).json()) as Record<string, unknown>;
    expect(body0.sunColor).toBe(0);
    expect(ctl.conditionsCalls).toEqual(["boca-raton"]);

    vi.setSystemTime(new Date(T0 + FIVE_MIN));
    await run();
    vi.setSystemTime(new Date(T0 + 2 * FIVE_MIN));
    await run();
    expect(ctl.conditionsCalls).toEqual(["boca-raton"]); // no fetch at +5 or +10 either

    vi.setSystemTime(new Date(T0 + 3 * FIVE_MIN)); // +15 — inside [+14, +24)
    const body15 = (await (await run()).json()) as Record<string, unknown>;
    expect(body15.sunColor).toBe(1);
    expect(ctl.fcmMessages).toHaveLength(1);
    expect(ctl.conditionsCalls).toEqual(["boca-raton", "boca-raton"]);
  });
});
