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

import { nativePushTokenForOwner } from "@/lib/push/native";

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
