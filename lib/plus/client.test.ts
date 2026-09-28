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
  clearPurchaseSyncQueue,
  hazardsInputKey,
  peekPurchaseSyncRetryState,
  PURCHASE_SYNC_MAX_AGE_MS,
  PURCHASE_SYNC_MAX_ATTEMPTS,
  purchaseSyncRetryExhausted,
  purchaseSyncRetryOutcome,
  readSuperseded,
  resetInstallTokenLatch,
  resetPurchaseSyncRetryState,
  setPurchaseSyncRetryStateForTest,
  createSunColorSaver,
  overlayPendingSunColor,
  isStaleDeviceResponse,
  shouldBootstrapInstallTokenOnMount,
  startVisibleReconcileLoop,
  STORE_EXPIRY_GRACE_MS,
  STORE_EXPIRY_TIMER_MAX_MS,
  storeExpiryTimerMs,
  VISIBLE_RECONCILE_MS,
} from "@/lib/plus/client";
import type { SunColorPatch } from "@/lib/plus/client";
import type { PlusResult } from "@/lib/plus/api";
import type { DeviceRecord } from "@/lib/db/types";
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

function fakeDevice(over: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    id: DEV,
    updatedAt: 0,
    platform: "ios",
    tz: null,
    homeSlug: null,
    profile: null,
    prefs: {},
    plan: "free",
    entitlementUntil: null,
    grants: {},
    trialUsed: false,
    previewSeen: false,
    presence: null,
    ...over,
  } as unknown as DeviceRecord;
}

// Codex review #1: flushPending must only clear the queued purchaseSync flag
// on a CONFIRMED entitlement — a 200 that still isn't entitled (RevenueCat
// hasn't caught up yet) has to read exactly like a network failure, not like
// "resolved". Both pulled out of the flush loop as plain functions per this
// file's no-hook-rendering convention (see header).
describe("purchaseSyncRetryOutcome", () => {
  const now = 1_000_000;

  it("clears once the synced device is entitled right now", () => {
    const res: PlusResult = { ok: true, device: fakeDevice({ plan: "plus", entitlementUntil: now + 60_000 }), error: null, status: 200 };
    expect(purchaseSyncRetryOutcome(res, now)).toBe("clear");
  });

  it("keeps it when the response is ok but the device still isn't entitled yet", () => {
    const res: PlusResult = { ok: true, device: fakeDevice({ plan: "free", entitlementUntil: null }), error: null, status: 200 };
    expect(purchaseSyncRetryOutcome(res, now)).toBe("keep");
  });

  it("keeps it when the response is ok but the entitlement already lapsed", () => {
    const res: PlusResult = { ok: true, device: fakeDevice({ plan: "plus", entitlementUntil: now - 1 }), error: null, status: 200 };
    expect(purchaseSyncRetryOutcome(res, now)).toBe("keep");
  });

  it("keeps it on a retryable failure (network or 5xx)", () => {
    expect(purchaseSyncRetryOutcome({ ok: false, device: null, error: "network", status: 0 }, now)).toBe("keep");
    expect(purchaseSyncRetryOutcome({ ok: false, device: null, error: "server", status: 500 }, now)).toBe("keep");
  });

  it("clears on a non-retryable rejection — the server's final word", () => {
    expect(purchaseSyncRetryOutcome({ ok: false, device: null, error: "not-found", status: 404 }, now)).toBe("clear");
  });
});

/** A patch's own label — tags the fake device `send` resolves with, so a
 *  test can tell which patch's response actually got applied. */
function label(patch: SunColorPatch): string {
  return JSON.stringify(patch);
}

describe("createSunColorSaver (Requirement round-3 item 2 — one queue for both fields)", () => {
  /** A saver over a tiny in-memory "pending" box and a controllable `send`
   *  — real timers (not fake ones) drive actual request ordering, same
   *  pattern lib/plus/liveActivity.test.ts's own createSerialQueue tests
   *  use, since createSerialQueue's ordering is about real promise
   *  settlement, not a mocked clock. */
  function harness(respond: (patch: SunColorPatch) => Promise<PlusResult> | PlusResult) {
    const sendCalls: SunColorPatch[] = [];
    const applied: unknown[] = [];
    let pending: SunColorPatch = {};
    const saver = createSunColorSaver({
      send: async (patch) => {
        sendCalls.push(patch);
        return respond(patch);
      },
      currentPending: () => pending,
      queuePending: (patch) => {
        pending = { ...pending, ...patch };
      },
      clearPendingIfMatch: (patch) => {
        const next = { ...pending };
        for (const k of Object.keys(patch) as (keyof SunColorPatch)[]) {
          if (next[k] === patch[k]) delete next[k];
        }
        pending = next;
      },
      apply: (res) => applied.push(res.device),
    });
    return {
      saver,
      sendCalls,
      applied,
      pending: () => pending,
      setPending: (p: SunColorPatch) => {
        pending = p;
      },
    };
  }

  it("(a) offline failure queues the patch; a later live edit that succeeds clears it and wins", async () => {
    const h = harness(async (patch) =>
      patch.minBand === "epic"
        ? { ok: false, device: null, error: "network", status: 0 }
        : { ok: true, device: fakeDevice({ id: label(patch) }), error: null, status: 200 },
    );
    const reverted: string[] = [];

    await h.saver({ minBand: "epic" }, () => reverted.push("epic"));
    expect(h.pending()).toEqual({ minBand: "epic" });
    expect(reverted).toEqual(["epic"]);

    await h.saver({ minBand: "vivid" }, () => reverted.push("vivid"));
    expect(h.pending()).toEqual({});
    expect(h.applied).toEqual([fakeDevice({ id: label({ minBand: "vivid" }) })]);
    expect(h.sendCalls).toEqual([{ minBand: "epic" }, { minBand: "vivid" }]);
  });

  it("(b) two fast edits A then B: exactly two requests, strictly in order, both applied in order — B ends up on top", async () => {
    const h = harness(async (patch) => {
      await new Promise((r) => setTimeout(r, 5));
      return { ok: true, device: fakeDevice({ id: label(patch) }), error: null, status: 200 };
    });
    const reverted: string[] = [];

    const pA = h.saver({ minBand: "epic" }, () => reverted.push("A"));
    const pB = h.saver({ minBand: "vivid" }, () => reverted.push("B"));
    await Promise.all([pA, pB]);

    // createSerialQueue never starts B's `send` until A's has fully
    // settled — exactly two requests, strictly in submission order.
    expect(h.sendCalls).toEqual([{ minBand: "epic" }, { minBand: "vivid" }]);
    // Round-3 item 2: `apply` fires UNGATED on every success — A's included
    // — because staleness protection now lives entirely in `applyDevice`'s
    // pending-overlay (see the `overlayPendingSunColor` tests below), not
    // here. Both land, strictly in order, so the real hook's last-applied
    // state is always B's.
    expect(h.applied).toEqual([fakeDevice({ id: label({ minBand: "epic" }) }), fakeDevice({ id: label({ minBand: "vivid" }) })]);
    expect(reverted).toEqual([]); // neither failed, so neither reverts
    expect(h.pending()).toEqual({});
  });

  it("(c) a retry of a stale queued patch in flight when a live edit arrives — both are sent, strictly in order", async () => {
    const h = harness(async (patch) => {
      await new Promise((r) => setTimeout(r, 5));
      return { ok: true, device: fakeDevice({ id: label(patch) }), error: null, status: 200 };
    });
    h.setPending({ minBand: "epic" }); // a stale value already queued from an earlier failure

    const retry = h.saver({ minBand: "epic" }, () => {}); // flushPending replaying the stale value
    const edit = h.saver({ minBand: "vivid" }, () => {}); // a live edit arriving while the retry is in flight
    await Promise.all([retry, edit]);

    expect(h.sendCalls).toEqual([{ minBand: "epic" }, { minBand: "vivid" }]);
    expect(h.applied).toEqual([fakeDevice({ id: label({ minBand: "epic" }) }), fakeDevice({ id: label({ minBand: "vivid" }) })]);
    expect(h.pending()).toEqual({});
  });

  it("a stale RETRYABLE failure never reverts past a newer edit's own optimistic state", async () => {
    const h = harness(async (patch) => {
      await new Promise((r) => setTimeout(r, 5));
      return patch.minBand === "epic"
        ? { ok: false, device: null, error: "network", status: 0 }
        : { ok: true, device: fakeDevice({ id: label(patch) }), error: null, status: 200 };
    });
    const reverted: string[] = [];
    const pA = h.saver({ minBand: "epic" }, () => reverted.push("A")); // will fail
    const pB = h.saver({ minBand: "vivid" }, () => reverted.push("B")); // will succeed, and by then owns the field
    await Promise.all([pA, pB]);

    expect(reverted).toEqual([]); // A's failure is suppressed — B already superseded it
    expect(h.applied).toEqual([fakeDevice({ id: label({ minBand: "vivid" }) })]);
  });

  it("an outright rejection (4xx) still clears the pending queue even when superseded-checked as current", async () => {
    const h = harness(async () => ({ ok: false, device: null, error: "bad-request", status: 400 }));
    const reverted: string[] = [];
    await h.saver({ minBand: "epic" }, () => reverted.push("epic"));
    expect(reverted).toEqual(["epic"]);
    expect(h.pending()).toEqual({}); // dropped — retrying would only repeat the same rejection
  });

  it("round-3: a single patch carrying both fields at once is sent as one request", async () => {
    const h = harness(async (patch) => ({ ok: true, device: fakeDevice({ id: label(patch) }), error: null, status: 200 }));
    await h.saver({ minBand: "epic", leadMin: 30 }, () => {});
    expect(h.sendCalls).toEqual([{ minBand: "epic", leadMin: 30 }]);
    expect(h.pending()).toEqual({});
  });

  // Round-3 item 2's own required test, end to end: a two-field edit
  // sequence (one call per field, fired moments apart) sends exactly two
  // requests, strictly in order, on the SAME shared queue, and the final
  // LOCAL device state — computed the same way `applyDevice` computes it,
  // via `overlayPendingSunColor` on top of each response — has BOTH new
  // values. This harness wires `apply` to actually simulate `applyDevice`'s
  // own overlay step (rather than just recording raw responses like the
  // harness above), so it's the closest thing to an integration test this
  // file's no-hook-rendering convention allows.
  it("round-3: two-field edit sequence — two requests strictly in order, final local state has both new values", async () => {
    const sendCalls: SunColorPatch[] = [];
    let pending: SunColorPatch = {};
    let deviceState = fakeDevice({ sunColor: { minBand: "vivid", leadMin: 60 } } as Partial<DeviceRecord>);
    const saver = createSunColorSaver({
      send: async (patch) => {
        sendCalls.push(patch);
        await new Promise((r) => setTimeout(r, 5));
        // The server's own response reflects only what IT knew at that
        // moment — its view of the OTHER field may already be stale by the
        // time this resolves, same as any real round trip.
        return { ok: true, device: { ...deviceState, sunColor: { ...deviceState.sunColor, ...patch } }, error: null, status: 200 };
      },
      currentPending: () => pending,
      queuePending: (patch) => {
        pending = { ...pending, ...patch };
      },
      clearPendingIfMatch: (patch) => {
        const next = { ...pending };
        for (const k of Object.keys(patch) as (keyof SunColorPatch)[]) {
          if (next[k] === patch[k]) delete next[k];
        }
        pending = next;
      },
      apply: (res) => {
        if (res.device) deviceState = overlayPendingSunColor(res.device, pending);
      },
    });

    const p1 = saver({ minBand: "epic" }, () => {});
    const p2 = saver({ leadMin: 120 }, () => {});
    await Promise.all([p1, p2]);

    expect(sendCalls).toEqual([{ minBand: "epic" }, { leadMin: 120 }]);
    expect(pending).toEqual({});
    expect(deviceState.sunColor).toEqual({ minBand: "epic", leadMin: 120 });
  });
});

// Round-3 item 2's other half: `applyDevice` overlays any still-pending
// sun-color field on top of EVERY response it adopts, so an unrelated
// response (an older save, a prefs toggle) can never visibly revert an edit
// that's still being saved. `overlayPendingSunColor` is the pure piece of
// that logic `applyDevice` itself calls — tested directly here rather than
// through the hook, per this file's convention.
describe("overlayPendingSunColor (Requirement round-3 item 2 — preserve pending on apply)", () => {
  it("leaves the record untouched when nothing is pending", () => {
    const rec = fakeDevice({ sunColor: { minBand: "vivid", leadMin: 60 } } as Partial<DeviceRecord>);
    expect(overlayPendingSunColor(rec, undefined)).toBe(rec);
    expect(overlayPendingSunColor(rec, {})).toBe(rec);
  });

  it("overlays a pending field on top of the server's own value for that field", () => {
    const rec = fakeDevice({ sunColor: { minBand: "vivid", leadMin: 60 } } as Partial<DeviceRecord>);
    const merged = overlayPendingSunColor(rec, { minBand: "epic" });
    expect(merged.sunColor).toEqual({ minBand: "epic", leadMin: 60 });
  });

  it("a prefs-toggle response (unrelated to sun-color) arriving mid-save must not revert the pending sun-color field", () => {
    // The server's own response after a prefs toggle still carries a
    // sunColor snapshot — but it's whatever was true BEFORE this save
    // started, since the toggle and the sun-color edit raced independently.
    const staleServerSunColor = { minBand: "vivid" as const, leadMin: 60 };
    const prefsToggleResponse = fakeDevice({
      prefs: { morning: true },
      sunColor: staleServerSunColor,
    } as Partial<DeviceRecord>);

    const pendingFromInFlightSave: SunColorPatch = { minBand: "epic" }; // still saving, not yet confirmed
    const applied = overlayPendingSunColor(prefsToggleResponse, pendingFromInFlightSave);

    expect(applied.sunColor).toEqual({ minBand: "epic", leadMin: 60 }); // NOT reverted to "vivid"
    expect(applied.prefs).toEqual({ morning: true }); // the toggle's own change still lands
  });

  it("overlays both fields when both are pending", () => {
    const rec = fakeDevice({ sunColor: { minBand: "vivid", leadMin: 60 } } as Partial<DeviceRecord>);
    const merged = overlayPendingSunColor(rec, { minBand: "epic", leadMin: 120 });
    expect(merged.sunColor).toEqual({ minBand: "epic", leadMin: 120 });
  });
});

// Round-4 item 3: response ARRIVAL order isn't request order — two
// overlapping requests for the same device can resolve either way round.
// `isStaleDeviceResponse` is the pure gate `applyDevice` runs every response
// through FIRST (before the round-3 item 2 pending overlay even runs): a
// response older, by its own server-stamped `updatedAt`, than one already
// applied for this device id is ignored outright.
describe("isStaleDeviceResponse (Requirement round-4 item 3 — response revisioning)", () => {
  it("is never stale the first time a device id is seen (no watermark yet)", () => {
    expect(isStaleDeviceResponse({ id: DEV, updatedAt: 100 }, new Map())).toBe(false);
  });

  it("is stale when strictly older than the tracked watermark for this device id", () => {
    const lastApplied = new Map([[DEV, 200]]);
    expect(isStaleDeviceResponse({ id: DEV, updatedAt: 100 }, lastApplied)).toBe(true);
  });

  // Round-5 item 1: equal now counts as stale too (rejects `<=`, not just
  // `<`) — the server guarantees `updated_at` is strictly monotonic per row,
  // so an EQUAL value can only describe the SAME write this phone already
  // applied, never a genuinely different one that happened to share a
  // wall-clock reading.
  it("is stale when EQUAL to the tracked watermark; NOT stale when strictly newer", () => {
    const lastApplied = new Map([[DEV, 200]]);
    expect(isStaleDeviceResponse({ id: DEV, updatedAt: 200 }, lastApplied)).toBe(true);
    expect(isStaleDeviceResponse({ id: DEV, updatedAt: 201 }, lastApplied)).toBe(false);
  });

  it("a watermark for a DIFFERENT device id never gates this one", () => {
    const lastApplied = new Map([["some-other-device", 999]]);
    expect(isStaleDeviceResponse({ id: DEV, updatedAt: 1 }, lastApplied)).toBe(false);
  });

  // The exact scenario the review named: a sun-color save succeeds and
  // applies (updatedAt t2, and its pending entry clears); a prefs response
  // issued EARLIER (updatedAt t1 < t2) but resolving LATER arrives after
  // that — it must not be applied, so the sun-color settings stay at their
  // new values. Built as a small harness that composes the two pieces
  // `applyDevice` itself composes (the revisioning gate, then the round-3
  // item 2 pending overlay) exactly the way `applyDevice` does, without
  // rendering the hook.
  it("a delayed OLDER prefs response arriving after a NEWER sun-color save must not be applied — settings stay at the new values", () => {
    const lastApplied = new Map<string, number>();
    let deviceState = fakeDevice({ sunColor: { minBand: "vivid", leadMin: 60 }, prefs: { morning: false } } as Partial<DeviceRecord>);
    let pending: SunColorPatch = {};

    function applyDeviceLike(rec: DeviceRecord): void {
      if (isStaleDeviceResponse(rec, lastApplied)) return; // round-4 item 3
      lastApplied.set(rec.id, rec.updatedAt);
      deviceState = overlayPendingSunColor(rec, pending); // round-3 item 2
    }

    const T1 = 1_000; // the prefs-toggle request's own server-side write time
    const T2 = 2_000; // the sun-color save's own server-side write time (later)

    // The sun-color save is in flight: queue its pending value, same as
    // `createSunColorSaver` does synchronously before its request starts.
    pending = { minBand: "epic" };

    // It resolves FIRST (server processed it after the prefs toggle, and
    // its response also arrives first): applies cleanly, watermark -> T2.
    applyDeviceLike(
      fakeDevice({ id: DEV, updatedAt: T2, sunColor: { minBand: "epic", leadMin: 60 }, prefs: { morning: false } } as Partial<DeviceRecord>),
    );
    pending = {}; // the save's own clearPendingIfMatch, now that it's confirmed
    expect(deviceState.sunColor).toEqual({ minBand: "epic", leadMin: 60 });

    // NOW the earlier prefs-toggle request's response finally arrives —
    // older `updatedAt`, and pending has already cleared, so nothing about
    // round-3's overlay would have protected against it either.
    applyDeviceLike(
      fakeDevice({ id: DEV, updatedAt: T1, sunColor: { minBand: "vivid", leadMin: 60 }, prefs: { morning: true } } as Partial<DeviceRecord>),
    );

    // Ignored outright — the sun-color settings (AND everything else) stay
    // exactly as the newer response left them.
    expect(deviceState.sunColor).toEqual({ minBand: "epic", leadMin: 60 });
    expect(deviceState.prefs).toEqual({ morning: false });
  });

  // Round-6 regression: setPresence/clearPresence used to leave the OWNING
  // device row's `updated_at` untouched (only the separate `presence` table
  // changed) — so an arm or disarm response carried the SAME `updatedAt` as
  // whatever the phone had already applied, and the strict `<=` rejection
  // (round-5 item 1) dropped it outright, leaving the UI stuck on stale
  // armed/disarmed state. Now that every write that changes what a
  // `DeviceRecord` carries also bumps the owning row's revision
  // (lib/db/d1Store.ts's setPresence/clearPresence, in the SAME batch;
  // memoryStore's mirrored `touchDevice`), this whole sequence must adopt
  // cleanly. Same `applyDeviceLike` composition as the test above.
  it("refresh (rev N) -> arm (rev N+1) -> disarm (rev N+2): all three responses adopt, presence shows unarmed -> armed -> unarmed", () => {
    const lastApplied = new Map<string, number>();
    let deviceState: DeviceRecord | null = null;

    function applyDeviceLike(rec: DeviceRecord): void {
      if (isStaleDeviceResponse(rec, lastApplied)) return;
      lastApplied.set(rec.id, rec.updatedAt);
      deviceState = overlayPendingSunColor(rec, {});
    }

    const N = 1_000;

    // 1) The initial refresh() read — not yet armed.
    applyDeviceLike(fakeDevice({ id: DEV, updatedAt: N, presence: null } as Partial<DeviceRecord>));
    expect(deviceState!.presence).toBeNull();

    // 2) arm() — setPresence's own write bumped devices.updated_at to N+1
    // (round-6's fix) alongside the presence row, so this response is
    // strictly newer, not equal — it must be adopted, not dropped.
    applyDeviceLike(
      fakeDevice({
        id: DEV,
        updatedAt: N + 1,
        presence: { slug: "boca-raton", armedUntil: N + 3600_000, source: "manual", hasFix: false },
      } as Partial<DeviceRecord>),
    );
    expect(deviceState!.presence).not.toBeNull();
    expect(deviceState!.presence?.slug).toBe("boca-raton");

    // 3) disarm() — clearPresence's own write bumps devices.updated_at
    // again, to N+2.
    applyDeviceLike(fakeDevice({ id: DEV, updatedAt: N + 2, presence: null } as Partial<DeviceRecord>));
    expect(deviceState!.presence).toBeNull();

    // The watermark tracked every step — nothing was silently dropped.
    expect(lastApplied.get(DEV)).toBe(N + 2);
  });

  // What the round-6 bug actually looked like: an arm response carrying the
  // SAME `updatedAt` as the read that preceded it (the pre-fix behavior,
  // since setPresence never touched `devices.updated_at`) is correctly
  // rejected by the strict `<=` check — proving that fix (round-5 item 1) is
  // exactly why round-6's OWN fix (bumping the owning row) was necessary.
  it("without the owning-row bump, an arm response reusing the prior revision would have been dropped", () => {
    const lastApplied = new Map([[DEV, 1_000]]);
    const armResponseAtSameRevision = { id: DEV, updatedAt: 1_000 }; // the pre-fix shape
    expect(isStaleDeviceResponse(armResponseAtSameRevision, lastApplied)).toBe(true);
  });
});

describe("purchaseSyncRetryExhausted", () => {
  const since = 1_000_000;

  it("is not exhausted with attempts and age both under budget", () => {
    expect(purchaseSyncRetryExhausted({ since, attempts: PURCHASE_SYNC_MAX_ATTEMPTS - 1 }, since + 1_000)).toBe(
      false,
    );
  });

  it("is exhausted once attempts reach the cap", () => {
    expect(purchaseSyncRetryExhausted({ since, attempts: PURCHASE_SYNC_MAX_ATTEMPTS }, since + 1_000)).toBe(true);
  });

  it("is exhausted once the age cap passes, even with attempts to spare", () => {
    expect(purchaseSyncRetryExhausted({ since, attempts: 1 }, since + PURCHASE_SYNC_MAX_AGE_MS)).toBe(true);
  });
});

// Codex round 2 #3: syncPurchase, restore, and flushPending must all clear
// the retry budget together with the pending flag — a stale attempts/since
// pair left over from an episode that already resolved must not make a
// later, unrelated one look prematurely exhausted.
describe("clearPurchaseSyncQueue", () => {
  beforeEach(() => {
    installFakeLocalStorage();
    resetPurchaseSyncRetryState();
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    resetPurchaseSyncRetryState();
  });

  it("drops both the persisted pending flag and the in-memory retry budget", () => {
    store.queuePendingPurchaseSync();
    setPurchaseSyncRetryStateForTest({ since: 1_000_000, attempts: 3 });
    expect(store.readPending().purchaseSync).toBeTruthy();
    expect(peekPurchaseSyncRetryState()).not.toBeNull();

    clearPurchaseSyncQueue();

    expect(store.readPending().purchaseSync).toBeUndefined();
    expect(peekPurchaseSyncRetryState()).toBeNull();
  });

  it("is a no-op-safe reset when nothing was queued or spent yet", () => {
    expect(() => clearPurchaseSyncQueue()).not.toThrow();
    expect(peekPurchaseSyncRetryState()).toBeNull();
  });
});

describe("startVisibleReconcileLoop", () => {
  function fakeDoc(initial: "visible" | "hidden" = "visible") {
    let visibilityState: "visible" | "hidden" = initial;
    const listeners = new Set<() => void>();
    return {
      get visibilityState() {
        return visibilityState;
      },
      set(v: "visible" | "hidden") {
        visibilityState = v;
        for (const l of listeners) l();
      },
      addEventListener: (_type: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_type: string, fn: () => void) => listeners.delete(fn),
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reconciles every VISIBLE_RECONCILE_MS while the document stays visible", () => {
    const doc = fakeDoc("visible");
    const reconcile = vi.fn();
    startVisibleReconcileLoop(reconcile, doc as unknown as Document);
    expect(reconcile).not.toHaveBeenCalled();
    vi.advanceTimersByTime(VISIBLE_RECONCILE_MS);
    expect(reconcile).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(VISIBLE_RECONCILE_MS * 2);
    expect(reconcile).toHaveBeenCalledTimes(3);
  });

  it("does not start a timer at all while hidden", () => {
    const doc = fakeDoc("hidden");
    const reconcile = vi.fn();
    startVisibleReconcileLoop(reconcile, doc as unknown as Document);
    vi.advanceTimersByTime(VISIBLE_RECONCILE_MS * 5);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("pauses on hide and resumes (fresh interval, not a backlog) on show", () => {
    const doc = fakeDoc("visible");
    const reconcile = vi.fn();
    startVisibleReconcileLoop(reconcile, doc as unknown as Document);
    vi.advanceTimersByTime(VISIBLE_RECONCILE_MS / 2);
    doc.set("hidden");
    // Backgrounded for a long time — none of it should count once resumed.
    vi.advanceTimersByTime(VISIBLE_RECONCILE_MS * 10);
    expect(reconcile).not.toHaveBeenCalled();
    doc.set("visible");
    vi.advanceTimersByTime(VISIBLE_RECONCILE_MS - 1);
    expect(reconcile).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("cleanup stops the timer and drops the listener", () => {
    const doc = fakeDoc("visible");
    const reconcile = vi.fn();
    const stop = startVisibleReconcileLoop(reconcile, doc as unknown as Document);
    stop();
    vi.advanceTimersByTime(VISIBLE_RECONCILE_MS * 5);
    expect(reconcile).not.toHaveBeenCalled();
  });
});
