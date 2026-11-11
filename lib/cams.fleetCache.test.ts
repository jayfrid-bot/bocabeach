import { afterEach, describe, expect, it, vi } from "vitest";
import { courierFleetFor, validFleetNewest, type CacheLike } from "@/lib/cams";

// The courier breaker's shared answer (newest courier frame) in the Workers Cache:
// a bad or unreadable entry must never mark the fleet "up" (that would hide cams).

const NOW = Date.parse("2026-11-06T19:00:00Z");
const META = "https://uw.test/meta?cam=a";
const FRESH = "2026-11-06T18:50:00.000Z";
const OLD = "2026-11-06T13:00:00.000Z";

function fakeCache(entry?: unknown, opts: { matchThrows?: boolean; putThrows?: boolean } = {}) {
  const store = new Map<string, string>();
  const puts: string[] = [];
  const cache: CacheLike = {
    async match(key) {
      if (opts.matchThrows) throw new Error("cache down");
      if (!key.includes("/courierfleet/v2/")) return undefined;
      const v = store.get(key) ?? (entry === undefined ? undefined : JSON.stringify(entry));
      return v === undefined ? undefined : new Response(v);
    },
    async put(key, res) {
      if (opts.putThrows) throw new Error("cache down");
      const body = await res.text();
      puts.push(body);
      store.set(key, body);
    },
  };
  return { cache, puts };
}

function stubCams(newest: string | null | "fail") {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      if (newest === "fail") throw new Error("ETIMEDOUT");
      const cams = newest ? [{ id: "x", ok: true, source: "courier", grabbedAtUtc: newest }] : [];
      return new Response(JSON.stringify({ cams }), { status: 200 });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("courierFleetFor and its cache", () => {
  it("a valid hit is used without a request", async () => {
    const calls = stubCams(OLD);
    const { cache } = fakeCache({ newest: FRESH });
    expect(await courierFleetFor(META, NOW, cache)).toEqual({ down: false });
    expect(calls).toHaveLength(0);
  });

  it("a miss reads /cams once and stores the answer", async () => {
    const calls = stubCams(OLD);
    const { cache, puts } = fakeCache();
    const fleet = await courierFleetFor(META, NOW, cache);
    expect(fleet).toEqual({ down: true, sinceMs: Date.parse("2026-11-06T15:00:00Z") });
    expect(calls).toEqual(["https://uw.test/cams"]);
    expect(puts).toEqual([JSON.stringify({ newest: OLD })]);
  });

  it("a malformed or future entry is a miss, never 'up'", async () => {
    for (const bad of [{ newest: 2027 }, { newest: "2027-01-01T00:00:00Z" }, { newest: "soon" }, { other: 1 }, null]) {
      const calls = stubCams(OLD);
      const { cache } = fakeCache(bad);
      expect(await courierFleetFor(META, NOW, cache)).toMatchObject({ down: true });
      expect(calls).toHaveLength(1);
      vi.unstubAllGlobals();
    }
  });

  it("a cache that throws on match or put still answers from /cams", async () => {
    stubCams(FRESH);
    expect(await courierFleetFor(META, NOW, fakeCache(undefined, { matchThrows: true }).cache)).toEqual({ down: false });
    expect(await courierFleetFor(META, NOW, fakeCache(undefined, { putThrows: true }).cache)).toEqual({ down: false });
  });

  it("no cache and no /cams: unknown (cams shown)", async () => {
    stubCams("fail");
    expect(await courierFleetFor(META, NOW, null)).toEqual({ down: "unknown" });
  });

  it("validFleetNewest accepts null and past ISO times only", () => {
    expect(validFleetNewest(null, NOW)).toBeNull();
    expect(validFleetNewest(FRESH, NOW)).toBe(FRESH);
    expect(validFleetNewest("2026-11-06T19:20:00Z", NOW)).toBeUndefined();
    expect(validFleetNewest(2027, NOW)).toBeUndefined();
    expect(validFleetNewest(undefined, NOW)).toBeUndefined();
  });
});
