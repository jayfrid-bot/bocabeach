import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { peekWatchView, storeWatchView, watchViewKey } from "@/lib/watchViewCache";
import type { WatchView } from "@/lib/watchView";

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
    expect(await storeWatchView(view())).toBe(true);
    expect([...store.keys()]).toEqual(["https://cache.isitbeachday.internal/watchview/boca-raton"]);
    expect(watchViewKey("boca-raton")).toBe([...store.keys()][0]);
    expect(await peekWatchView("boca-raton")).toEqual(view());
  });

  it("sets max-age to the seconds left until validUntil, capped at 15 minutes", async () => {
    const { cache } = installCache();
    const put = vi.spyOn(cache, "put");
    await storeWatchView(view()); // 10 minutes left
    expect((put.mock.calls[0][1] as Response).headers.get("Cache-Control")).toBe("max-age=600");
    await storeWatchView(view({ validUntil: "2026-10-14T15:00:20.900Z" }));
    expect((put.mock.calls[1][1] as Response).headers.get("Cache-Control")).toBe("max-age=20");
    await storeWatchView(view({ validUntil: "2026-10-14T18:00:00.000Z" }));
    expect((put.mock.calls[2][1] as Response).headers.get("Cache-Control")).toBe("max-age=900");
  });

  it("never stores a view that is already expired, or has a bad validUntil", async () => {
    const { calls, store } = installCache();
    expect(await storeWatchView(view({ validUntil: "2026-10-14T15:00:00.000Z" }))).toBe(false);
    expect(await storeWatchView(view({ validUntil: "2026-10-14T14:00:00.000Z" }))).toBe(false);
    expect(await storeWatchView(view({ validUntil: "nonsense" }))).toBe(false);
    expect(calls.put).toBe(0);
    expect(store.size).toBe(0);
  });

  it("peek misses once the view is past its validUntil, even if the cache still returns it", async () => {
    const { cache } = installCache();
    // A cache that ignores max-age: the peek re-checks validUntil itself.
    vi.spyOn(cache, "match").mockImplementation(async () => new Response(JSON.stringify(view())));
    vi.setSystemTime(Date.parse("2026-10-14T15:10:00.000Z"));
    expect(await peekWatchView("boca-raton")).toBeNull();
    vi.setSystemTime(Date.parse("2026-10-14T15:09:59.000Z"));
    expect(await peekWatchView("boca-raton")).not.toBeNull();
  });

  it("the real max-age expiry also ends the entry", async () => {
    installCache();
    await storeWatchView(view());
    vi.setSystemTime(NOW + 601_000);
    expect(await peekWatchView("boca-raton")).toBeNull();
  });

  it("peek misses for a beach that was never stored", async () => {
    installCache();
    expect(await peekWatchView("deerfield-beach")).toBeNull();
  });

  it("peek only reads: no put, no fetch", async () => {
    const { calls } = installCache();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await storeWatchView(view());
    const putsBefore = calls.put;
    await peekWatchView("boca-raton");
    await peekWatchView("nothing-here");
    expect(calls.put).toBe(putsBefore);
    expect(calls.match).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("peek rejects entries for the wrong beach, wrong version or a damaged shape", async () => {
    const { cache } = installCache();
    const m = vi.spyOn(cache, "match");
    for (const bad of [
      view({ slug: "deerfield-beach" }),
      { ...view(), v: 2 },
      { ...view(), lines: "x" },
      { ...view(), validUntil: undefined },
      null,
    ]) {
      m.mockResolvedValueOnce(new Response(JSON.stringify(bad)));
      expect(await peekWatchView("boca-raton")).toBeNull();
    }
    m.mockResolvedValueOnce(new Response("{not json"));
    expect(await peekWatchView("boca-raton")).toBeNull();
  });

  it("does nothing, and never throws, where there is no Cache API", async () => {
    vi.stubGlobal("caches", undefined);
    expect(await peekWatchView("boca-raton")).toBeNull();
    expect(await storeWatchView(view())).toBe(false);
    vi.stubGlobal("caches", {}); // present but no default
    expect(await peekWatchView("boca-raton")).toBeNull();
    expect(await storeWatchView(view())).toBe(false);
  });

  it("swallows cache errors", async () => {
    const { cache } = installCache();
    vi.spyOn(cache, "match").mockRejectedValue(new Error("down"));
    vi.spyOn(cache, "put").mockRejectedValue(new Error("down"));
    expect(await peekWatchView("boca-raton")).toBeNull();
    expect(await storeWatchView(view())).toBe(false);
  });
});
