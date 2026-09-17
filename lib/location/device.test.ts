import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ARRIVAL_MAX_FIX_AGE_MS,
  FIX_MAX_ACCURACY_M,
  FIX_MAX_FUTURE_SKEW_MS,
  FRESH_FIX_ACCEPT_AGE_MS,
  FRESH_FIX_MAX_AGE_MS,
  FIX_STALE_MS,
  getFix,
  getFreshFix,
  checkLocationAccess,
  checkLocationPermission,
  isNativeLocation,
  resolveNativeAccess,
  shouldRefreshFix,
  validateFreshFix,
} from "@/lib/location/device";
import { FIX_MAX_ACCURACY_M as SERVER_FIX_MAX_ACCURACY_M } from "@/lib/alerts/run";

// This suite runs under vitest's environment: "node" (see vitest.config.ts —
// no jsdom), so by default there's no `window` and Capacitor's own
// getPlatform() reports "web" with no bridge attached: those cases exercise
// the WEB path (navigator.geolocation), stubbed per-test with vi.stubGlobal.
// The NATIVE path is reached by stubbing the injected bridge global
// (`window.Capacitor` with `getPlatform()` and `Plugins.Geolocation`) — the
// same object lib/push/native.ts's platform probe and device.ts's getPlugin()
// read in the real WebView — so the permission folding and fix options are
// exercised against a fake plugin rather than trusted (LOC-07).

/** Install a fake native bridge with the given Geolocation plugin. */
function nativeBridge(plugin: Record<string, unknown>) {
  vi.stubGlobal("window", { Capacitor: { getPlatform: () => "android", Plugins: { Geolocation: plugin } } });
}

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

describe("shouldRefreshFix", () => {
  it("never refreshes when there is no fix at all — that prompt belongs to an explicit tap", () => {
    expect(shouldRefreshFix(null)).toBe(false);
  });

  it("leaves a fresh fix alone", () => {
    expect(shouldRefreshFix(0)).toBe(false);
    expect(shouldRefreshFix(FIX_STALE_MS - 1)).toBe(false);
  });

  it("refreshes once a fix reaches the staleness threshold", () => {
    expect(shouldRefreshFix(FIX_STALE_MS)).toBe(true);
    expect(shouldRefreshFix(FIX_STALE_MS + 60_000)).toBe(true);
  });
});

describe("checkLocationAccess — native bridge (LOC-07)", () => {
  it("precise grant: granted, fine", async () => {
    nativeBridge({ checkPermissions: async () => ({ location: "granted", coarseLocation: "granted" }) });
    expect(isNativeLocation()).toBe(true);
    expect(await checkLocationAccess()).toEqual({ state: "granted", precision: "fine" });
    expect(await checkLocationPermission()).toBe("granted");
  });

  it("Android approximate-only: a usable grant for discovery, flagged coarse — not denied", async () => {
    nativeBridge({ checkPermissions: async () => ({ location: "denied", coarseLocation: "granted" }) });
    expect(await checkLocationAccess()).toEqual({ state: "granted", precision: "coarse" });
    expect(await checkLocationPermission()).toBe("granted");
  });

  it("true denial stays denied", async () => {
    nativeBridge({ checkPermissions: async () => ({ location: "denied", coarseLocation: "denied" }) });
    expect(await checkLocationAccess()).toEqual({ state: "denied", precision: "unknown" });
  });

  it("not asked yet is prompt, whichever alias says so", async () => {
    expect(resolveNativeAccess({ location: "prompt", coarseLocation: "prompt" }).state).toBe("prompt");
    expect(resolveNativeAccess({ location: "denied", coarseLocation: "prompt-with-rationale" }).state).toBe("prompt");
  });

  it("a plugin that throws is unknown, never denied", async () => {
    nativeBridge({
      checkPermissions: async () => {
        throw new Error("bridge stalled");
      },
    });
    expect(await checkLocationAccess()).toEqual({ state: "unknown", precision: "unknown" });
  });
});

describe("getFix / getFreshFix — native bridge options (LOC-06)", () => {
  function pluginReturning(pos: { lat: number; lon: number; acc: number; at: number }) {
    const calls: unknown[] = [];
    nativeBridge({
      getCurrentPosition: async (opts: unknown) => {
        calls.push(opts);
        return { coords: { latitude: pos.lat, longitude: pos.lon, accuracy: pos.acc }, timestamp: pos.at };
      },
    });
    return calls;
  }

  it("casual browsing keeps the cheap cached path", async () => {
    const calls = pluginReturning({ lat: 26.35, lon: -80.08, acc: 12, at: Date.now() });
    await getFix();
    expect(calls[0]).toMatchObject({ enableHighAccuracy: false, maximumAge: 600_000 });
  });

  it("a fresh request asks for high accuracy and a tiny cache age", async () => {
    const now = Date.now();
    const calls = pluginReturning({ lat: 26.35, lon: -80.08, acc: 12, at: now });
    const got = await getFreshFix({ nowMs: now });
    expect(calls[0]).toMatchObject({ enableHighAccuracy: true, maximumAge: FRESH_FIX_MAX_AGE_MS });
    expect(got).toEqual({ lat: 26.35, lon: -80.08, accuracyM: 12, at: now });
  });

  it("an eight-minute-old cached position cannot satisfy a fresh request", async () => {
    const now = Date.now();
    pluginReturning({ lat: 26.35, lon: -80.08, acc: 12, at: now - 8 * 60_000 });
    expect(await getFreshFix({ nowMs: now })).toEqual({ error: "stale" });
  });

  it("maps a native denial", async () => {
    nativeBridge({
      getCurrentPosition: async () => {
        throw { code: 1, message: "denied" };
      },
    });
    expect(await getFreshFix()).toEqual({ error: "denied" });
  });
});

describe("validateFreshFix", () => {
  const now = 1_800_000_000_000;
  const fix = { lat: 26.35, lon: -80.08, accuracyM: 10, at: now };

  it("accepts a fix inside the slack, rejects older, future-dated, or timestamp-less ones", () => {
    expect(validateFreshFix(fix, now)).toEqual(fix);
    expect(validateFreshFix({ ...fix, at: now - FRESH_FIX_ACCEPT_AGE_MS }, now)).toEqual({ ...fix, at: now - FRESH_FIX_ACCEPT_AGE_MS });
    expect(validateFreshFix({ ...fix, at: now - FRESH_FIX_ACCEPT_AGE_MS - 1 }, now)).toEqual({ error: "stale" });
    expect(validateFreshFix({ ...fix, at: now + FIX_MAX_FUTURE_SKEW_MS + 1 }, now)).toEqual({ error: "stale" });
    expect(validateFreshFix({ ...fix, at: NaN }, now)).toEqual({ error: "stale" });
  });
});

describe("the client's accuracy gate matches the server's", () => {
  it("FIX_MAX_ACCURACY_M is the same number on both sides (LOC-12)", () => {
    expect(FIX_MAX_ACCURACY_M).toBe(SERVER_FIX_MAX_ACCURACY_M);
    expect(ARRIVAL_MAX_FIX_AGE_MS).toBeLessThan(FIX_STALE_MS + 1);
  });
});
