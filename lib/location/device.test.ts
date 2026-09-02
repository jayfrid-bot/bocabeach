import { afterEach, describe, expect, it, vi } from "vitest";
import { getFix, checkLocationPermission, isNativeLocation } from "@/lib/location/device";

// This suite runs under vitest's environment: "node" (see vitest.config.ts —
// no jsdom), so there's no `window` and Capacitor's own getPlatform() safely
// reports "web" with no bridge attached. That means every case here exercises
// the WEB fallback path (navigator.geolocation), stubbed per-test with
// vi.stubGlobal. The native (Capacitor plugin proxy) path needs a real
// WebView/bridge and isn't reachable from this environment — it was verified
// manually to follow lib/push/native.ts's synchronous-resolution pattern
// exactly (see device.ts's getPlugin()).

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isNativeLocation", () => {
  it("is false with no window/bridge present (delegates to push's isNativePlatform)", () => {
    expect(isNativeLocation()).toBe(false);
  });
});

describe("getFix — web path error mapping", () => {
  it("resolves { error: 'unsupported' } when navigator.geolocation is absent", async () => {
    vi.stubGlobal("navigator", {});
    const fix = await getFix();
    expect(fix).toEqual({ error: "unsupported" });
  });

  it("maps PERMISSION_DENIED (code 1) to { error: 'denied' }", async () => {
    vi.stubGlobal("navigator", {
      geolocation: {
        getCurrentPosition: (_ok: unknown, err: (e: { code: number }) => void) => err({ code: 1 }),
      },
    });
    expect(await getFix()).toEqual({ error: "denied" });
  });

  it("maps POSITION_UNAVAILABLE (code 2) to { error: 'unavailable' }", async () => {
    vi.stubGlobal("navigator", {
      geolocation: {
        getCurrentPosition: (_ok: unknown, err: (e: { code: number }) => void) => err({ code: 2 }),
      },
    });
    expect(await getFix()).toEqual({ error: "unavailable" });
  });

  it("maps TIMEOUT (code 3) to { error: 'timeout' }", async () => {
    vi.stubGlobal("navigator", {
      geolocation: {
        getCurrentPosition: (_ok: unknown, err: (e: { code: number }) => void) => err({ code: 3 }),
      },
    });
    expect(await getFix()).toEqual({ error: "timeout" });
  });

  it("never rejects, even if the browser callback throws synchronously", async () => {
    vi.stubGlobal("navigator", {
      geolocation: {
        getCurrentPosition: () => {
          throw new Error("boom");
        },
      },
    });
    await expect(getFix()).resolves.toBeDefined();
  });

  it("resolves a Fix on success", async () => {
    vi.stubGlobal("navigator", {
      geolocation: {
        getCurrentPosition: (ok: (p: unknown) => void) =>
          ok({ coords: { latitude: 26.35, longitude: -80.08, accuracy: 12 }, timestamp: 1_700_000_000_000 }),
      },
    });
    const fix = await getFix();
    expect(fix).toEqual({ lat: 26.35, lon: -80.08, accuracyM: 12, at: 1_700_000_000_000 });
  });
});

describe("checkLocationPermission — web path", () => {
  it("returns 'unknown' when navigator.permissions is unavailable", async () => {
    vi.stubGlobal("navigator", {});
    expect(await checkLocationPermission()).toBe("unknown");
  });

  it("passes through the Permissions API state", async () => {
    vi.stubGlobal("navigator", {
      permissions: { query: async () => ({ state: "granted" }) },
    });
    expect(await checkLocationPermission()).toBe("granted");
  });
});
