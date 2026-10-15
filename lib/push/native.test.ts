// nativePushTokenForOwner: the owner screens must ask the plugin for a FRESH token, never reuse a
// token an earlier beach registration left in local storage.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const plugin = vi.hoisted(() => {
  const listeners: Record<string, (arg: unknown) => void> = {};
  return {
    permission: "granted" as string,
    fresh: "fresh-token",
    registers: 0,
    listeners,
    checkPermissions: async () => ({ receive: plugin.permission }),
    requestPermissions: async () => ({ receive: plugin.permission }),
    addListener: async (name: string, cb: (arg: unknown) => void) => {
      listeners[name] = cb;
      return { remove: async () => {} };
    },
    register: async () => {
      plugin.registers += 1;
      queueMicrotask(() => listeners.registration?.({ value: plugin.fresh }));
    },
  };
});
const cap = vi.hoisted(() => ({ platform: "ios" }));

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => cap.platform, isPluginAvailable: () => true },
}));
vi.mock("@capacitor/push-notifications", () => ({ PushNotifications: plugin }));
vi.mock("@/lib/deviceId", () => ({ getDeviceId: () => "" }));

import { handleNotificationTap, initNativeTapHandling, nativePushTokenForOwner, type BeachLookupLoader } from "@/lib/push/native";

function stubStorage(entries: Record<string, string>): void {
  const m = new Map(Object.entries(entries));
  vi.stubGlobal("localStorage", {
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  });
}

beforeEach(() => {
  plugin.permission = "granted";
  plugin.fresh = "fresh-token";
  plugin.registers = 0;
  cap.platform = "ios";
});
afterEach(() => vi.unstubAllGlobals());

describe("nativePushTokenForOwner", () => {
  it("asks the plugin for a fresh token and ignores a cached native-push:* value", async () => {
    stubStorage({ "native-push:boca-raton": "stale-cached-token" });
    expect(await nativePushTokenForOwner()).toBe("fresh-token");
    expect(plugin.registers).toBe(1);
  });

  it("is null when push is not allowed on this phone, and it never prompts", async () => {
    stubStorage({ "native-push:boca-raton": "stale-cached-token" });
    plugin.permission = "prompt";
    expect(await nativePushTokenForOwner()).toBeNull();
    expect(plugin.registers).toBe(0);
  });

  it("is null off iOS", async () => {
    cap.platform = "android";
    expect(await nativePushTokenForOwner()).toBeNull();
    cap.platform = "web";
    expect(await nativePushTokenForOwner()).toBeNull();
    expect(plugin.registers).toBe(0);
  });
});

describe("tapping a notification", () => {
  const tapOf = (url: unknown) => ({ notification: { data: { url } } }) as never;
  const nav = () => {
    const assign = vi.fn();
    return { assign, nav: { origin: "https://app.isitbeachday.com", assign } };
  };
  /** A loader that must never run (the answer is known without it). */
  const neverLoads: BeachLookupLoader = () => {
    throw new Error("the beach list must not be loaded for this tap");
  };

  it("opens the owner review, the root and a known beach AT ONCE, loading nothing", async () => {
    const n = nav();
    // not awaited: the web view must already have been told when the call returns
    void handleNotificationTap(tapOf("https://app.isitbeachday.com/admin/review?alert=42"), n.nav, neverLoads);
    expect(n.assign).toHaveBeenLastCalledWith("/admin/review?alert=42");
    void handleNotificationTap(tapOf("/boca-raton"), n.nav, neverLoads);
    expect(n.assign).toHaveBeenLastCalledWith("/boca-raton");
    void handleNotificationTap(tapOf("https://app.isitbeachday.com/"), n.nav, neverLoads);
    expect(n.assign).toHaveBeenLastCalledWith("/");
    await handleNotificationTap(tapOf("/admin/report"), n.nav, neverLoads);
    expect(n.assign).toHaveBeenLastCalledWith("/admin/report");
  });

  it("looks up a beach that is not in the bundled set, and opens it when it is real", async () => {
    const n = nav();
    const load = vi.fn<BeachLookupLoader>(async () => (slug) => slug === "newly-added-beach");
    await handleNotificationTap(tapOf("/newly-added-beach"), n.nav, load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(n.assign).toHaveBeenCalledWith("/newly-added-beach");
  });

  it("ignores an unknown slug the lookup does not know", async () => {
    const n = nav();
    await handleNotificationTap(tapOf("/not-a-beach"), n.nav, async () => () => false);
    expect(n.assign).not.toHaveBeenCalled();
  });

  it("falls back to the root, not to nothing, when the lazy beach list cannot load", async () => {
    const n = nav();
    await handleNotificationTap(tapOf("/newly-added-beach"), n.nav, async () => {
      throw new Error("ChunkLoadError: Loading chunk 123 failed");
    });
    expect(n.assign).toHaveBeenCalledTimes(1);
    expect(n.assign).toHaveBeenCalledWith("/");
  });

  it("refuses any address a payload invents, without loading anything", async () => {
    const n = nav();
    for (const url of ["https://evil.example/admin/review?alert=1", "//evil.example", "javascript:alert(1)", "/api/quality/owner/list", "/admin/other", "/get-app", "/support", "/find", undefined, 7]) {
      await handleNotificationTap(tapOf(url), n.nav, neverLoads);
    }
    await handleNotificationTap({ notification: {} } as never, n.nav, neverLoads);
    await handleNotificationTap(undefined, n.nav, neverLoads);
    expect(n.assign).not.toHaveBeenCalled();
  });

  it("the registered listener uses the handler", async () => {
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { origin: "https://app.isitbeachday.com", assign } });
    await initNativeTapHandling();
    const tap = plugin.listeners.pushNotificationActionPerformed;
    expect(tap).toBeTypeOf("function");
    tap({ notification: { data: { url: "/deerfield-beach" } } });
    expect(assign).toHaveBeenLastCalledWith("/deerfield-beach"); // synchronous: no waiting
  });
});
