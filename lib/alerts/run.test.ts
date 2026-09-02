// The at-beach run, end to end over the in-memory store: who gets walked, who
// gets skipped, what the counts mean, and what the kill switch does. No network:
// the feed, the conditions and the rain read are all injected.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMemoryStore } from "@/lib/db/memoryStore";
import type { DeviceStore } from "@/lib/db/store";
import type { LightningFeed } from "@/lib/sources/lightning";
import { runAtBeachAlerts, type AtBeachPush } from "@/lib/alerts/run";
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
}

async function run(opts: Options = {}) {
  return runAtBeachAlerts({
    store,
    now: NOW,
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
    plan: over.plan ?? "plus",
    entitlementUntil: NOW + 30 * 24 * HOUR,
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
    expect(sent[0].tag).toBe("safety");
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

  it("leaves the key unmarked after a transient send failure, so the next run retries", async () => {
    await seed();
    const counts = await run({ sendResult: { ok: false, dead: false } });
    expect(counts).toMatchObject({ sent: 0, errors: 1 });
    expect(await store.lastAlert(DEV, "lightning")).toBeNull();
    const retry = await run();
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
