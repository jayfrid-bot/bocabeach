import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isWatchView, peekWatchView, storeWatchView, watchViewKey } from "@/lib/watchViewCache";
import { MAX_WATCH_LINES, WATER_TEMP_MAX_F, WATER_TEMP_MIN_F, waterTempForView, type WatchView } from "@/lib/watchView";

const OV = "0";
const NOW = Date.parse("2026-10-14T15:00:00Z");
const view = (over: Partial<WatchView> = {}): WatchView => ({
  v: 1,
  slug: "boca-raton",
  name: "Boca Raton",
  score: 78,
  rating: "Good",
  band: "good",
  limitedData: false,
  lines: [{ kind: "water", text: "Water 82°F", tone: "calm" }],
  waterTempF: 82,
  sunForecast: {
    kind: "sunset",
    state: "pending",
    availableAt: "2026-10-14T21:52:00.000Z",
    eventAt: "2026-10-14T22:52:00.000Z",
    text: "Sunset forecast ready at 5:52 PM",
  },
  generatedAt: "2026-10-14T14:59:00.000Z",
  capturedAt: "2026-10-14T15:00:00.000Z",
  validUntil: "2026-10-14T15:10:00.000Z",
  ...over,
});

/** A fake caches.default that honors max-age the way the real one does. */
function installCache() {
  const store = new Map<string, { body: string; expiresAt: number }>();
  const calls = { match: 0, put: 0 };
  const cache = {
    async match(key: string) {
      calls.match++;
      const e = store.get(key);
      if (!e || e.expiresAt <= Date.now()) return undefined;
      return new Response(e.body);
    },
    async put(key: string, res: Response) {
      calls.put++;
      const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("Cache-Control") ?? "")?.[1]);
      store.set(key, { body: await res.text(), expiresAt: Date.now() + maxAge * 1000 });
    },
  };
  vi.stubGlobal("caches", { default: cache });
  return { store, calls, cache };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("storeWatchView + peekWatchView", () => {
  it("returns a fresh view that was stored, under a synthetic internal key", async () => {
    const { store } = installCache();
    expect(await storeWatchView(view(), OV)).toBe(true);
    expect([...store.keys()]).toEqual(["https://cache.isitbeachday.internal/watchview/boca-raton/0"]);
    expect(watchViewKey("boca-raton", OV)).toBe([...store.keys()][0]);
    expect(await peekWatchView("boca-raton", OV)).toEqual(view());
  });

  it("sets max-age to the seconds left until validUntil, capped at 15 minutes", async () => {
    const { cache } = installCache();
    const put = vi.spyOn(cache, "put");
    await storeWatchView(view(), OV); // 10 minutes left
    expect((put.mock.calls[0][1] as Response).headers.get("Cache-Control")).toBe("max-age=600");
    await storeWatchView(view({ validUntil: "2026-10-14T15:00:20.900Z" }), OV);
    expect((put.mock.calls[1][1] as Response).headers.get("Cache-Control")).toBe("max-age=20");
    await storeWatchView(view({ validUntil: "2026-10-14T18:00:00.000Z" }), OV);
    expect((put.mock.calls[2][1] as Response).headers.get("Cache-Control")).toBe("max-age=900");
  });

  it("never stores a view that is already expired, or has a bad validUntil", async () => {
    const { calls, store } = installCache();
    expect(await storeWatchView(view({ validUntil: "2026-10-14T15:00:00.000Z" }), OV)).toBe(false);
    expect(await storeWatchView(view({ validUntil: "2026-10-14T14:00:00.000Z" }), OV)).toBe(false);
    expect(await storeWatchView(view({ validUntil: "nonsense" }), OV)).toBe(false);
    expect(calls.put).toBe(0);
    expect(store.size).toBe(0);
  });

  it("peek misses once the view is past its validUntil, even if the cache still returns it", async () => {
    const { cache } = installCache();
    // A cache that ignores max-age: the peek re-checks validUntil itself.
    vi.spyOn(cache, "match").mockImplementation(async () => new Response(JSON.stringify({ v: 1, ov: OV, view: view() })));
    vi.setSystemTime(Date.parse("2026-10-14T15:10:00.000Z"));
    expect(await peekWatchView("boca-raton", OV)).toBeNull();
    vi.setSystemTime(Date.parse("2026-10-14T15:09:59.000Z"));
    expect(await peekWatchView("boca-raton", OV)).not.toBeNull();
  });

  it("the real max-age expiry also ends the entry", async () => {
    installCache();
    await storeWatchView(view(), OV);
    vi.setSystemTime(NOW + 601_000);
    expect(await peekWatchView("boca-raton", OV)).toBeNull();
  });

  it("peek misses for a beach that was never stored", async () => {
    installCache();
    expect(await peekWatchView("deerfield-beach", OV)).toBeNull();
  });

  it("peek only reads: no put, no fetch", async () => {
    const { calls } = installCache();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await storeWatchView(view(), OV);
    const putsBefore = calls.put;
    await peekWatchView("boca-raton", OV);
    await peekWatchView("nothing-here", OV);
    expect(calls.put).toBe(putsBefore);
    expect(calls.match).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("peek rejects entries for the wrong beach, wrong envelope or any structural mismatch", async () => {
    const { cache } = installCache();
    const m = vi.spyOn(cache, "match");
    const env = (viewPart: unknown, over: Record<string, unknown> = {}) => ({ v: 1, ov: OV, view: viewPart, ...over });
    const { name: _n, ...noName } = view();
    const bads: unknown[] = [
      env(view({ slug: "deerfield-beach" })),
      env({ ...view(), v: 2 }),
      env({ ...view(), lines: "x" }),
      env({ ...view(), validUntil: undefined }),
      env({ ...view(), validUntil: "not a date" }),
      env({ ...view(), score: 101 }),
      env({ ...view(), score: 78.5 }),
      env({ ...view(), score: null }), // score and rating must agree
      env({ ...view(), limitedData: "no" }),
      env({ ...view(), extra: 1 }),
      env(noName),
      env({ ...view(), lines: [{ kind: "nope", text: "x", tone: "calm" }] }),
      env({ ...view(), lines: [{ kind: "water", text: "x", tone: "loud" }] }),
      env({ ...view(), lines: [{ kind: "water", text: "x", tone: "calm", extra: 1 }] }),
      env({ ...view(), lines: Array.from({ length: MAX_WATCH_LINES + 1 }, () => ({ kind: "water", text: "x", tone: "calm" })) }),
      env({ ...view(), waterTempF: WATER_TEMP_MAX_F + 1 }),
      env({ ...view(), waterTempF: WATER_TEMP_MIN_F - 1 }),
      env({ ...view(), waterTempF: 80.5 }),
      env({ ...view(), sunForecast: undefined }), // an entry from before the field existed is a miss
      env({ ...view(), sunForecast: { ...view().sunForecast, score: 78 } }), // a score never rides along
      env({ ...view(), sunForecast: { ...view().sunForecast, state: "soon" } }),
      env({ ...view(), sunForecast: { ...view().sunForecast, text: null } }), // pending needs its line
      env({ ...view(), sunForecast: { ...view().sunForecast, state: "available" } }), // available has no line
      env(view(), { v: 2 }),
      env(view(), { ov: "other" }),
      view(), // an unwrapped view
      null,
      [],
    ];
    for (const bad of bads) {
      m.mockImplementationOnce(async () => new Response(JSON.stringify(bad)));
      expect(await peekWatchView("boca-raton", OV), JSON.stringify(bad)?.slice(0, 80)).toBeNull();
    }
    m.mockImplementationOnce(async () => new Response("{not json"));
    expect(await peekWatchView("boca-raton", OV)).toBeNull();
    // And a well-formed one passes.
    m.mockImplementationOnce(async () => new Response(JSON.stringify(env(view()))));
    expect(await peekWatchView("boca-raton", OV)).toEqual(view());
  });

  it("accepts every water temperature buildWatchView can produce, including the rounded edges", () => {
    // Readings strictly inside (-10, 150) are rounded, so -10 and 150 are real values a view can hold.
    expect(waterTempForView(-9.6)).toBe(-10);
    expect(waterTempForView(149.6)).toBe(150);
    expect(waterTempForView(-10)).toBeNull();
    expect(waterTempForView(150)).toBeNull();
    for (let t = -12; t <= 152; t += 0.1) {
      const w = waterTempForView(t);
      expect(isWatchView(view({ waterTempF: w }), "boca-raton"), `water ${t}`).toBe(true);
    }
  });

  it("accepts the largest set of lines a view can have", () => {
    const lines = Array.from({ length: MAX_WATCH_LINES }, (_, i) => ({ kind: "hazard" as const, text: `line ${i}`, tone: "caution" as const }));
    expect(isWatchView(view({ lines }), "boca-raton")).toBe(true);
  });

  it("isWatchView accepts a good view with a null score and rating", () => {
    expect(isWatchView(view({ score: null, rating: null, band: null, generatedAt: null, waterTempF: null }), "boca-raton")).toBe(true);
  });

  it("a correction by the owner (a new override fingerprint) never matches a view stored before it", async () => {
    const { store } = installCache();
    await storeWatchView(view(), "0");
    expect(await peekWatchView("boca-raton", "0")).toEqual(view());
    expect(await peekWatchView("boca-raton", "1.17")).toBeNull();
    await storeWatchView(view({ score: 55, rating: "Marginal", band: "marginal" }), "1.17");
    expect(store.size).toBe(2);
    expect((await peekWatchView("boca-raton", "1.17"))?.score).toBe(55);
    expect((await peekWatchView("boca-raton", "0"))?.score).toBe(78);
    // A stale entry planted under the new key but written with the old fingerprint is refused too.
    const k = watchViewKey("boca-raton", "2.20");
    store.set(k, { body: JSON.stringify({ v: 1, ov: "0", view: view() }), expiresAt: Date.now() + 60_000 });
    expect(await peekWatchView("boca-raton", "2.20")).toBeNull();
  });

  it("does nothing, and never throws, where there is no Cache API", async () => {
    vi.stubGlobal("caches", undefined);
    expect(await peekWatchView("boca-raton", OV)).toBeNull();
    expect(await storeWatchView(view(), OV)).toBe(false);
    vi.stubGlobal("caches", {}); // present but no default
    expect(await peekWatchView("boca-raton", OV)).toBeNull();
    expect(await storeWatchView(view(), OV)).toBe(false);
  });

  it("swallows cache errors", async () => {
    const { cache } = installCache();
    vi.spyOn(cache, "match").mockRejectedValue(new Error("down"));
    vi.spyOn(cache, "put").mockRejectedValue(new Error("down"));
    expect(await peekWatchView("boca-raton", OV)).toBeNull();
    expect(await storeWatchView(view(), OV)).toBe(false);
  });
});
