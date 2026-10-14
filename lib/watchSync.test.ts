import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listLocations } from "@/config/locations";
import { GOOD_WINDOW_MIN_SCORE, SCORE_BANDS } from "@/lib/scoreBands";
import {
  MAX_FAVORITES,
  SLUG_PATTERN,
  buildWatchPayload,
  isWatchSyncAvailable,
  resetWatchSyncState,
  syncWatchBeaches,
} from "@/lib/watchSync";

function installBridge(plugin: Record<string, unknown> | undefined, available = true) {
  (globalThis as { window?: unknown }).window = {
    Capacitor: {
      isPluginAvailable: (n: string) => (n === "WatchSync" ? available : false),
      Plugins: plugin ? { WatchSync: plugin } : {},
    },
  };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  resetWatchSyncState();
});

describe("buildWatchPayload", () => {
  it("keeps valid slugs in order and removes duplicates", () => {
    expect(buildWatchPayload("boca-raton", ["naples", "miami-beach", "naples"])).toEqual({
      homeSlug: "boca-raton",
      favorites: ["naples", "miami-beach"],
      lastViewedSlug: null,
    });
  });

  it("drops anything that is not a slug", () => {
    const bad = ["Boca Raton", "../etc", "a--b", "-x", "x-", "", 7, null, "x".repeat(65)];
    expect(buildWatchPayload("Boca Raton", bad)).toEqual({ homeSlug: null, favorites: [], lastViewedSlug: null });
    expect(buildWatchPayload(undefined, "not-a-list", "Not A Slug")).toEqual({
      homeSlug: null,
      favorites: [],
      lastViewedSlug: null,
    });
  });

  it("carries a valid last-viewed beach", () => {
    expect(buildWatchPayload(null, [], "naples")).toEqual({ homeSlug: null, favorites: [], lastViewedSlug: "naples" });
    expect(buildWatchPayload("boca-raton", [], "naples").lastViewedSlug).toBe("naples");
  });

  it("caps the favorites list", () => {
    const many = Array.from({ length: 40 }, (_, i) => `beach-${i}`);
    expect(buildWatchPayload(null, many).favorites).toHaveLength(MAX_FAVORITES);
  });
});

describe("syncWatchBeaches", () => {
  it("is a quiet no-op with no window (website, SSR)", async () => {
    expect(isWatchSyncAvailable()).toBe(false);
    await expect(syncWatchBeaches("boca-raton")).resolves.toBe(false);
  });

  it("is a quiet no-op when the plugin is missing (Android, old iOS build)", async () => {
    installBridge(undefined);
    expect(isWatchSyncAvailable()).toBe(false);
    await expect(syncWatchBeaches("boca-raton")).resolves.toBe(false);
    installBridge({ setBeaches: vi.fn() }, false);
    await expect(syncWatchBeaches("boca-raton")).resolves.toBe(false);
  });

  it("sends the cleaned payload and does not resend an unchanged one", async () => {
    const setBeaches = vi.fn().mockResolvedValue({ ok: true });
    installBridge({ setBeaches });
    await expect(syncWatchBeaches("boca-raton", ["naples", "bad slug"])).resolves.toBe(true);
    await expect(syncWatchBeaches("boca-raton", ["naples"])).resolves.toBe(true);
    expect(setBeaches).toHaveBeenCalledTimes(1);
    expect(setBeaches).toHaveBeenCalledWith({ homeSlug: "boca-raton", favorites: ["naples"], lastViewedSlug: null });
    await syncWatchBeaches(null, []);
    expect(setBeaches).toHaveBeenLastCalledWith({ homeSlug: null, favorites: [], lastViewedSlug: null });
    expect(setBeaches).toHaveBeenCalledTimes(2);
  });

  it("sends the last-viewed beach, and a changed one counts as a new payload", async () => {
    const setBeaches = vi.fn().mockResolvedValue({ ok: true });
    installBridge({ setBeaches });
    await syncWatchBeaches(null, [], "naples");
    await syncWatchBeaches(null, [], "naples");
    await syncWatchBeaches(null, [], "miami-beach");
    expect(setBeaches).toHaveBeenCalledTimes(2);
    expect(setBeaches).toHaveBeenNthCalledWith(1, { homeSlug: null, favorites: [], lastViewedSlug: "naples" });
    expect(setBeaches).toHaveBeenLastCalledWith({ homeSlug: null, favorites: [], lastViewedSlug: "miami-beach" });
  });

  it("returns false (never throws) when the plugin refuses or rejects, and tries again next time", async () => {
    const setBeaches = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: "origin-not-allowed" })
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ ok: true });
    installBridge({ setBeaches });
    await expect(syncWatchBeaches("boca-raton")).resolves.toBe(false);
    await expect(syncWatchBeaches("boca-raton")).resolves.toBe(false);
    await expect(syncWatchBeaches("boca-raton")).resolves.toBe(true);
    expect(setBeaches).toHaveBeenCalledTimes(3);
  });
});

describe("last-viewed beach storage and sync", () => {
  function installStorage(initial: Record<string, string> = {}) {
    const data = { ...initial };
    const store = {
      getItem: (k: string) => (k in data ? data[k] : null),
      setItem: (k: string, v: string) => void (data[k] = v),
      removeItem: (k: string) => void delete data[k],
    };
    (globalThis as { localStorage?: unknown }).localStorage = store;
    return { data, store };
  }

  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    vi.resetModules();
  });

  it("is a no-op on the server", async () => {
    const mod = await import("@/lib/lastViewedBeach");
    expect(mod.getLastViewedBeach()).toBeNull();
    expect(() => mod.setLastViewedBeach("naples")).not.toThrow();
  });

  it("saves and reads the slug", async () => {
    const { data } = installStorage();
    (globalThis as { window?: unknown }).window = {};
    const mod = await import("@/lib/lastViewedBeach");
    mod.setLastViewedBeach("naples");
    expect(data["bd:last-viewed-beach"]).toBe("naples");
    expect(mod.getLastViewedBeach()).toBe("naples");
  });

  it("syncWatchFromStorage sends home and last viewed together", async () => {
    installStorage({ "bd:last-viewed-beach": "naples" });
    const setBeaches = vi.fn().mockResolvedValue({ ok: true });
    installBridge({ setBeaches });
    const { syncWatchFromStorage } = await import("@/lib/useWatchSync");
    await syncWatchFromStorage();
    expect(setBeaches).toHaveBeenLastCalledWith({ homeSlug: null, favorites: [], lastViewedSlug: "naples" });
    installStorage({ "bd:last-viewed-beach": "naples", "bd:home-beach": "boca-raton" });
    await syncWatchFromStorage();
    expect(setBeaches).toHaveBeenLastCalledWith({ homeSlug: "boca-raton", favorites: [], lastViewedSlug: "naples" });
  });

  it("setHomeBeach keeps the saved last-viewed beach in the payload", async () => {
    installStorage({ "bd:last-viewed-beach": "naples" });
    const setBeaches = vi.fn().mockResolvedValue({ ok: true });
    installBridge({ setBeaches });
    const { setHomeBeach } = await import("@/lib/homeBeach");
    setHomeBeach("boca-raton");
    await Promise.resolve();
    expect(setBeaches).toHaveBeenLastCalledWith({ homeSlug: "boca-raton", favorites: [], lastViewedSlug: "naples" });
  });
});

// ---- Guards on the Swift side, which has no test target of its own --------

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("Apple Watch app stays in step with the web app", () => {
  it("ScoreBands.swift matches SCORE_BANDS in lib/scoreBands.ts", () => {
    const swift = read("ios/App/WatchShared/ScoreBands.swift");
    const found = [...swift.matchAll(/ScoreBand\(min: (\d+), rating: "([^"]+)", hex: 0x([0-9A-Fa-f]{6})\)/g)].map(
      (m) => ({ min: Number(m[1]), rating: m[2], color: `#${m[3].toLowerCase()}` }),
    );
    expect(found).toEqual(SCORE_BANDS.map((b) => ({ min: b.min, rating: b.rating, color: b.color })));
    expect(swift).toContain(`goodWindowMinScore = ${GOOD_WINDOW_MIN_SCORE}`);
  });

  it("the Swift slug rule is the same pattern", () => {
    const swift = read("ios/App/Shared/WatchSyncPayload.swift");
    expect(swift).toContain(`"^${SLUG_PATTERN.source.slice(1, -1)}$"`);
    expect(swift).toContain(`maxFavorites = ${MAX_FAVORITES}`);
    for (const key of ["homeSlug", "favorites", "lastViewedSlug"]) {
      expect(swift).toContain(`= "${key}"`);
    }
  });

  it("the App Group is the same string on the phone, the watch and the widget", () => {
    const group = /appGroup = "([^"]+)"/.exec(read("ios/App/Shared/WatchSyncPayload.swift"))?.[1];
    expect(group).toBe("group.com.isitbeachday.app");
    for (const f of [
      "ios/App/App/App.entitlements",
      "ios/App/BeachDayWatch/BeachDayWatch.entitlements",
      "ios/App/BeachDayWatchWidget/BeachDayWatchWidget.entitlements",
    ]) {
      expect(read(f)).toContain(`<string>${group}</string>`);
    }
  });

  it("the bundled watch beach list has no dead or invalid slugs", () => {
    const bundled = JSON.parse(read("ios/App/WatchShared/Beaches.json")) as { slug: string }[];
    const live = new Set(listLocations().map((l) => l.slug));
    expect(bundled.length).toBeGreaterThan(0);
    for (const b of bundled) {
      expect(SLUG_PATTERN.test(b.slug)).toBe(true);
      expect(live.has(b.slug), `${b.slug} was removed; rerun scripts/ios-watch/export-beaches.mjs`).toBe(true);
    }
  });
});
