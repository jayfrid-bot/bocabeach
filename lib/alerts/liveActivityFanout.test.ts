// The Live Activity fan-out inside runAtBeachAlerts (docs/LIVE_ACTIVITY_PLAN.md
// Phase 3, "One evaluation pipeline"): one evaluation, two independent
// surfaces. No network — feed/conditions/rain and the Live Activity sender
// are all injected, same pattern as lib/alerts/run.test.ts.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMemoryStore } from "@/lib/db/memoryStore";
import type { DeviceStore } from "@/lib/db/store";
import type { LightningFeed } from "@/lib/sources/lightning";
import { runAtBeachAlerts, type AtBeachPush, type LiveActivitySendArgs } from "@/lib/alerts/run";
import { SubrequestBudget } from "@/lib/alerts/budget";
import type { ConditionsResponse } from "@/lib/types";

const NOW = Date.parse("2026-09-02T18:00:00Z");
const HOUR = 3600 * 1000;
const DEV = "11111111-2222-4333-8444-555555555555";
const TOKEN = "a".repeat(80);
const LA_TOKEN = "c".repeat(64);

const NO_STRIKE: LightningFeed = { generatedAt: "2026-09-02T17:58:00Z", windowMinutes: 20, strikes: [] };
/** ~3.4 mi north of Boca's beach — active, not escalated. */
const NEAR_STRIKE: LightningFeed = {
  generatedAt: "2026-09-02T17:58:00Z",
  windowMinutes: 20,
  strikes: [[Math.floor(NOW / 1000) - 120, 26.4087, -80.0686]],
};
/** ~0.7 mi — active AND inside the escalation radius. */
const CLOSE_STRIKE: LightningFeed = {
  generatedAt: "2026-09-02T17:58:00Z",
  windowMinutes: 20,
  strikes: [[Math.floor(NOW / 1000) - 60, 26.3687, -80.0686]],
};

const emptySource = { status: "error" as const, data: null };

/** A conditions response with everything BOTH evaluateAtBeach (lib/alerts/
 *  evaluate.ts) and contentStateFromConditions (lib/liveActivity/state.ts)
 *  read — a superset of lib/alerts/fixtures.ts's conditionsFixture and
 *  lib/liveActivity/state.test.ts's own res(). */
function conditions(over: Record<string, unknown> = {}): ConditionsResponse {
  return {
    score: { score: (over.score as number) ?? 80, rawScore: 80, rating: "Good", caps: [], subScores: [] },
    hourlyScores: [],
    hourlyForecast: [],
    multiDayWindows: [],
    cams: [],
    snapshot: {
      location: { slug: "boca-raton", name: "Boca Raton", timezone: "America/New_York" },
      generatedAt: new Date(NOW).toISOString(),
      lightning: { status: "ok", data: null },
      nws: { status: "ok", data: { alerts: [], ripCurrentRisk: "low" } },
      cityOfficial: { status: "ok", data: { flags: [], noSwimAdvisory: undefined } },
      waterQuality: { status: "ok", data: { advisory: false } },
      buoy: { status: "ok", data: { windGustMph: 10 } },
      hourly: { status: "ok", data: [] },
      weather: { status: "ok", data: { shortForecast: "Sunny", windSpeedMph: 8, windDirDeg: 90 } },
      marine: { status: "ok", data: over.marine ?? { waveHeightFt: 2.1 } },
      clarity: { status: "ok", data: { level: "clear" } },
      sargassum: { status: "ok", data: { level: "low" } },
      tides: {
        status: "ok",
        data: { next: [{ type: "low", time: "2026-09-02T20:14:00.000Z", heightFt: 0.2 }] },
      },
      sun: { status: "ok", data: { date: "2026-09-02", sunset: "2026-09-02T23:35:00.000Z" } },
      precipRadar: { status: "error", data: null },
      nowcast: emptySource,
      airQuality: emptySource,
      metno: emptySource,
      gfs: emptySource,
      goesCloud: emptySource,
      busyness: emptySource,
      traffic: emptySource,
      forecast: { status: "error", data: [] },
    },
  } as unknown as ConditionsResponse;
}

let store: DeviceStore;
let sent: AtBeachPush[];
let laSent: { token: string; args: LiveActivitySendArgs }[];
let laResult: { ok: boolean; dead: boolean };

interface Options {
  feed?: LightningFeed | null;
  now?: number;
  budget?: SubrequestBudget;
}

async function run(opts: Options = {}) {
  return runAtBeachAlerts({
    store,
    now: opts.now ?? NOW,
    // Codex round-4 #1: the real sender wrapper (app/api/push/run/route.ts's
    // `senderFor`) — not run.ts — is what spends the shared budget for an
    // ordinary alert send; run.ts only PEEKS before claiming. Mirror that
    // split here so these budget tests exercise the real contract, gating
    // only when a test actually passes a shared budget in.
    deliver: async (_sub, msg) => {
      if (opts.budget && !opts.budget.take(1)) return { ok: false, dead: false };
      sent.push(msg);
      return { ok: true, dead: false };
    },
    loadFeed: async () => (opts.feed === undefined ? NO_STRIKE : opts.feed),
    loadConditions: async () => conditions(),
    loadRain: async () => null,
    sendLiveActivity: async (token, args) => {
      laSent.push({ token, args });
      return laResult;
    },
    budget: opts.budget,
  });
}

async function seedDevice(
  over: { pushToken?: string | null; armedUntil?: number } = {},
): Promise<void> {
  await store.upsertDevice(DEV, {
    platform: "ios",
    pushToken: over.pushToken === undefined ? TOKEN : over.pushToken,
    tz: "America/New_York",
    homeSlug: "boca-raton",
    codeUntil: NOW + 30 * 24 * HOUR,
  });
  await store.setPresence(DEV, {
    slug: "boca-raton",
    lat: 26.3587,
    lon: -80.0686,
    accuracyM: 20,
    fixAt: NOW - 60_000,
    armedUntil: over.armedUntil ?? NOW + 4 * HOUR,
    source: "auto",
  });
}

async function registerLiveActivity(over: { activityId?: string; pushToken?: string } = {}) {
  return store.upsertLiveActivity({
    activityId: over.activityId ?? "activity-1",
    deviceId: DEV,
    beachSlug: "boca-raton",
    schemaVersion: 1,
    appBuild: "1",
    apnsEnvironment: "sandbox",
    pushToken: over.pushToken ?? LA_TOKEN,
    startedAt: NOW,
    expiresAt: NOW + 4 * HOUR,
  });
}

beforeEach(() => {
  store = createMemoryStore({ file: null });
  sent = [];
  laSent = [];
  laResult = { ok: true, dead: false };
  delete process.env.PUSH_SAFETY_ALERTS;
});

afterEach(() => {
  delete process.env.PUSH_SAFETY_ALERTS;
});

describe("runAtBeachAlerts — Live Activity fan-out", () => {
  it("a device with NO normal push token but an active Live Activity is still evaluated and gets an update", async () => {
    await seedDevice({ pushToken: null });
    await registerLiveActivity();
    const counts = await run();
    expect(counts.devices).toBe(1);
    expect(counts.skipped).toBe(0); // not skipped — the live activity surface exists
    expect(laSent).toHaveLength(1);
    expect(laSent[0].token).toBe(LA_TOKEN);
    expect(laSent[0].args.event).toBe("update");
    expect(laSent[0].args.contentState.score).toBe(80);
  });

  it("a never-sent activity sends on the first run (no prior state to diff against)", async () => {
    await seedDevice();
    await registerLiveActivity();
    await run();
    expect(laSent).toHaveLength(1);
    const row = (await store.listLiveActivitiesForDevice(DEV))[0];
    expect(row.lastStateHash).not.toBeNull();
    expect(row.lastSentAt).toBe(NOW);
  });

  it("an unchanged hash inside the debounce/heartbeat windows sends nothing on the very next run", async () => {
    await seedDevice();
    await registerLiveActivity();
    await run(); // first send
    laSent = [];
    const counts = await run({ now: NOW + 30_000 }); // 30s later, nothing changed
    expect(laSent).toHaveLength(0);
    expect(counts.errors).toBe(0);
  });

  it("lightning turning active sends immediately at priority 10", async () => {
    await seedDevice();
    await registerLiveActivity();
    await run({ feed: NO_STRIKE }); // establish a "no lightning" baseline
    laSent = [];
    const counts = await run({ feed: NEAR_STRIKE, now: NOW + 30_000 }); // inside the ordinary 60s debounce
    expect(counts.errors).toBe(0);
    expect(laSent).toHaveLength(1);
    expect(laSent[0].args.priority).toBe(10);
    expect(laSent[0].args.contentState.lightning?.active).toBe(true);
  });

  it("lightning escalating from active-far to active-close also jumps the debounce", async () => {
    await seedDevice();
    await registerLiveActivity();
    await run({ feed: NEAR_STRIKE });
    laSent = [];
    const counts = await run({ feed: CLOSE_STRIKE, now: NOW + 30_000 });
    expect(counts.errors).toBe(0);
    expect(laSent).toHaveLength(1);
    expect(laSent[0].args.priority).toBe(10);
  });

  it("a 15-minute freshness heartbeat fires even with nothing else to say", async () => {
    await seedDevice();
    await registerLiveActivity();
    await run({ feed: NO_STRIKE });
    laSent = [];
    const counts = await run({ feed: NO_STRIKE, now: NOW + 15 * 60_000 });
    expect(counts.errors).toBe(0);
    expect(laSent).toHaveLength(1);
    expect(laSent[0].args.priority).toBe(5);
  });

  it("a dead Live Activity token ends only that activity — never the device's normal push token", async () => {
    await seedDevice();
    await registerLiveActivity();
    laResult = { ok: false, dead: true };
    await run();
    const row = (await store.listLiveActivitiesForDevice(DEV))[0];
    expect(row.status).toBe("ended");
    // No 72h bearer-token retention on a confirmed permanent rejection
    // (Codex review #10).
    expect(row.pushToken).toBe("");
    // The device's own push token is untouched.
    expect(await store.getPushToken(DEV)).toBe(TOKEN);
  });

  it("a transient send failure leaves the activity active for the next run's retry (Codex review #10)", async () => {
    await seedDevice();
    await registerLiveActivity();
    laResult = { ok: false, dead: false }; // transient — neither delivered nor permanently rejected
    const counts = await run();
    expect(counts.errors).toBe(0); // the Live Activity path doesn't bump device-level errors
    const row = (await store.listLiveActivitiesForDevice(DEV))[0];
    expect(row.status).toBe("active");
    expect(row.pushToken).toBe(LA_TOKEN); // never cleared on a transient failure
  });

  // --- Expiry reconciliation (Codex review #3) --------------------------------
  it("a presence extension raises expires_at — the sweep must not end a still-armed activity", async () => {
    await seedDevice({ armedUntil: NOW + 30 * 60_000 }); // armed for 30 more minutes
    await registerLiveActivity(); // registered expiresAt = NOW + 4h in the fixture, but presence is shorter
    // Re-arm with a LATER window than what was on file at registration.
    await store.setPresence(DEV, {
      slug: "boca-raton",
      lat: 26.3587,
      lon: -80.0686,
      accuracyM: 20,
      fixAt: NOW - 60_000,
      armedUntil: NOW + 6 * HOUR,
      source: "auto",
    });
    const counts = await run({ now: NOW + 45 * 60_000 }); // after the ORIGINAL 30-min window
    expect(counts.devices).toBe(1); // still armed under the extended window
    const row = (await store.listLiveActivitiesForDevice(DEV))[0];
    expect(row.status).toBe("active");
    expect(row.expiresAt).toBe(NOW + 6 * HOUR); // raised to match the extended presence
  });

  it("a shrunk presence lowers expires_at and the row ends once it passes", async () => {
    await seedDevice({ armedUntil: NOW + 6 * HOUR });
    await registerLiveActivity(); // expiresAt = NOW + 4h from the fixture's own armedUntil at registration... actually set explicitly below
    // Shrink the presence window to something already in the past relative
    // to the next run.
    await store.setPresence(DEV, {
      slug: "boca-raton",
      lat: 26.3587,
      lon: -80.0686,
      accuracyM: 20,
      fixAt: NOW - 60_000,
      armedUntil: NOW + 10 * 60_000,
      source: "auto",
    });
    await run({ now: NOW + 20 * 60_000 }); // past the shrunk window
    const row = (await store.listLiveActivitiesForDevice(DEV))[0];
    expect(row.status).toBe("ended");
  });

  // --- Bounded fan-out (Codex review #2) --------------------------------------
  it("only LA_MAX_PER_RUN (10) activities get an update in one run; the rest roll to the next tick", async () => {
    const DEVICES = Array.from({ length: 11 }, (_, i) => `dev-${i}-2222-4333-8444-555555555555`);
    for (const id of DEVICES) {
      await store.upsertDevice(id, {
        platform: "ios",
        pushToken: null, // Live Activity surface only — no ordinary push noise in this test
        codeUntil: NOW + 30 * 24 * HOUR,
      });
      await store.setPresence(id, {
        slug: "boca-raton",
        lat: 26.3587,
        lon: -80.0686,
        accuracyM: 20,
        fixAt: NOW - 60_000,
        armedUntil: NOW + 4 * HOUR,
        source: "auto",
      });
      await store.upsertLiveActivity({
        activityId: `activity-${id}`,
        deviceId: id,
        beachSlug: "boca-raton",
        schemaVersion: 1,
        appBuild: "1",
        apnsEnvironment: "sandbox",
        pushToken: `${id.slice(0, 8)}`.padEnd(64, "a"),
        startedAt: NOW,
        expiresAt: NOW + 4 * HOUR,
      });
    }
    const counts = await run();
    expect(counts.devices).toBe(11);
    expect(laSent).toHaveLength(10); // bounded, never all 11 in one run

    laSent = [];
    const second = await run({ now: NOW + 30_000 }); // still inside the ordinary debounce for the first 10
    expect(second.errors).toBe(0);
    // The 11th (never considered last run) is now among the least-recently-
    // considered rows, so it gets its turn.
    expect(laSent.length).toBeGreaterThan(0);
  });

  it("due-end sweep: an activity whose presence window has expired gets an 'end' event and is marked ended", async () => {
    await seedDevice({ armedUntil: NOW - 1 }); // already expired
    await registerLiveActivity();
    const counts = await run();
    expect(counts.devices).toBe(0); // listArmed no longer returns this device
    expect(laSent).toHaveLength(1);
    expect(laSent[0].args.event).toBe("end");
    const row = (await store.listLiveActivitiesForDevice(DEV))[0];
    expect(row.status).toBe("ended");
  });

  it("purges long-ended rows (> 72h) opportunistically", async () => {
    await seedDevice();
    await registerLiveActivity();
    await store.markLiveActivityEnded("activity-1", "user", NOW);
    await run({ now: NOW + 73 * HOUR });
    expect(await store.listLiveActivitiesForDevice(DEV)).toEqual([]);
  });

  it("does nothing at all when the kill switch is off, including the Live Activity surface", async () => {
    await seedDevice();
    await registerLiveActivity();
    process.env.PUSH_SAFETY_ALERTS = "off";
    await run();
    expect(laSent).toEqual([]);
    expect(sent).toEqual([]);
  });

  describe("subrequest budget (Codex round-3 #4 — real per-fetch counting, stage reserves)", () => {
    // This file injects `loadFeed`/`loadConditions` as plain fakes (see the
    // header doc) — neither goes through lib/util.ts's fetchWithTimeout, so
    // neither spends anything from a real budget here (unlike production,
    // where every real fetch inside them counts automatically). What DOES
    // spend in these tests: the `deliver` mock above (mirroring the real
    // sender wrapper, round-4 #1) spends one unit per ordinary alert send,
    // and run.ts itself still spends one unit per Live Activity send.

    it("a budget of 0 skips the lightning feed AND the whole at-beach stage (including Live Activity) and never throws", async () => {
      await seedDevice({ pushToken: null });
      await registerLiveActivity();
      const budget = new SubrequestBudget(0);
      const counts = await run({ budget });
      expect(laSent).toEqual([]);
      expect(counts.deferred).toBeGreaterThan(0);
    });

    it("a budget of exactly 1: the ordinary alert send claims the only unit, so the Live Activity update sits out this run", async () => {
      await seedDevice();
      await registerLiveActivity();
      const budget = new SubrequestBudget(1);
      const counts = await run({ feed: CLOSE_STRIKE, budget });
      expect(sent.length).toBeGreaterThan(0); // the ordinary hazard send still won its unit
      expect(laSent).toEqual([]); // nothing left for the Live Activity update
      expect(counts.deferred).toBeGreaterThan(0);
    });

    it("a budget with enough units for both sends lets each surface send once", async () => {
      await seedDevice();
      await registerLiveActivity();
      const budget = new SubrequestBudget(2);
      await run({ feed: CLOSE_STRIKE, budget });
      expect(sent.length).toBeGreaterThan(0);
      expect(laSent).toHaveLength(1);
    });

    it("with no budget passed at all, behaves exactly as before (effectively unlimited)", async () => {
      await seedDevice({ pushToken: null });
      await registerLiveActivity();
      await run();
      expect(laSent).toHaveLength(1);
    });
  });

  describe("safety first (Codex HIGH): ordinary hazard alerts across ALL devices beat Live Activity work", () => {
    const DEV_A = "aaaaaaaa-2222-4333-8444-555555555555";
    const DEV_B = "bbbbbbbb-2222-4333-8444-555555555555";
    const TOKEN_A = "d".repeat(80);
    const TOKEN_B = "e".repeat(80);
    const LA_TOKEN_A = "f".repeat(64);

    // Deerfield's centroid is ~5 mi from Boca's (lib/alerts/run.test.ts) —
    // far enough from NEAR_STRIKE (~3.4 mi north of Boca) that A never sees
    // an active lightning hazard, while B, sitting at Boca itself, does.
    const DEERFIELD = { lat: 26.3184, lon: -80.0748 };

    async function seedTwo() {
      // Device A: an active Live Activity due for its update, but nothing
      // that fires an ordinary alert (no strike within 5 mi of A's fix,
      // calm conditions otherwise).
      await store.upsertDevice(DEV_A, {
        platform: "ios",
        pushToken: TOKEN_A,
        tz: "America/New_York",
        homeSlug: "deerfield-beach",
        codeUntil: NOW + 30 * 24 * HOUR,
      });
      await store.setPresence(DEV_A, {
        slug: "deerfield-beach",
        lat: DEERFIELD.lat,
        lon: DEERFIELD.lon,
        accuracyM: 20,
        fixAt: NOW - 60_000,
        armedUntil: NOW + 4 * HOUR,
        source: "auto",
      });
      // Never sent before — decideLiveActivitySend has nothing to diff
      // against, so it is due for an update purely by being new (same as
      // "a never-sent activity sends on the first run" above), regardless
      // of A's own (calm) conditions.
      await store.upsertLiveActivity({
        activityId: "activity-a",
        deviceId: DEV_A,
        beachSlug: "deerfield-beach",
        schemaVersion: 1,
        appBuild: "1",
        apnsEnvironment: "sandbox",
        pushToken: LA_TOKEN_A,
        startedAt: NOW,
        expiresAt: NOW + 4 * HOUR,
      });

      // Device B: no Live Activity at all — just a fresh, new lightning
      // strike at ITS fix that B has never been alerted about before.
      await store.upsertDevice(DEV_B, {
        platform: "android",
        pushToken: TOKEN_B,
        tz: "America/New_York",
        homeSlug: "boca-raton",
        codeUntil: NOW + 30 * 24 * HOUR,
      });
      await store.setPresence(DEV_B, {
        slug: "boca-raton",
        lat: 26.3587,
        lon: -80.0686,
        accuracyM: 20,
        fixAt: NOW - 60_000,
        armedUntil: NOW + 4 * HOUR,
        source: "auto",
      });
    }

    it("a budget that fits only one send total: B's new lightning alert is sent, A's Live Activity update is deferred — never the reverse", async () => {
      await seedTwo();
      const budget = new SubrequestBudget(1);
      const counts = await runAtBeachAlerts({
        store,
        now: NOW,
        budget,
        deliver: async (_sub, msg) => {
          if (!budget.take(1)) return { ok: false, dead: false };
          sent.push(msg);
          return { ok: true, dead: false };
        },
        loadFeed: async () => NEAR_STRIKE, // active at B's fix (Boca), too far from A's (Deerfield)
        loadConditions: async () => conditions(),
        loadRain: async () => null,
        sendLiveActivity: async (token, args) => {
          laSent.push({ token, args });
          return laResult;
        },
      });
      // B's ordinary hazard alert won the only unit of budget...
      expect(sent).toHaveLength(1);
      // ...even though A (the "LA due" device) was walked first — Live
      // Activity work only gets a turn AFTER every device's ordinary alerts.
      expect(laSent).toEqual([]);
      expect(counts.sent).toBe(1);
      expect(counts.deferred).toBeGreaterThan(0);
    });
  });

  describe("Codex LOW: budget.take() moves to right before the APNs call, after the claim wins", () => {
    it("a lost send-claim on the Live Activity end sweep spends no budget", async () => {
      // Already expired — every active row for this device is due to end.
      await seedDevice({ armedUntil: NOW - 1 });
      await registerLiveActivity();
      // Plenty of budget for two ends if the loser were (wrongly) charged
      // too — the old order took 1 unit BEFORE the claim, so a run that
      // lost the claim still spent a unit on a send it never made.
      const budget = new SubrequestBudget(5);
      const [a, b] = await Promise.all([
        run({ budget }),
        run({ budget }),
      ]);
      // Exactly one run actually ended the row and sent the APNs "end".
      expect(laSent).toHaveLength(1);
      expect(a.deferred + b.deferred).toBe(0);
      // Only the WINNER's send spent from the shared budget — the loser's
      // claimSend() returned false and never reached budget.take() at all.
      expect(budget.left).toBe(4);
    });

    it("a lost send-claim on a Live Activity update spends no budget", async () => {
      await seedDevice();
      await registerLiveActivity();
      const budget = new SubrequestBudget(5);
      const [a, b] = await Promise.all([
        run({ budget }),
        run({ budget }),
      ]);
      expect(laSent).toHaveLength(1); // one update actually sent
      expect(a.deferred + b.deferred).toBe(0);
      expect(budget.left).toBe(4); // only the winner spent a unit
    });
  });
});
