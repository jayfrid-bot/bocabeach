// Unit tests for client.ts's pure dispatch-key helper, plus the module-level
// (non-hook) install-token bootstrap. useHazardsAtPoint and usePlus
// themselves are React hooks wired to fetch/effects (untested directly, per
// this repo's convention — see lib/plus/beachMode.ts's header);
// hazardsInputKey, bootstrapInstallToken, storeExpiryTimerMs, and
// readSuperseded are the plain-function pieces this file tests directly —
// including the store-expiry-timer arming decision (#2) and the read-vs-sync
// generation check (#6), both pulled out of usePlus itself for exactly this
// reason.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  bootstrapInstallToken,
  hazardsInputKey,
  readSuperseded,
  resetInstallTokenLatch,
  shouldBootstrapInstallTokenOnMount,
  STORE_EXPIRY_GRACE_MS,
  STORE_EXPIRY_TIMER_MAX_MS,
  storeExpiryTimerMs,
} from "@/lib/plus/client";
import type { Fix } from "@/lib/location/device";
import * as store from "@/lib/plus/storage";

const DEV = "device-1";

vi.mock("@/lib/deviceId", () => ({ getDeviceId: () => DEV }));

// Controllable per test (issue: usePlus's mount bootstrap must be native-only
// — a plain web visitor/crawler must never POST /api/devices just to mint an
// install token nothing on web needs).
const nativeCtl = vi.hoisted(() => ({ isNative: false }));
vi.mock("@/lib/push/native", () => ({
  isNativePlatform: () => nativeCtl.isNative,
  nativePlatform: () => (nativeCtl.isNative ? "ios" : "web"),
}));

const apiCtl = vi.hoisted(() => ({
  saveDevice: vi.fn(),
}));
vi.mock("@/lib/plus/api", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/plus/api")>();
  return {
    ...actual,
    plusApi: {
      ...actual.plusApi,
      saveDevice: apiCtl.saveDevice,
    },
  };
});

/** A minimal in-memory Storage — environment: "node" has no real one. */
function installFakeLocalStorage() {
  const map = new Map<string, string>();
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  } as Storage;
}

describe("bootstrapInstallToken", () => {
  beforeEach(() => {
    installFakeLocalStorage();
    apiCtl.saveDevice.mockReset();
    resetInstallTokenLatch();
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("returns the already-cached token with no network call at all", async () => {
    store.writeInstallToken("cached-token");
    const { token } = await bootstrapInstallToken();
    expect(token).toBe("cached-token");
    expect(apiCtl.saveDevice).not.toHaveBeenCalled();
  });

  it("a fresh device (no hash yet) mints on the plain POST /api/devices", async () => {
    apiCtl.saveDevice.mockImplementation(async () => {
      store.writeInstallToken("minted-token"); // what api.ts's request() does on a real response
      return { ok: true, device: { id: DEV }, error: null, status: 200 };
    });
    const { token } = await bootstrapInstallToken();
    expect(token).toBe("minted-token");
    expect(apiCtl.saveDevice).toHaveBeenCalledTimes(1);
  });

  it("a hash already exists server-side but this phone has nothing: resolves null, no recovery route to fall back to", async () => {
    apiCtl.saveDevice.mockResolvedValue({ ok: true, device: { id: DEV }, error: null, status: 200 }); // no installToken in the response
    const { token } = await bootstrapInstallToken();
    expect(token).toBeNull();
    expect(apiCtl.saveDevice).toHaveBeenCalledTimes(1);
  });

  it("latches 'no token' for the session after one empty mint response — later plain calls skip the network", async () => {
    apiCtl.saveDevice.mockResolvedValue({ ok: true, device: { id: DEV }, error: null, status: 200 });
    const first = await bootstrapInstallToken();
    expect(first.token).toBeNull();
    expect(apiCtl.saveDevice).toHaveBeenCalledTimes(1);

    // A second plain bootstrap this "session" must NOT hit the network again
    // — nothing about the answer changes moment to moment.
    const second = await bootstrapInstallToken();
    expect(second.token).toBeNull();
    expect(apiCtl.saveDevice).toHaveBeenCalledTimes(1); // still 1, not 2
  });

  it("forceRefresh clears a stale cached token and makes one real round trip; a repeat this session is latched", async () => {
    // A 401 says the cached token is bad — bootstrapInstallToken must not
    // just hand it straight back out.
    store.writeInstallToken("stale-token");
    apiCtl.saveDevice.mockResolvedValue({ ok: true, device: { id: DEV }, error: null, status: 200 }); // still no fresh token
    const first = await bootstrapInstallToken({ forceRefresh: true });
    expect(first.token).toBeNull();
    expect(store.readInstallToken()).toBeNull(); // the stale value was cleared, not just ignored
    expect(apiCtl.saveDevice).toHaveBeenCalledTimes(1);

    // Codex round-4 #4: a PERMANENTLY lost token must not POST on every
    // forced retry for the rest of the session — one forced refresh per
    // session, then latch, same as the plain path already does.
    const second = await bootstrapInstallToken({ forceRefresh: true });
    expect(second.token).toBeNull();
    expect(apiCtl.saveDevice).toHaveBeenCalledTimes(1); // still 1, not 2 — latched
  });

  it("forceRefresh that succeeds returns the fresh token", async () => {
    store.writeInstallToken("stale-token");
    apiCtl.saveDevice.mockImplementation(async () => {
      store.writeInstallToken("fresh-token");
      return { ok: true, device: { id: DEV }, error: null, status: 200 };
    });
    const { token } = await bootstrapInstallToken({ forceRefresh: true });
    expect(token).toBe("fresh-token");
  });

  it("a second forced refresh this session reuses the cache from the first, no second POST", async () => {
    store.writeInstallToken("stale-token");
    apiCtl.saveDevice.mockImplementation(async () => {
      store.writeInstallToken("fresh-token");
      return { ok: true, device: { id: DEV }, error: null, status: 200 };
    });
    const first = await bootstrapInstallToken({ forceRefresh: true });
    expect(first.token).toBe("fresh-token");
    expect(apiCtl.saveDevice).toHaveBeenCalledTimes(1);

    const second = await bootstrapInstallToken({ forceRefresh: true });
    expect(second.token).toBe("fresh-token"); // read back from cache, not re-minted
    expect(apiCtl.saveDevice).toHaveBeenCalledTimes(1); // no second round trip
  });

  it("overlapping callers dedupe into a single in-flight bootstrap", async () => {
    let resolveSave: (v: unknown) => void = () => {};
    apiCtl.saveDevice.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    const a = bootstrapInstallToken();
    const b = bootstrapInstallToken();
    resolveSave({ ok: true, device: { id: DEV }, error: null, status: 200 });
    await Promise.all([a, b]);
    expect(apiCtl.saveDevice).toHaveBeenCalledTimes(1);
  });
});

describe("shouldBootstrapInstallTokenOnMount", () => {
  afterEach(() => {
    nativeCtl.isNative = false;
  });

  it("is false on the web — a plain browser visitor never POSTs /api/devices to mint a token it has no use for", () => {
    nativeCtl.isNative = false;
    expect(shouldBootstrapInstallTokenOnMount()).toBe(false);
  });

  it("is true inside the native app — Live Activities and /api/hazards need the token", () => {
    nativeCtl.isNative = true;
    expect(shouldBootstrapInstallTokenOnMount()).toBe(true);
  });
});

function fix(over: Partial<Fix> = {}): Fix {
  return { lat: 26.3587, lon: -80.0686, accuracyM: 20, at: 1_000_000, ...over };
}

describe("hazardsInputKey", () => {
  it("differs with no fix vs. any fix", () => {
    expect(hazardsInputKey("boca-raton", null)).not.toBe(hazardsInputKey("boca-raton", fix()));
  });

  it("differs when the slug changes, fix held constant", () => {
    expect(hazardsInputKey("boca-raton", fix())).not.toBe(hazardsInputKey("delray-beach", fix()));
  });

  it("differs when the fix's timestamp changes", () => {
    expect(hazardsInputKey("boca-raton", fix())).not.toBe(hazardsInputKey("boca-raton", fix({ at: 1_000_001 })));
  });

  it("differs when lat/lon move by more than the rounding precision", () => {
    expect(hazardsInputKey("boca-raton", fix())).not.toBe(
      hazardsInputKey("boca-raton", fix({ lat: 26.4, lon: -80.1 })),
    );
  });

  it("is stable for the same slug + fix (rounded lat/lon)", () => {
    const a = hazardsInputKey("boca-raton", fix());
    const b = hazardsInputKey("boca-raton", fix({ lat: 26.3588, lon: -80.0685 })); // sub-0.01° jitter
    expect(a).toBe(b);
  });
});

describe("storeExpiryTimerMs", () => {
  const now = 1_000_000;

  it("arms for the time left until a store-based cache's end date, PLUS the grace period (L3)", () => {
    const cache = { plan: "plus" as const, until: now + 60_000, checkedAt: now };
    expect(storeExpiryTimerMs({ cache, storeBased: true, now })).toBe(60_000 + STORE_EXPIRY_GRACE_MS);
  });

  it("does not arm for a trial/code grant — self-heal has nothing to check for those", () => {
    const cache = { plan: "plus" as const, until: now + 60_000, checkedAt: now };
    expect(storeExpiryTimerMs({ cache, storeBased: false, now })).toBeNull();
  });

  it("does not arm with no cache, or a cache with no end date", () => {
    expect(storeExpiryTimerMs({ cache: null, storeBased: true, now })).toBeNull();
    const noEnd = { plan: "plus" as const, until: null, checkedAt: now };
    expect(storeExpiryTimerMs({ cache: noEnd, storeBased: true, now })).toBeNull();
  });

  it("still arms (shorter) for an end date that already passed but is still inside the grace window", () => {
    // RevenueCat may not have processed a renewal at the exact second it was
    // due (L3) — an end date a few seconds in the past still deserves a
    // (shorter) check, not silence until the next unrelated cache update.
    const cache = { plan: "plus" as const, until: now - 10_000, checkedAt: now };
    expect(storeExpiryTimerMs({ cache, storeBased: true, now })).toBe(STORE_EXPIRY_GRACE_MS - 10_000);
  });

  it("does not arm once even the grace window is behind us — nothing left to wait for", () => {
    const cache = { plan: "plus" as const, until: now - STORE_EXPIRY_GRACE_MS - 1, checkedAt: now };
    expect(storeExpiryTimerMs({ cache, storeBased: true, now })).toBeNull();
  });

  it("does not arm past the 24h cap — the effect re-checks on the next cache update instead", () => {
    const justOver = {
      plan: "plus" as const,
      until: now + STORE_EXPIRY_TIMER_MAX_MS - STORE_EXPIRY_GRACE_MS + 1,
      checkedAt: now,
    };
    expect(storeExpiryTimerMs({ cache: justOver, storeBased: true, now })).toBeNull();

    const justUnder = {
      plan: "plus" as const,
      until: now + STORE_EXPIRY_TIMER_MAX_MS - STORE_EXPIRY_GRACE_MS,
      checkedAt: now,
    };
    expect(storeExpiryTimerMs({ cache: justUnder, storeBased: true, now })).toBe(STORE_EXPIRY_TIMER_MAX_MS);
  });
});

describe("readSuperseded", () => {
  it("is false when no sync started after the read began", () => {
    expect(readSuperseded(3, 3)).toBe(false);
  });

  it("is true once a sync has bumped the generation past the read's own", () => {
    // A refresh() read captures generation 3 at dispatch; a purchase/restore
    // sync starts (and bumps to 4) while that read is still in flight — its
    // eventual answer must not overwrite what the sync applies (#6).
    expect(readSuperseded(3, 4)).toBe(true);
  });
});
