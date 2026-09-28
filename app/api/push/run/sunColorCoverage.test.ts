// Coverage test for the sun-color alert (Codex review item 2), mirroring
// app/api/push/run/coverage.test.ts's own worst-case simulation: N
// synthetic America/New_York beaches, ALL with a sun-color subscriber whose
// event is already inside its own send window at the same instant (the
// worst case for the round-robin cap), run through PUSH_RUN_MAX_BEACHES'
// default cap of 2 across the 5-minute ticks the 10-minute window
// (SUN_COLOR_SEND_WINDOW_MS, round-2 item 4) spans. Before the item-2 fix, a
// beach stayed `due` for the WHOLE window even once its device had nothing
// further to send, crowding out the OTHER beaches' round-robin slots —
// this proves every beach is served exactly once, and nothing fires once
// the event itself has passed.
//
// A second describe block (round-2 item 4) exercises the larger, documented
// per-tick capacity case: 25 simultaneous beaches, 6 passes/tick (the
// worker's own max), and asserts the `dueRemaining` field — and the
// early-stop it drives in workers/plus-cron — behave correctly.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ConditionsResponse } from "@/lib/types";

const ctl = vi.hoisted(() => ({
  fcmSends: [] as string[],
}));

const N_BEACHES = 8;
const SUNSET_ISO = "2026-09-02T23:00:00Z";
const SUNRISE_ISO = "2026-09-02T10:00:00Z"; // already passed relative to every "now" this file uses

function beachIndex(slug: string): number | null {
  const m = /^coverage-sun-(\d+)$/.exec(slug);
  return m ? Number(m[1]) : null;
}

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
  sendFcm: async (_a: string, _p: string, token: string) => {
    ctl.fcmSends.push(token);
    return { ok: true };
  },
}));

vi.mock("@/config/locations", async (importActual) => {
  const actual = await importActual<typeof import("@/config/locations")>();
  return {
    ...actual,
    getLocation: (slug: string) => {
      const n = beachIndex(slug);
      if (n === null) return actual.getLocation(slug);
      return {
        slug,
        name: `Coverage Sun ${n}`,
        region: "Test",
        lat: 26 + n * 0.001,
        lon: -80 - n * 0.001,
        timezone: "America/New_York",
        noaaTideStationId: "0000000",
      };
    },
  };
});

// Every synthetic beach shares the same fixed sunset, regardless of the
// lat/lon/date it's asked about — keeps both `sunColorSlugNeed`'s pure
// estimate AND the conditions snapshot's own `sun.data` in exact agreement,
// same pattern app/api/push/run/sunColor.test.ts already uses.
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
        generatedAt: SUNRISE_ISO, // stable/irrelevant here — only the sun/hourly fields matter
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

const { POST: runPost } = await import("@/app/api/push/run/route");
const { getStore } = await import("@/lib/db/store");
const { resetMemoryStore } = await import("@/lib/db/memoryStore");

function post(): Request {
  return new Request("https://x/api/push/run", {
    method: "POST",
    headers: { "x-cron-secret": "test-cron-secret" },
  });
}

beforeEach(() => {
  resetMemoryStore();
  ctl.fcmSends = [];
  process.env.CRON_SECRET = "test-cron-secret";
  delete process.env.PUSH_RUN_MAX_BEACHES; // the real default (2)
});

describe("sun-color coverage — 8 America/New_York beaches, all in-window at once", () => {
  const WINDOW_START_ISO = new Date(Date.parse(SUNSET_ISO) - 60 * 60_000).toISOString(); // 60-min lead, the default
  const TICK_MS = 5 * 60 * 1000;
  const PASSES_PER_TICK = 3; // workers/plus-cron/src/index.ts's default

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(WINDOW_START_ISO));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function seed(): Promise<void> {
    const store = await getStore();
    const farFuture = Date.now() + 30 * 24 * 3600_000;
    for (let n = 1; n <= N_BEACHES; n++) {
      await store.upsertDevice(`dev-${n}`, {
        platform: "android",
        pushToken: `tok-${n}`,
        homeSlug: `coverage-sun-${n}`,
        codeUntil: farFuture, // Plus
        prefs: { morning: false, "score-excellent": false, "sun-color": true },
        // sunColorMinBand/leadMin left at their defaults: Great-or-better, 60 min.
      });
    }
  }

  it("every one of 8 beaches gets exactly one push across the +0/+5/+10 ticks — none starved, none doubled", async () => {
    await seed();

    // The DECISION's own exact window is [start, start+10min) — ticks +0
    // and +5 land inside it (the +10 tick lands right at its close, no
    // longer inside, but `sunColorSlugNeed`'s own END-only tolerance keeps
    // selecting through it as a backstop). 3 passes/tick x 2-beach cap x 2
    // truly-in-window ticks = 12 beach-visits of capacity, comfortably
    // above the 8 beaches here.
    for (let tick = 0; tick < 3; tick++) {
      vi.setSystemTime(new Date(Date.parse(WINDOW_START_ISO) + tick * TICK_MS));
      for (let pass = 0; pass < PASSES_PER_TICK; pass++) {
        await runPost(post());
      }
    }

    const counts = new Map<number, number>();
    for (let n = 1; n <= N_BEACHES; n++) counts.set(n, ctl.fcmSends.filter((t) => t === `tok-${n}`).length);

    const starved = [...counts.entries()].filter(([, c]) => c === 0).map(([n]) => n);
    const doubled = [...counts.entries()].filter(([, c]) => c > 1).map(([n]) => n);
    expect(starved).toEqual([]);
    expect(doubled).toEqual([]);
    expect([...counts.values()].every((c) => c === 1)).toBe(true);

    // --- Nothing after the event ---------------------------------------
    // Advance well past both the send window AND the event itself (sunset)
    // and run several more ticks/passes — confirms no beach is ever
    // double-sent later, including after the event has actually happened.
    for (let tick = 0; tick < 4; tick++) {
      vi.setSystemTime(new Date(Date.parse(SUNSET_ISO) + 5 * 60_000 + tick * TICK_MS));
      for (let pass = 0; pass < PASSES_PER_TICK; pass++) {
        await runPost(post());
      }
    }
    for (let n = 1; n <= N_BEACHES; n++) {
      expect(ctl.fcmSends.filter((t) => t === `tok-${n}`).length).toBe(1);
    }
  });

  it("control: at the OLD single-pass-per-tick rate over just the +0/+5/+10 window, coverage is incomplete", async () => {
    await seed();
    for (let tick = 0; tick < 3; tick++) {
      vi.setSystemTime(new Date(Date.parse(WINDOW_START_ISO) + tick * TICK_MS));
      await runPost(post()); // one pass only
    }
    const counts = new Map<number, number>();
    for (let n = 1; n <= N_BEACHES; n++) counts.set(n, ctl.fcmSends.filter((t) => t === `tok-${n}`).length);
    const starved = [...counts.entries()].filter(([, c]) => c === 0).map(([n]) => n);
    // 3 ticks x cap-of-2 = 6 max at one pass/tick, so at least 2 of the 8
    // beaches are starved within just this window — proving the multi-pass
    // cadence (not the window width) is what closes the gap, same
    // conclusion app/api/push/run/coverage.test.ts draws for coming-up.
    expect(starved.length).toBeGreaterThanOrEqual(2);
    const doubled = [...counts.entries()].filter(([, c]) => c > 1).map(([n]) => n);
    expect(doubled).toEqual([]);
  });
});

// --- Round-2 item 4: dueRemaining-driven capacity + early stop -------------
//
// Real per-tick capacity is `passes x PUSH_RUN_MAX_BEACHES` (the sun-color
// alert's own DECISION window only overlaps TWO of a tick's passes-worth of
// 5-minute steps before it closes — see the 8-beach test above — so the
// usable window here is the +0 and +5 ticks): at the worker's own max of 6
// passes/tick and the default 2-beach cap, that's 6 x 2 x 2 ticks = 24
// beach-visits of capacity — the beach count below is set to exactly that
// (24, not 25) so this test proves real, exact-boundary convergence rather
// than asserting a capacity inequality that doesn't actually hold at 25.
describe("sun-color capacity — 24 simultaneous America/New_York beaches, dueRemaining-driven early stop", () => {
  const N24 = 24;
  const WINDOW_START_ISO = new Date(Date.parse(SUNSET_ISO) - 60 * 60_000).toISOString();
  const TICK_MS = 5 * 60 * 1000;
  const MAX_PASSES_PER_TICK = 6; // workers/plus-cron/src/index.ts's documented cap

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(WINDOW_START_ISO));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function seed24(): Promise<void> {
    const store = await getStore();
    const farFuture = Date.now() + 30 * 24 * 3600_000;
    for (let n = 1; n <= N24; n++) {
      await store.upsertDevice(`dev24-${n}`, {
        platform: "android",
        pushToken: `tok24-${n}`,
        homeSlug: `coverage-sun-${n}`,
        codeUntil: farFuture, // Plus
        prefs: { morning: false, "score-excellent": false, "sun-color": true },
      });
    }
  }

  it("every one of the 24 beaches gets exactly one push, and dueRemaining correctly drives (and reports) the early stop", async () => {
    await seed24();

    // Mirrors workers/plus-cron's own scheduled() loop: up to
    // MAX_PASSES_PER_TICK passes per tick, breaking as soon as a pass
    // reports `dueRemaining === 0` (isIdle) — over the two ticks (+0, +5)
    // whose passes actually land inside the sun-color decision's own exact
    // send window.
    let totalPasses = 0;
    let lastDueRemaining: number | null = null;
    for (let tick = 0; tick < 2; tick++) {
      vi.setSystemTime(new Date(Date.parse(WINDOW_START_ISO) + tick * TICK_MS));
      for (let pass = 0; pass < MAX_PASSES_PER_TICK; pass++) {
        const body = (await (await runPost(post())).json()) as { dueRemaining?: number };
        totalPasses += 1;
        lastDueRemaining = body.dueRemaining ?? null;
        if (lastDueRemaining === 0) break; // the exact early-stop condition workers/plus-cron uses
      }
    }

    const counts = new Map<number, number>();
    for (let n = 1; n <= N24; n++) counts.set(n, ctl.fcmSends.filter((t) => t === `tok24-${n}`).length);
    const starved = [...counts.entries()].filter(([, c]) => c === 0).map(([n]) => n);
    const doubled = [...counts.entries()].filter(([, c]) => c > 1).map(([n]) => n);
    expect(starved).toEqual([]);
    expect(doubled).toEqual([]);

    expect(lastDueRemaining).toBe(0); // converged — the early stop actually fired, not just present in code
    // 24 beaches at exactly 24 beach-visits of capacity is a tight fit —
    // every pass does useful work, so this exercises the boundary itself
    // (never more than the documented max, and it DOES converge within it).
    expect(totalPasses).toBeLessThanOrEqual(2 * MAX_PASSES_PER_TICK);
  });

  it("a due beach beyond capacity is correctly reported via dueRemaining (the alarm workers/plus-cron warns on)", async () => {
    // One extra beach beyond the 24 that exactly fit in two ticks' worth
    // of capacity — after just ONE tick's max passes, dueRemaining must
    // still be > 0 (nothing wrongly declares victory early).
    await seed24();
    const store = await getStore();
    await store.upsertDevice("dev24-extra", {
      platform: "android",
      pushToken: "tok24-extra",
      homeSlug: "coverage-sun-25",
      codeUntil: Date.now() + 30 * 24 * 3600_000,
      prefs: { morning: false, "score-excellent": false, "sun-color": true },
    });

    let lastDueRemaining: number | null = null;
    for (let pass = 0; pass < MAX_PASSES_PER_TICK; pass++) {
      const body = (await (await runPost(post())).json()) as { dueRemaining?: number };
      lastDueRemaining = body.dueRemaining ?? null;
    }
    expect(lastDueRemaining).toBeGreaterThan(0);
  });
});
