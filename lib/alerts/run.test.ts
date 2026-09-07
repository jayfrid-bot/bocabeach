// The at-beach run, end to end over the in-memory store: who gets walked, who
// gets skipped, what the counts mean, and what the kill switch does. No network:
// the feed, the conditions and the rain read are all injected.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMemoryStore } from "@/lib/db/memoryStore";
import type { DeviceStore } from "@/lib/db/store";
import type { ArmedDevice } from "@/lib/db/types";
import type { LightningFeed } from "@/lib/sources/lightning";
import {
  runAtBeachAlerts,
  fixOf,
  FIX_MAX_AGE_MS,
  FIX_MAX_ACCURACY_M,
  FIX_MAX_DISTANCE_MI,
  type AtBeachPush,
} from "@/lib/alerts/run";
import { conditionsFixture, type ConditionsOver } from "@/lib/alerts/fixtures";
import type { RainRead } from "@/lib/alerts/rain";

const NOW = Date.parse("2026-09-02T18:00:00Z");
const HOUR = 3600 * 1000;
const DEV = "11111111-2222-4333-8444-555555555555";
const DEV2 = "22222222-3333-4444-8555-666666666666";
const TOKEN = "a".repeat(80);
const TOKEN2 = "b".repeat(80);

/** Boca's beach is 26.3587,-80.0686. This strike is ~3.4 mi north of it. */
const NEAR_STRIKE: LightningFeed = {
  generatedAt: "2026-09-02T17:58:00Z",
  windowMinutes: 20,
  strikes: [[Math.floor(NOW / 1000) - 120, 26.4087, -80.0686]],
};

const FAR_STRIKE: LightningFeed = {
  generatedAt: "2026-09-02T17:58:00Z",
  windowMinutes: 20,
  strikes: [[Math.floor(NOW / 1000) - 120, 27.5, -80.0686]],
};

let store: DeviceStore;
let sent: AtBeachPush[];
let conditionsCalls: string[];

interface Options {
  feed?: LightningFeed | null;
  conditions?: ConditionsOver;
  rain?: RainRead | null;
  sendResult?: { ok: boolean; dead: boolean };
  onDeadToken?: (id: string) => void;
  /** Override the run's clock — used to move past the 30-min dedup window or
   *  the 10-min send-claim abandonment window. */
  now?: number;
}

async function run(opts: Options = {}) {
  return runAtBeachAlerts({
    store,
    now: opts.now ?? NOW,
    deliver: async (_sub, msg) => {
      sent.push(msg);
      return opts.sendResult ?? { ok: true, dead: false };
    },
    onDeadToken: async (sub) => {
      opts.onDeadToken?.(sub.device.id);
      await store.deleteDevice(sub.device.id);
    },
    loadFeed: async () => (opts.feed === undefined ? NEAR_STRIKE : opts.feed),
    loadConditions: async (slug) => {
      conditionsCalls.push(slug);
      return conditionsFixture(opts.conditions ?? {});
    },
    loadRain: async () => opts.rain ?? null,
  });
}

async function seed(
  id = DEV,
  token = TOKEN,
  over: { plan?: "free" | "plus"; armedUntil?: number; pushToken?: string | null; slug?: string } = {},
): Promise<void> {
  await store.upsertDevice(id, {
    platform: "android",
    pushToken: over.pushToken === undefined ? token : over.pushToken,
    tz: "America/New_York",
    homeSlug: "boca-raton",
    // plan/entitlementUntil aren't patchable — grant (or don't) through
    // codeUntil and let the store derive plan from it.
    codeUntil: (over.plan ?? "plus") === "plus" ? NOW + 30 * 24 * HOUR : null,
  });
  await store.setPresence(id, {
    slug: over.slug ?? "boca-raton",
    lat: 26.3587,
    lon: -80.0686,
    accuracyM: 20,
    fixAt: NOW - 60_000,
    armedUntil: over.armedUntil ?? NOW + 4 * HOUR,
    source: "auto",
  });
}

beforeEach(() => {
  store = createMemoryStore({ file: null });
  sent = [];
  conditionsCalls = [];
  delete process.env.PUSH_SAFETY_ALERTS;
});

afterEach(() => {
  delete process.env.PUSH_SAFETY_ALERTS;
});

describe("runAtBeachAlerts", () => {
  it("alerts an armed device on lightning near its own fix", async () => {
    await seed();
    const counts = await run();
    expect(counts).toMatchObject({ devices: 1, evaluated: 1, sent: 1, errors: 0, pruned: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain("mi away — get out of the water and take cover.");
    expect(sent[0].url).toBe("/boca-raton");
    // Hazard-specific + beach-scoped, so a later rain/wind push never collapses
    // this lightning warning (#8).
    expect(sent[0].tag).toBe("safety:lightning:boca-raton");
  });

  it("writes the alert log, so the same hazard stays quiet for 30 minutes", async () => {
    await seed();
    await run();
    expect((await store.lastAlert(DEV, "lightning"))?.sentAt).toBe(NOW);
    const second = await run();
    expect(second).toMatchObject({ devices: 1, evaluated: 1, sent: 0, skipped: 1 });
  });

  it("stays silent when the storm is far away", async () => {
    await seed();
    const counts = await run({ feed: FAR_STRIKE });
    expect(counts).toMatchObject({ evaluated: 1, sent: 0 });
    expect(sent).toEqual([]);
  });

  it("skips a free device — every alert is Plus", async () => {
    await seed(DEV, TOKEN, { plan: "free" });
    const counts = await run();
    expect(counts).toMatchObject({ devices: 0, evaluated: 0, sent: 0 });
    expect(sent).toEqual([]);
  });

  it("skips a device whose arm has run out", async () => {
    await seed(DEV, TOKEN, { armedUntil: NOW - 60_000 });
    const counts = await run();
    expect(counts.devices).toBe(0);
    expect(sent).toEqual([]);
  });

  it("counts a device with no push token as skipped, not evaluated", async () => {
    await seed(DEV, TOKEN, { pushToken: null });
    const counts = await run();
    expect(counts).toMatchObject({ devices: 1, evaluated: 0, sent: 0, skipped: 1 });
  });

  it("fetches conditions once for two people on the same beach", async () => {
    await seed(DEV, TOKEN);
    await seed(DEV2, TOKEN2);
    const counts = await run();
    expect(counts).toMatchObject({ devices: 2, evaluated: 2, sent: 2 });
    expect(conditionsCalls).toEqual(["boca-raton"]);
  });

  it("does nothing at all when the kill switch is off", async () => {
    await seed();
    process.env.PUSH_SAFETY_ALERTS = "off";
    const counts = await run();
    expect(counts).toEqual({ devices: 0, evaluated: 0, sent: 0, skipped: 0, errors: 0, pruned: 0 });
    expect(sent).toEqual([]);
    expect(await store.lastAlert(DEV, "lightning")).toBeNull();
  });

  it("prunes a dead token and stops pushing to it", async () => {
    await seed();
    const dropped: string[] = [];
    const counts = await run({
      sendResult: { ok: false, dead: true },
      onDeadToken: (id) => dropped.push(id),
    });
    expect(counts).toMatchObject({ pruned: 1, sent: 0 });
    expect(dropped).toEqual([DEV]);
    expect(await store.getDevice(DEV)).toBeNull();
  });

  it("leaves the key unmarked after a transient send failure, and retries once its claim looks abandoned", async () => {
    await seed();
    const counts = await run({ sendResult: { ok: false, dead: false } });
    expect(counts).toMatchObject({ sent: 0, errors: 1 });
    expect(await store.lastAlert(DEV, "lightning")).toBeNull();
    // Right away, the send claim from the failed attempt is still active (not
    // yet 10 minutes old) — see #14 — so an immediate retry is held, not sent.
    const tooSoon = await run();
    expect(tooSoon).toMatchObject({ sent: 0, skipped: 1 });
    // Once the claim looks abandoned, the next run reclaims it and sends.
    const retry = await run({ now: NOW + 10 * 60_000 });
    expect(retry.sent).toBe(1);
  });

  it("sends one push, not two, when the fix is already inside 2 miles", async () => {
    await seed();
    const close: LightningFeed = {
      generatedAt: "2026-09-02T17:58:00Z",
      windowMinutes: 20,
      strikes: [[Math.floor(NOW / 1000) - 60, 26.3687, -80.0686]], // ~0.7 mi
    };
    const counts = await run({ feed: close });
    expect(counts.sent).toBe(1);
    expect(sent[0].body).toBe("⚡ Lightning within 2 miles — take cover now.");
    // The quieter alert is marked too, so it does not arrive a run later.
    expect(await store.lastAlert(DEV, "lightning")).not.toBeNull();
  });

  it("remembers a wet fix so 'rain clearing' has something to clear from", async () => {
    await seed();
    await run({
      feed: null,
      rain: { etaMinutes: null, rainingNow: true, clearingSoon: false, source: "radar" },
    });
    expect((await store.lastAlert(DEV, "rain-wet"))?.sentAt).toBe(NOW);

    const clearing = await run({
      feed: null,
      rain: { etaMinutes: null, rainingNow: false, clearingSoon: true, source: "radar" },
    });
    expect(clearing.sent).toBe(1);
    expect(sent.at(-1)?.body).toBe("☀️ Rain clearing — the beach should dry out soon.");
  });

  it("keeps going when one beach is unknown", async () => {
    await seed(DEV, TOKEN);
    await seed(DEV2, TOKEN2);
    await store.setPresence(DEV2, {
      slug: "atlantis",
      lat: 0,
      lon: 0,
      accuracyM: null,
      fixAt: null,
      armedUntil: NOW + HOUR,
      source: "manual",
    });
    const counts = await run();
    expect(counts).toMatchObject({ devices: 2, evaluated: 1, sent: 1 });
    expect(counts.skipped).toBeGreaterThanOrEqual(1);
  });

  it("runs with no feed at all", async () => {
    await seed();
    const counts = await run({ feed: null });
    expect(counts).toMatchObject({ evaluated: 1, sent: 0, errors: 0 });
  });
});

// The concurrency guard beneath the dedup window (#14): the Cloudflare 5-min
// cron and the GitHub hourly backstop can both call the sender within
// seconds of each other. Both can read "not yet sent" before either writes —
// the send claim is what still limits them to one actual push.
describe("runAtBeachAlerts — overlapping runs (#14)", () => {
  it("two runs racing over the same armed device send the hazard exactly once", async () => {
    await seed();
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.sent + b.sent).toBe(1);
    expect(sent).toHaveLength(1);
    // The loser still evaluated the device — it just lost the send, not the
    // whole device — so it should show up as skipped, not silently dropped.
    expect(a.skipped + b.skipped).toBeGreaterThanOrEqual(1);
  });
});

// Where hazard geometry comes from: the person's own fix when it can be
// trusted, the beach centroid otherwise, always explicitly (#6).
describe("fixOf", () => {
  const BEACH = { lat: 26.3587, lon: -80.0686 }; // Boca Raton
  const NOW6 = 2_000_000_000_000;

  function armed(over: Partial<ArmedDevice["presence"]> = {}): ArmedDevice {
    return {
      device: {} as ArmedDevice["device"], // fixOf never reads this
      presence: {
        slug: "boca-raton",
        lat: BEACH.lat,
        lon: BEACH.lon,
        accuracyM: 20,
        fixAt: NOW6 - 60_000,
        armedUntil: NOW6 + 3600_000,
        source: "auto",
        ...over,
      },
    };
  }

  it("uses the device fix when it is fresh, accurate and near the beach", () => {
    const f = fixOf(armed(), BEACH, NOW6);
    expect(f).toEqual({ lat: BEACH.lat, lon: BEACH.lon, fixSource: "device" });
  });

  it("falls back to the beach centroid when lat/lon are null", () => {
    const f = fixOf(armed({ lat: null, lon: null }), BEACH, NOW6);
    expect(f).toEqual({ ...BEACH, fixSource: "beach" });
  });

  it("falls back when the fix has no timestamp at all", () => {
    const f = fixOf(armed({ fixAt: null }), BEACH, NOW6);
    expect(f.fixSource).toBe("beach");
  });

  it("uses a fix exactly at the age limit, falls back just past it", () => {
    const atLimit = fixOf(armed({ fixAt: NOW6 - FIX_MAX_AGE_MS }), BEACH, NOW6);
    expect(atLimit.fixSource).toBe("device");
    const pastLimit = fixOf(armed({ fixAt: NOW6 - FIX_MAX_AGE_MS - 1 }), BEACH, NOW6);
    expect(pastLimit.fixSource).toBe("beach");
  });

  it("falls back on a fix worse than the accuracy limit", () => {
    const ok = fixOf(armed({ accuracyM: FIX_MAX_ACCURACY_M }), BEACH, NOW6);
    expect(ok.fixSource).toBe("device");
    const bad = fixOf(armed({ accuracyM: FIX_MAX_ACCURACY_M + 1 }), BEACH, NOW6);
    expect(bad.fixSource).toBe("beach");
  });

  it("trusts a fix with no accuracy reading at all — only a bad one disqualifies it", () => {
    const f = fixOf(armed({ accuracyM: null }), BEACH, NOW6);
    expect(f.fixSource).toBe("device");
  });

  it("falls back on a fix far from the armed beach", () => {
    // A fresh, accurate fix at HOME while manually monitoring a beach ~40 mi
    // away — the "arm a distant destination from home" case in #6.
    const home = { lat: 26.3587, lon: -80.4 }; // west of Boca, past the 15 km cap
    const f = fixOf(armed(home), BEACH, NOW6);
    expect(f.fixSource).toBe("beach");
    expect(f).toEqual({ ...BEACH, fixSource: "beach" });
  });

  it("uses a fix just inside the distance cap", () => {
    // ~0.05° of longitude at this latitude is a little under 5 km.
    const nearby = { lat: BEACH.lat, lon: BEACH.lon - 0.05 };
    const f = fixOf(armed(nearby), BEACH, NOW6);
    expect(f.fixSource).toBe("device");
    expect(FIX_MAX_DISTANCE_MI).toBeGreaterThan(9); // sanity: ~15 km in miles
  });
});
