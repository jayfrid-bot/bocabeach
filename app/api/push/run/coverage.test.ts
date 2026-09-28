// Worst-case 8:00 AM coverage (Codex round-2 HIGH): with PUSH_RUN_MAX_BEACHES
// at its default of 2 and a single pass per 5-minute cron tick, one
// timezone's 8:00 AM hour (12 ticks) can only round-robin through ~13
// distinct beaches — 14+ subscribed beaches in the same timezone means some
// silently miss their morning digest AND their coming-up alert that day.
// This test simulates the worst case directly against the real route
// handler (39 synthetic beaches, all America/New_York, a mix of
// morning-digest and coming-up-only devices) across the SAME 12 ticks ×
// PASSES_PER_TICK passes workers/plus-cron/src/index.ts now makes, and
// asserts every beach's device is served EXACTLY once — never zero
// (starved) and never twice (double-sent).
//
// Isolated from app/api/push/pushRoutes.test.ts's own mocks/state so a
// 39-device simulation can't leak into (or be confused by) that file's many
// smaller scenarios. `getLocation` is mocked because this app's real config
// doesn't have 39 curated+generated beaches all in one timezone; everything
// else (the store, the route handler, `slugConditionsNeed`, the round-robin,
// the coming-up selection/claim machinery) is the real thing.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ConditionsResponse } from "@/lib/types";

const ctl = vi.hoisted(() => ({
  sendCounts: new Map<string, number>() as Map<string, number>,
}));

const N_BEACHES = 39;
/** Beaches past this rank (1-based) are coming-up-only (morning off); the
 *  rest are ordinary morning-digest subscribers — a deliberate mix, since it
 *  was exactly a growing pool of always-"due" coming-up-only beaches
 *  crowding out OTHER beaches' morning digests that caused this bug. */
const COMING_UP_ONLY_FROM = Math.floor((N_BEACHES * 2) / 3);

function beachIndex(slug: string): number | null {
  const m = /^coverage-ny-(\d+)$/.exec(slug);
  return m ? Number(m[1]) : null;
}

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
  sendFcm: async (_a: string, _p: string, token: string) => {
    ctl.sendCounts.set(token, (ctl.sendCounts.get(token) ?? 0) + 1);
    return { ok: true };
  },
}));

// `getLocation` needs to resolve 39 synthetic slugs, all America/New_York —
// this app's own real config doesn't have that many beaches in one
// timezone. Every field route.ts's home-digest loop actually reads
// (`loc.name`, `loc.timezone`, plus what `lib/alerts/comingUp.ts`'s window
// math and `personalSummary`/`isDaylightAt` touch) is filled in; nothing
// else matters for this test.
vi.mock("@/config/locations", async (importActual) => {
  const actual = await importActual<typeof import("@/config/locations")>();
  return {
    ...actual,
    getLocation: (slug: string) => {
      const n = beachIndex(slug);
      if (n === null) return actual.getLocation(slug);
      return {
        slug,
        name: `Coverage NY ${n}`,
        region: "Test",
        lat: 26 + n * 0.001,
        lon: -80 - n * 0.001,
        timezone: "America/New_York",
        noaaTideStationId: "0000000",
      };
    },
  };
});

/** A minimal, always-mockable conditions build: score kept below the
 *  Excellent threshold (score-excellent prefs are also off below, belt and
 *  suspenders) and, for the coming-up-only devices, a single alert-eligible
 *  launch whose `net`/feed freshness are computed relative to the CURRENT
 *  (faked) clock at call time — not a fixed instant — so it stays eligible
 *  across the whole simulated hour regardless of which tick a beach happens
 *  to get visited on. */
vi.mock("@/lib/conditions", () => ({
  getConditions: async (slug: string) => {
    const n = beachIndex(slug);
    const nowMs = Date.now();
    const comingUpOnly = n !== null && n > COMING_UP_ONLY_FROM;
    return {
      score: { score: 55, rawScore: 55, rating: "Fair", caps: [], subScores: [] },
      snapshot: {
        lightning: { status: "ok", data: null },
        nws: { status: "ok", data: { alerts: [] } },
        cityOfficial: { status: "ok", data: null },
        waterQuality: { status: "ok", data: null },
        ...(comingUpOnly
          ? {
              skyAlertCandidates: [
                {
                  eventType: "launch",
                  ll2Id: `uuid-${slug}`,
                  name: `Launch ${slug}`,
                  net: new Date(nowMs + 6 * 3600_000).toISOString(),
                  netPrecision: "Minute",
                  windowStart: new Date(nowMs + 6 * 3600_000).toISOString(),
                  windowEnd: new Date(nowMs + 6 * 3600_000 + 30 * 60_000).toISOString(),
                  status: "Go",
                  padId: 1,
                  padLocationId: 1,
                  observerLightState: "night",
                  padLightState: "night",
                  rangeTier: "near",
                  knownOrbital: true,
                  whereToLook: { bearingDeg: 0, line: "due north" },
                  rating: null,
                  source: {
                    feedGeneratedAt: new Date(nowMs - 5 * 60_000).toISOString(),
                    validThrough: new Date(nowMs + 24 * 3600_000).toISOString(),
                  },
                },
              ],
            }
          : {}),
      },
      hourlyForecast: [],
      hourlyScores: [],
    } as unknown as ConditionsResponse;
  },
}));

const { POST: runPost } = await import("@/app/api/push/run/route");
const { getStore } = await import("@/lib/db/store");
const { resetMemoryStore } = await import("@/lib/db/memoryStore");

function post(query: string): Request {
  return new Request(`https://x/api/push/run${query}`, {
    method: "POST",
    headers: { "x-cron-secret": "test-cron-secret" },
  });
}

beforeEach(() => {
  resetMemoryStore();
  ctl.sendCounts.clear();
  process.env.CRON_SECRET = "test-cron-secret";
});

describe("worst-case 8 AM coverage — 39 America/New_York beaches", () => {
  const BASE_ISO = "2026-09-02T12:00:00Z"; // 08:00 America/New_York
  const TICK_MS = 5 * 60 * 1000;
  const TICKS = 12; // the whole 8:00-8:55 hour, one per 5-minute cron fire

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BASE_ISO));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Seeds the 39 synthetic beaches' devices, then simulates the whole 8 AM
   *  hour at `passesPerTick` passes per 5-minute tick, and returns each
   *  beach's total successful-send count (1-indexed). */
  async function simulateHour(passesPerTick: number): Promise<Map<number, number>> {
    const store = await getStore();
    const farFuture = Date.now() + 30 * 24 * 3600_000;
    for (let n = 1; n <= N_BEACHES; n++) {
      const slug = `coverage-ny-${n}`;
      const comingUpOnly = n > COMING_UP_ONLY_FROM;
      await store.upsertDevice(`dev-${n}`, {
        platform: "android",
        pushToken: `tok-${n}`,
        homeSlug: slug,
        codeUntil: farFuture, // Plus, for the whole simulated hour
        prefs: comingUpOnly
          ? { morning: false, "score-excellent": false, "coming-up": true }
          : { morning: true, "score-excellent": false },
      });
    }

    for (let tick = 0; tick < TICKS; tick++) {
      vi.setSystemTime(new Date(Date.parse(BASE_ISO) + tick * TICK_MS));
      for (let pass = 0; pass < passesPerTick; pass++) {
        // mode=morning: this test is about home-beach coverage specifically
        // (the at-beach engine has no armed devices here anyway, and mode=
        // morning is the same "everything but at-beach" scope the real
        // route already supports).
        await runPost(post("?mode=morning"));
      }
    }

    const counts = new Map<number, number>();
    for (let n = 1; n <= N_BEACHES; n++) counts.set(n, ctl.sendCounts.get(`tok-${n}`) ?? 0);
    return counts;
  }

  it("serves every one of 39 beaches' devices exactly once — no beach starved, none double-sent", async () => {
    const counts = await simulateHour(3); // workers/plus-cron/src/index.ts's default

    const starved = [...counts.entries()].filter(([, c]) => c === 0).map(([n]) => n);
    const doubled = [...counts.entries()].filter(([, c]) => c > 1).map(([n]) => n);
    expect(starved).toEqual([]);
    expect(doubled).toEqual([]);
    expect([...counts.values()].every((c) => c === 1)).toBe(true);
  });

  it("control: at the OLD single-pass-per-tick rate, coverage is incomplete — proves the multi-pass change is what closes the gap", async () => {
    const counts = await simulateHour(1); // pre-fix behavior: one pass per 5-minute tick

    const starved = [...counts.entries()].filter(([, c]) => c === 0).map(([n]) => n);
    // Matches the bug report's own math (~13 distinct beaches reachable in
    // 12 ticks at a round-robin window of 2, out of 39 subscribed here) —
    // asserting a RANGE, not an exact count, since the precise number
    // depends on the round-robin's alphabetical ordering of which slugs
    // happen to still be due each tick; the point is that starvation is
    // real and substantial at the old rate, not the exact figure.
    expect(starved.length).toBeGreaterThanOrEqual(10);
    // No beach is ever double-sent either way, single-pass or multi-pass —
    // the round-robin/cap logic itself was never the source of a double
    // send, only of starvation.
    const doubled = [...counts.entries()].filter(([, c]) => c > 1).map(([n]) => n);
    expect(doubled).toEqual([]);
  });
});
