// Route-level regression tests for the "sun-color" alert's ESTIMATE-vs-
// SNAPSHOT disagreement handling (Codex review round-3 item 1 —
// "disagreement must converge"). Mirrors app/api/push/run/sunColor.test.ts's
// mocking pattern, but isolated in its own file since every test here needs
// its OWN conditions fetcher call-count assertion and a snapshot sunset
// time that deliberately disagrees with the pure `computeSunTimes` estimate
// — mixing that into the other file's shared `conditions()` fixture would
// make its many other tests harder to reason about.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ConditionsResponse } from "@/lib/types";

const ctl = vi.hoisted(() => ({
  conditions: null as unknown,
  fcmMessages: [] as { title: string; body: string }[],
  /** Every slug getConditions was actually called with, in order — the
   *  call-count assertion these tests are built around. */
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
    // `generatedAt` stamped fresh at CALL time, reading the test's own
    // faked clock — predictNextSunEvent scores off the snapshot's own
    // generatedAt (round-2 item 4), not the route's wall clock.
    return { ...c, snapshot: { ...c.snapshot, generatedAt: new Date().toISOString() } };
  },
}));

// The ESTIMATE (sunColorSlugNeed's pure computeSunTimes-based read) always
// says: sunrise already passed, sunset at SUNSET_ISO — fixed, regardless of
// which calendar day/args it's asked about. Each test's own conditions()
// snapshot is what disagrees with this, on purpose.
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

const DEV = "44444444-5555-6666-8777-888888888888";
const FCM_TOKEN = "m".repeat(80);

/** The real conditions snapshot the SNAPSHOT-based decision reads —
 *  independent of the ESTIMATE above. `snapshotSunriseIso`/
 *  `snapshotSunsetIso` are both today's readings; `tomorrowSunriseIso` is
 *  used once both of today's have passed (scenario (a)'s kind mismatch). A
 *  vivid-scoring (Great, ~73) cloud mix sits at whichever instant
 *  `hourlyTimeIso` names, so a genuine send is possible when the two
 *  windows do align. */
function conditions(opts: {
  snapshotSunriseIso: string;
  snapshotSunsetIso: string;
  tomorrowSunriseIso?: string;
  hourlyTimeIso: string;
}): ConditionsResponse {
  return {
    score: { score: 40, rawScore: 40, rating: "Fair", caps: [], subScores: [] },
    snapshot: {
      lightning: { status: "ok", data: null },
      nws: { status: "ok", data: { alerts: [] } },
      cityOfficial: { status: "ok", data: null },
      waterQuality: { status: "ok", data: null },
      sun: {
        status: "ok",
        data: {
          sunrise: opts.snapshotSunriseIso,
          sunset: opts.snapshotSunsetIso,
          ...(opts.tomorrowSunriseIso ? { tomorrowSunrise: opts.tomorrowSunriseIso } : {}),
        },
      },
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
    // Only sun-color drives selection — morning/score-excellent off so a
    // conditions fetch can only ever be this alert's own doing.
    prefs: { "sun-color": true, morning: false, "score-excellent": false },
  });
}

describe("POST /api/push/run — sun-color ESTIMATE-vs-SNAPSHOT disagreement (round-3 item 1)", () => {
  const ESTIMATE_WINDOW_START = Date.parse(SUNSET_ISO) - 60 * 60_000; // the estimate's own window start (60-min lead)

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

  it("(a) kind mismatch: the estimate says sunset, the real snapshot says sunrise — pass 1 fetches and latches, pass 2 does NOT fetch", async () => {
    vi.setSystemTime(new Date(ESTIMATE_WINDOW_START));
    await seedDevice();
    // Today's sunrise AND sunset both already passed relative to
    // `generatedAt` (stamped at ESTIMATE_WINDOW_START) — so the real
    // snapshot's own `nextSunEvent` falls through to TOMORROW's sunrise,
    // a different KIND than the estimate's "sunset".
    ctl.conditions = conditions({
      snapshotSunriseIso: SUNRISE_ISO, // long past
      snapshotSunsetIso: "2026-09-02T20:00:00Z", // also past relative to 22:00Z
      tomorrowSunriseIso: "2026-09-03T10:00:00Z",
      hourlyTimeIso: "2026-09-03T10:00:00Z",
    });

    const body1 = (await (await run()).json()) as Record<string, unknown>;
    expect(body1.sunColor).toBe(0); // nothing to send for a mismatched kind
    expect(ctl.conditionsCalls).toEqual(["boca-raton"]); // pass 1 fetched

    const store = await getStore();
    expect(await store.lastAlert(DEV, "sun-color:sunset:2026-09-02")).toBeNull(); // never sent — no alert_log entry
    // But the ESTIMATE's own identity is latched — the mismatch is settled.
    const device = await store.getDevice(DEV);
    expect(device).not.toBeNull();

    const body2 = (await (await run()).json()) as Record<string, unknown>;
    expect(body2.sunColor).toBe(0);
    // The whole point: pass 2 must not re-select (and re-fetch) this beach
    // for an event it already settled as unreachable.
    expect(ctl.conditionsCalls).toEqual(["boca-raton"]); // still just the one call
  });

  it("(b) same kind, real window opens 8 minutes later: pass 1 defers (no latch, no send), a pass at +8 min fetches and sends exactly once", async () => {
    vi.setSystemTime(new Date(ESTIMATE_WINDOW_START));
    await seedDevice();
    const realSunset = new Date(Date.parse(SUNSET_ISO) + 8 * 60_000).toISOString(); // 8 min later than the estimate
    ctl.conditions = conditions({
      snapshotSunriseIso: SUNRISE_ISO,
      snapshotSunsetIso: realSunset,
      hourlyTimeIso: realSunset,
    });

    const body1 = (await (await run()).json()) as Record<string, unknown>;
    expect(body1.sunColor).toBe(0); // deferred — the real window isn't open yet
    expect(ctl.conditionsCalls).toEqual(["boca-raton"]); // pass 1 still fetched once

    const store = await getStore();
    expect(await store.lastAlert(DEV, "sun-color:sunset:2026-09-02")).toBeNull(); // not sent, not latched

    // A pass 8 minutes later — the real window has now opened.
    vi.setSystemTime(new Date(ESTIMATE_WINDOW_START + 8 * 60_000));
    const body2 = (await (await run()).json()) as Record<string, unknown>;
    expect(body2.sunColor).toBe(1);
    expect(ctl.fcmMessages).toHaveLength(1);
    expect(ctl.fcmMessages[0].title).toBe("Great sunset coming");
    expect(ctl.conditionsCalls).toEqual(["boca-raton", "boca-raton"]); // fetched again this pass

    // And exactly once — a third pass right after must not send again.
    vi.setSystemTime(new Date(ESTIMATE_WINDOW_START + 9 * 60_000));
    const body3 = (await (await run()).json()) as Record<string, unknown>;
    expect(body3.sunColor).toBe(0);
    expect(ctl.fcmMessages).toHaveLength(1);
  });

  it("(c) same kind, real event 40 minutes later (beyond the defer tolerance): latch immediately, no fetch on pass 2", async () => {
    vi.setSystemTime(new Date(ESTIMATE_WINDOW_START));
    await seedDevice();
    const realSunset = new Date(Date.parse(SUNSET_ISO) + 40 * 60_000).toISOString(); // 40 min later
    ctl.conditions = conditions({
      snapshotSunriseIso: SUNRISE_ISO,
      snapshotSunsetIso: realSunset,
      hourlyTimeIso: realSunset,
    });

    const body1 = (await (await run()).json()) as Record<string, unknown>;
    expect(body1.sunColor).toBe(0);
    expect(ctl.conditionsCalls).toEqual(["boca-raton"]);

    const store = await getStore();
    expect(await store.lastAlert(DEV, "sun-color:sunset:2026-09-02")).toBeNull(); // never sent

    const body2 = (await (await run()).json()) as Record<string, unknown>;
    expect(body2.sunColor).toBe(0);
    // Latched (too far to defer for) — pass 2 never re-fetches.
    expect(ctl.conditionsCalls).toEqual(["boca-raton"]);
  });
});
