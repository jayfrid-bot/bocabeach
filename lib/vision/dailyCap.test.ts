import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ctl = vi.hoisted(() => ({ env: undefined as Record<string, unknown> | undefined, throwCtx: false }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: async () => {
    if (ctl.throwCtx) throw new Error("no context");
    return { env: ctl.env };
  },
}));

import { CLEF_DAILY_CAP, resetMemoryClefCap, secondsToUtcMidnight, takeClefDailySlot } from "@/lib/vision/dailyCap";

function fakeKv() {
  const store = new Map<string, { value: string; ttl?: number }>();
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k)?.value ?? null),
    put: vi.fn(async (k: string, value: string, opts?: { expirationTtl?: number }) => {
      store.set(k, { value, ttl: opts?.expirationTtl });
    }),
  };
}

const NOON = Date.parse("2026-10-12T12:00:00.000Z");

beforeEach(() => {
  resetMemoryClefCap();
  ctl.env = undefined;
  ctl.throwCtx = false;
});
afterEach(() => vi.restoreAllMocks());

describe("takeClefDailySlot", () => {
  it("caps at 600 a day", () => {
    expect(CLEF_DAILY_CAP).toBe(600);
  });

  it("counts in KV under a per-UTC-day key that expires on its own", async () => {
    const kv = fakeKv();
    ctl.env = { PUSH_KV: kv };
    expect(await takeClefDailySlot(NOON)).toEqual({ allowed: true, count: 1 });
    expect(await takeClefDailySlot(NOON)).toEqual({ allowed: true, count: 2 });
    expect([...kv.store.keys()]).toEqual(["clef-daily:2026-10-12"]);
    expect(kv.store.get("clef-daily:2026-10-12")).toEqual({ value: "2", ttl: 172800 });
  });

  it("denies the call after the cap and does not count denied calls", async () => {
    const kv = fakeKv();
    kv.store.set("clef-daily:2026-10-12", { value: "600" });
    ctl.env = { PUSH_KV: kv };
    const r = await takeClefDailySlot(NOON);
    expect(r).toMatchObject({ allowed: false, reason: "daily-cap" });
    expect(kv.put).not.toHaveBeenCalled();
    expect(kv.store.get("clef-daily:2026-10-12")?.value).toBe("600");
  });

  it("allows the 600th call and denies the 601st", async () => {
    const kv = fakeKv();
    kv.store.set("clef-daily:2026-10-12", { value: "599" });
    ctl.env = { PUSH_KV: kv };
    expect(await takeClefDailySlot(NOON)).toEqual({ allowed: true, count: 600 });
    expect(await takeClefDailySlot(NOON)).toMatchObject({ allowed: false, reason: "daily-cap" });
  });

  it("starts a fresh count at 00:00 UTC", async () => {
    const kv = fakeKv();
    kv.store.set("clef-daily:2026-10-12", { value: "600" });
    ctl.env = { PUSH_KV: kv };
    const nextDay = Date.parse("2026-10-13T00:00:01.000Z");
    expect(await takeClefDailySlot(nextDay)).toEqual({ allowed: true, count: 1 });
  });

  it("reports the seconds to the next UTC midnight", async () => {
    expect(secondsToUtcMidnight(NOON)).toBe(12 * 3600);
    const kv = fakeKv();
    kv.store.set("clef-daily:2026-10-12", { value: "600" });
    ctl.env = { PUSH_KV: kv };
    expect(await takeClefDailySlot(NOON)).toEqual({ allowed: false, reason: "daily-cap", retryAfterSec: 12 * 3600 });
  });

  it("FAILS CLOSED when KV exists but throws", async () => {
    ctl.env = { PUSH_KV: { get: async () => { throw new Error("kv down"); }, put: async () => undefined } };
    expect(await takeClefDailySlot(NOON)).toEqual({ allowed: false, reason: "cap-unavailable" });
    ctl.env = { PUSH_KV: { get: async () => null, put: async () => { throw new Error("kv down"); } } };
    expect(await takeClefDailySlot(NOON)).toEqual({ allowed: false, reason: "cap-unavailable" });
  });

  it("FAILS CLOSED on a corrupt counter", async () => {
    const kv = fakeKv();
    kv.store.set("clef-daily:2026-10-12", { value: "banana" });
    ctl.env = { PUSH_KV: kv };
    expect(await takeClefDailySlot(NOON)).toEqual({ allowed: false, reason: "cap-unavailable" });
  });

  it("uses an in-memory counter when there is no KV binding (dev, tests)", async () => {
    expect(await takeClefDailySlot(NOON, 2)).toEqual({ allowed: true, count: 1 });
    expect(await takeClefDailySlot(NOON, 2)).toEqual({ allowed: true, count: 2 });
    expect(await takeClefDailySlot(NOON, 2)).toMatchObject({ allowed: false, reason: "daily-cap" });
  });

  it("uses the in-memory counter when there is no Cloudflare context at all", async () => {
    ctl.throwCtx = true;
    expect(await takeClefDailySlot(NOON, 1)).toEqual({ allowed: true, count: 1 });
    expect(await takeClefDailySlot(NOON, 1)).toMatchObject({ allowed: false });
  });
});
