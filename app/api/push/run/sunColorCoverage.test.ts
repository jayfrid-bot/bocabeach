// Coverage test for the sun-color alert (Codex review item 2), mirroring
// app/api/push/run/coverage.test.ts's own worst-case simulation: 8
// synthetic America/New_York beaches, ALL with a sun-color subscriber whose
// event is already inside its own send window at the same instant (the
// worst case for the round-robin cap), run through PUSH_RUN_MAX_BEACHES'
// default cap of 2 at 3 passes per 5-minute tick (workers/plus-cron/src/
// index.ts's real cadence) across the +0/+5/+10 ticks the 15-minute window
// spans. Before the fix (item 2), a beach stayed `due` for the WHOLE window
// even once its device had nothing further to send, crowding out the
// OTHER 7 beaches' round-robin slots — this proves every beach is served
// exactly once, and nothing fires once the event itself has passed.

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

    // The window is [start, start+15min) — three 5-minute ticks (+0, +5,
    // +10) all land inside it; a 4th (+15) would not.
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
