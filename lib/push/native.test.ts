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

import { initNativeTapHandling, nativePushTokenForOwner } from "@/lib/push/native";

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
  it("opens the owner review on the alert, and refuses any address a payload invents", async () => {
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { origin: "https://app.isitbeachday.com", assign } });
    await initNativeTapHandling();
    const tap = plugin.listeners.pushNotificationActionPerformed;
    expect(tap).toBeTypeOf("function");

    const settle = () => new Promise((r) => setTimeout(r, 20)); // the tap handler loads the beach list first

    tap({ notification: { data: { url: "https://app.isitbeachday.com/admin/review?alert=42" } } });
    await settle();
    expect(assign).toHaveBeenLastCalledWith("/admin/review?alert=42");

    tap({ notification: { data: { url: "/boca-raton" } } }); // the beach alerts, as before
    await settle();
    expect(assign).toHaveBeenLastCalledWith("/boca-raton");

    tap({ notification: { data: { url: "https://app.isitbeachday.com/" } } }); // the test push
    await settle();
    expect(assign).toHaveBeenLastCalledWith("/");

    assign.mockClear();
    for (const url of ["https://evil.example/admin/review?alert=1", "//evil.example", "javascript:alert(1)", "/api/quality/owner/list", "/admin/other", "/get-app", "/not-a-beach", undefined, 7]) {
      tap({ notification: { data: { url } } });
    }
    tap({ notification: {} });
    tap(undefined);
    await settle();
    expect(assign).not.toHaveBeenCalled();
  });
});
