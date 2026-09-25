"use client";

// The Plus client: one hook for "what is this phone entitled to and what does it
// like" (`usePlus`), one for "what is today worth to THIS person"
// (`usePersonalScore`), and one for the device fix everything location-shaped
// shares (`useDeviceFix`).
//
// Everything durable lives in lib/plus/storage.ts and every network call in
// lib/plus/api.ts, both pure and unit-tested. What is left here is React glue:
// state, effects, debouncing.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getDeviceId } from "@/lib/deviceId";
import {
  ARRIVAL_MAX_FIX_AGE_MS,
  checkLocationPermission,
  getFix,
  getFreshFix,
  shouldRefreshFix,
  type Fix,
} from "@/lib/location/device";
import { isNativePlatform, nativePlatform } from "@/lib/push/native";
import { defaultPrefs, type AlertKey, type AlertPrefs, type DeviceRecord } from "@/lib/db/types";
import { resolveScoring } from "@/lib/profile/resolve";
import type { ScoreProfile } from "@/lib/profile/types";
import type { ConditionsResponse, LocationPublic } from "@/lib/types";
import type { HazardAssessment } from "@/lib/hazards/assess";
import { plusApi, type PlusResult, type PresenceBody } from "@/lib/plus/api";
import { billingAvailable, restoreBilling } from "@/lib/plus/billing";
import { cacheFromDevice, deviceEntitled, isEntitled, isStoreBased, shouldSelfHeal } from "@/lib/plus/entitlement";
import { isRetryableSaveError } from "@/lib/plus/pendingWrites";
import { computePersonalScore, type PersonalScore } from "@/lib/plus/personalScore";
import { establishesArrival } from "@/lib/plus/beachMode";
import * as store from "@/lib/plus/storage";
import type { PlusCache, PreviewRecord } from "@/lib/plus/types";
import { holdReload } from "@/lib/reloadGuard";

/** Never ask the server twice inside this window on foreground. */
const REFRESH_THROTTLE_MS = 60_000;
/** How long a profile edit sits before it is written to the server. */
const PROFILE_SAVE_DEBOUNCE_MS = 600;
/** How long an Advanced edit sits before the score is recomputed. */
const SCORE_DEBOUNCE_MS = 150;
/** Cap on the store-expiry timer below — nothing needs to sit armed for
 *  days; a grant further out than this re-arms on the next cache update. */
export const STORE_EXPIRY_TIMER_MAX_MS = 24 * 60 * 60 * 1000;
/** Wait this long past the cached end date before asking — RevenueCat may
 *  not have finished processing a renewal at the exact second it was due,
 *  so firing right on time risks asking a beat too early (L3). */
export const STORE_EXPIRY_GRACE_MS = 90_000;
/** One guarded, one-shot retry after a restore that reached the store but
 *  not our own server (#M2) — quick enough to catch a transient hiccup
 *  without making someone wait for the next foreground/online flush. */
const RESTORE_RETRY_MS = 10_000;

/**
 * How long to wait before asking the server again because a STORE-based
 * entitlement's cached end date has passed (plus the grace above) — or null
 * when there is nothing worth arming a timer for (not store-based, no end
 * date on file, past even the grace window, or far enough out that the
 * effect will simply re-check next time the cache updates). Pure, so the
 * "when do we arm" decision is tested directly rather than through a
 * rendered hook (see this file's test header).
 */
export function storeExpiryTimerMs(input: {
  cache: PlusCache | null;
  storeBased: boolean;
  now: number;
}): number | null {
  const { cache, storeBased, now } = input;
  if (!storeBased || !cache || cache.until == null) return null;
  const ms = cache.until + STORE_EXPIRY_GRACE_MS - now;
  if (ms <= 0 || ms > STORE_EXPIRY_TIMER_MAX_MS) return null;
  return ms;
}

/** Whether a device READ that began when the generation counter read
 *  `startGeneration` is now superseded by a purchase/restore SYNC that
 *  started (bumping the counter) after it did — see `usePlus`'s `refresh`
 *  vs `syncPurchase`/`restore` (#6: a slow read must never overwrite what a
 *  faster, later sync already applied, however the two responses land). */
export function readSuperseded(startGeneration: number, currentGeneration: number): boolean {
  return currentGeneration !== startGeneration;
}

export interface PlusState {
  /** The phone has been read. Everything below is meaningless until this is true. */
  ready: boolean;
  entitled: boolean;
  /** A server call is in flight. */
  loading: boolean;
  /** The device row itself has been fetched at least once this session — the
   *  entitlement cache can render before this, but prefs/presence/home have no
   *  client cache of their own and read as fabricated defaults until this is
   *  true. */
  deviceLoaded: boolean;
  device: DeviceRecord | null;
  profile: ScoreProfile | null;
  prefs: AlertPrefs;
  /** Alert keys with an edit that failed to save and is waiting to retry. */
  pendingPrefsKeys: AlertKey[];
  previewSeen: boolean;
  preview: PreviewRecord | null;
  cache: PlusCache | null;
  deviceId: string;
  refresh(opts?: { forceSelfHeal?: boolean }): Promise<PlusResult | null>;
  /** Store restore (when billing is on) then the server's copy of this device. */
  restore(): Promise<PlusResult>;
  startTrial(): Promise<PlusResult>;
  unlock(code: string): Promise<PlusResult>;
  /** After a store purchase: the server confirms it with RevenueCat and turns Plus on. */
  syncPurchase(): Promise<PlusResult>;
  /** Local now, server shortly after. For sliders and chips. */
  saveProfile(profile: ScoreProfile): void;
  /** Local now, server before this resolves. For the reveal and the paywall. */
  commitProfile(profile: ScoreProfile, previewSeen?: boolean): Promise<PlusResult>;
  savePrefs(patch: Partial<AlertPrefs>): Promise<PlusResult>;
  setHome(slug: string): Promise<PlusResult>;
  savePreview(record: PreviewRecord): void;
  /** Beach Mode on — the window in which alerts use this phone's own position. */
  arm(presence: PresenceBody): Promise<PlusResult>;
  disarm(): Promise<PlusResult>;
  /**
   * Round-2 #1/#2: return this phone's install token, minting one first if
   * it doesn't have one cached (there is no server-side recovery route —
   * see `bootstrapInstallToken`'s doc). Every caller that needs the
   * token for something that REQUIRES it server-side (Beach Mode's Live
   * Activity start, and — indirectly, since the plugin reads it itself —
   * the native register/end uploads) must await this FIRST rather than read
   * `readInstallToken()` directly, so a device that simply never happened to
   * POST /api/devices before (most devices: `saveDevice` only fires on an
   * actual edit) gets bootstrapped on demand instead of silently having no
   * token forever.
   *
   * Two outcomes, in order:
   *  1. Already have one cached → return it, no network call.
   *  2. No hash minted yet at all (a genuinely fresh device) → POST
   *     /api/devices (the existing upsert; harmless to call with no other
   *     fields) mints one and this returns it.
   *
   * There is no server-side recovery for a device that already has a hash
   * on file but lost its own copy — see lib/db/installTokenAuth.ts's THREAT
   * MODEL comment. That case (and a stale/wrong cached token) is handled by
   * `bootstrapInstallToken`'s `forceRefresh` option, used by the 401 retry
   * path below rather than by this cache-preferring wrapper.
   *
   * Resolves null (never throws) when nothing produced a token — the
   * caller's job is to treat that as "not available right now", same as an
   * offline network.
   */
  ensureInstallToken(): Promise<string | null>;
}

/** Fields every write carries, so the server always knows how to reach us. */
function baseFields(): { platform: "ios" | "android" | "web"; tz?: string } {
  let tz: string | undefined;
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    tz = undefined;
  }
  return { platform: nativePlatform(), ...(tz ? { tz } : {}) };
}

// --- Install token bootstrap ------------------------------------------------
//
// Module-scope, not tied to any one hook instance, so every caller that needs
// a token around the same moment — the mount effect below, Beach Mode's
// start(), and useHazardsAtPoint's 401 retry further down — dedupes into the
// SAME in-flight request instead of racing separate mints.
//
// Two outcomes:
//  1. Already cached → returned immediately, no network call (unless the
//     caller passes `forceRefresh: true` — see below).
//  2. No hash minted yet at all (a genuinely fresh device) → the ordinary
//     POST /api/devices upsert mints one on this, its first call ever.
//
// There is no server-side recovery for a device that already has a hash on
// file but has lost its own copy (see lib/db/installTokenAuth.ts's THREAT
// MODEL comment) — POST /api/devices simply answers with no token in that
// case (the mint is exactly-once), and this resolves `{ token: null, ... }`.
// Never throws; every caller treats a null token as "not available right
// now", same as offline.
//
// `forceRefresh` (Codex round-3 fix): a caller that just got a `no-token`
// 401 — meaning the server does NOT recognize whatever token this phone has
// cached, whether that's stale, wrong, or simply gone server-side — must not
// let outcome 1 above hand that same bad token straight back out on retry.
// `forceRefresh: true` clears the cached token first, then always makes the
// POST /api/devices round trip (bypassing both the cache check and the
// session latch below) so the retry is a real question to the server, not a
// replay of what just failed. If that round trip still doesn't produce a
// token, this latches "no token available" for the rest of the session —
// every later bootstrap call (forced or not) short-circuits to null instead
// of re-hitting the server on every poll. Nothing about a `no-token` answer
// changes moment to moment, so there is nothing to gain by asking again
// before a reload or app relaunch creates a fresh module instance.
let installTokenInFlight: Promise<{ token: string | null; device: DeviceRecord | null }> | null = null;
let noTokenLatchedThisSession = false;
// Codex round-4 #4: `forceRefresh` used to bypass every latch, so a
// PERMANENTLY lost token (server never re-mints one) POSTed /api/devices on
// every single forced retry — every hazards poll after a `no-token` 401,
// forever, for the rest of the session. This latches after the FIRST forced
// refresh this session, win or lose: later forced calls stop hitting the
// server and just read back whatever that one attempt left cached (a token
// if it worked, null if it didn't) — same "nothing changes moment to
// moment without a reload" reasoning `noTokenLatchedThisSession` already
// uses for the non-forced path.
let tokenRefreshAttemptedThisSession = false;

/**
 * Whether the mount effect below should mint an install token at all. The
 * token only guards native-only endpoints (hazards, Live Activities) — a
 * plain web visitor (or crawler) has no use for one, and minting it anyway
 * is a POST /api/devices that writes a D1 device row on the Free plan for
 * nothing. Pulled out as its own pure function (wrapping the existing
 * `isNativePlatform` check already used by lib/plus/billing.ts) so it's
 * unit-testable without rendering the `usePlus` hook itself.
 */
export function shouldBootstrapInstallTokenOnMount(): boolean {
  return isNativePlatform();
}

export async function bootstrapInstallToken(opts?: {
  forceRefresh?: boolean;
}): Promise<{ token: string | null; device: DeviceRecord | null }> {
  const forceRefresh = opts?.forceRefresh === true;
  if (forceRefresh) {
    if (tokenRefreshAttemptedThisSession) {
      return { token: store.readInstallToken(), device: null };
    }
    tokenRefreshAttemptedThisSession = true;
    store.clearInstallToken();
  } else {
    const cached = store.readInstallToken();
    if (cached) return { token: cached, device: null };
    if (noTokenLatchedThisSession) return { token: null, device: null };
  }
  if (installTokenInFlight) return installTokenInFlight;

  const run = (async (): Promise<{ token: string | null; device: DeviceRecord | null }> => {
    const id = getDeviceId();
    if (!id) return { token: null, device: null };
    try {
      const res = await plusApi.saveDevice(id, baseFields());
      const minted = store.readInstallToken();
      if (minted) return { token: minted, device: res.ok ? res.device : null };
      noTokenLatchedThisSession = true;
      return { token: null, device: res.ok ? res.device : null };
    } catch {
      return { token: null, device: null };
    }
  })();
  installTokenInFlight = run;
  try {
    return await run;
  } finally {
    installTokenInFlight = null;
  }
}

/** Test-only: clear the module-scope "no token available this session"
 *  latch between tests, mirroring lib/db/memoryStore.ts's `resetMemoryStore`
 *  and lib/plus/rateLimit.ts's `resetMemoryRateLimit`. */
export function resetInstallTokenLatch(): void {
  noTokenLatchedThisSession = false;
  tokenRefreshAttemptedThisSession = false;
}

export function usePlus(): PlusState {
  const [ready, setReady] = useState(false);
  const [deviceId, setDeviceId] = useState("");
  const [cache, setCache] = useState<PlusCache | null>(null);
  const [device, setDevice] = useState<DeviceRecord | null>(null);
  const [deviceLoaded, setDeviceLoaded] = useState(false);
  const [profile, setProfile] = useState<ScoreProfile | null>(null);
  const [pendingPrefsKeys, setPendingPrefsKeys] = useState<AlertKey[]>([]);
  const [previewSeen, setPreviewSeen] = useState(false);
  const [preview, setPreview] = useState<PreviewRecord | null>(null);
  const [loading, setLoading] = useState(false);
  // `now` only has to move often enough to expire an entitlement while the app
  // is open; a minute is plenty and costs one render an hour in practice.
  const [now, setNow] = useState(() => Date.now());

  const lastRefreshRef = useRef(0);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingProfileRef = useRef<ScoreProfile | null>(null);
  // Throttle for the entitlement self-heal below — module-scope would leak
  // across devices in tests, so this lives per mounted hook instance instead.
  const lastSelfHealRef = useRef<number | null>(null);
  // Bumped at the start of every purchase/restore SYNC (never by a plain
  // read) — see `readSuperseded` above. Lets `refresh`'s device READ notice
  // a sync started (and, being simpler, likely finished) while it was still
  // in flight, and skip overwriting the sync's newer state with its own
  // stale answer (#6).
  const syncGenerationRef = useRef(0);
  // One-shot guard for the restore-pending retry below (#M2) — a second
  // restore tap (or a fast re-render) replaces rather than stacks a pending
  // retry, and unmount clears it like any other timer.
  const restoreRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- first read of the phone ---------------------------------------------
  useEffect(() => {
    setDeviceId(getDeviceId());
    setCache(store.readCache());
    setProfile(store.readProfile());
    setPendingPrefsKeys(Object.keys(store.readPending().prefs ?? {}) as AlertKey[]);
    setPreviewSeen(store.readPreviewSeen());
    setPreview(store.readPreview());
    setNow(Date.now());
    setReady(true);
  }, []);

  // Adopt whatever the server just told us about this device.
  const applyDevice = useCallback(
    (rec: DeviceRecord, opts?: { adoptProfile?: boolean }) => {
      const at = Date.now();
      const next = cacheFromDevice(rec, at);
      setCache(next);
      store.writeCache(next);
      setDevice(rec);
      setDeviceLoaded(true);
      setNow(at);
      // A routine refresh must never overwrite an edit made on this phone, so
      // the server's profile is only adopted when there is nothing local (a
      // reinstall) or when the caller explicitly asked (Restore).
      const serverProfile = store.cleanProfile(rec.profile);
      if (serverProfile && (opts?.adoptProfile || !store.readProfile())) {
        setProfile(serverProfile);
        store.writeProfile(serverProfile);
      }
      if (rec.previewSeen) {
        setPreviewSeen(true);
        store.writePreviewSeen(true);
      }
    },
    [],
  );

  // Wraps the module-level `bootstrapInstallToken` (see its doc above) to
  // also fold in whatever device row it happened to read along the way —
  // same `applyDevice` every other write here goes through.
  const ensureInstallToken = useCallback(async (): Promise<string | null> => {
    const { token, device } = await bootstrapInstallToken();
    if (device) applyDevice(device);
    return token;
  }, [applyDevice]);

  const refresh = useCallback(
    async (opts?: { forceSelfHeal?: boolean }): Promise<PlusResult | null> => {
      const id = getDeviceId();
      if (!id) return null;
      lastRefreshRef.current = Date.now();
      // Captured before the request goes out (#6): if a purchase/restore
      // sync STARTS while this read is in flight, that sync's own
      // applyDevice call is the newer one and must win — this read began
      // querying before the sync, so its own answer could be stale however
      // the two responses happen to land.
      const startGeneration = syncGenerationRef.current;
      setLoading(true);
      const res = await plusApi.getDevice(id);
      setLoading(false);
      const superseded = readSuperseded(startGeneration, syncGenerationRef.current);
      if (res.ok && res.device) {
        if (superseded) return res;
        applyDevice(res.device);
        // Entitlement self-heal (#3): a store grant that is about to expire or
        // just lapsed gets one quiet resync with RevenueCat, throttled to once
        // per SELF_HEAL_THROTTLE_MS, so a webhook outage never silently
        // de-provisions a paying subscriber who happens to reopen the app. The
        // decision itself is the pure `shouldSelfHeal` (lib/plus/entitlement.ts);
        // this is only the plumbing to call it and act on it. `forceSelfHeal`
        // (the store-expiry timer below) skips the throttle for one call —
        // the cached end date passing IS the reason to ask right now, not a
        // routine foreground check that should wait its turn.
        const healAt = Date.now();
        if (
          billingAvailable() &&
          shouldSelfHeal({
            cache: cacheFromDevice(res.device, healAt),
            now: healAt,
            storeBased: isStoreBased(res.device),
            billingAvailable: true,
            lastSyncedAt: opts?.forceSelfHeal ? null : lastSelfHealRef.current,
          })
        ) {
          lastSelfHealRef.current = healAt;
          syncGenerationRef.current += 1;
          const synced = await plusApi.syncPurchase(id);
          if (synced.ok && synced.device) applyDevice(synced.device);
        }
      } else if (!superseded && res.error === "not-found") {
        // The server has never seen this device: it is free, and saying so stops
        // the app asking again on every foreground.
        const free: PlusCache = { plan: "free", until: null, checkedAt: Date.now() };
        setCache(free);
        store.writeCache(free);
      }
      return res;
    },
    [applyDevice],
  );

  // --- device metadata: fetched once every mount, cache or no cache ---------
  // The entitlement cache can render on the very first frame, but prefs,
  // presence and home have no client-side cache of their own — so a reopened
  // app fetches the device row once even when the entitlement is still fresh,
  // rather than showing fabricated "all alerts on" defaults or a Beach Mode
  // card that offers to start a window that may already be running.
  useEffect(() => {
    if (!ready) return;
    // A phone with no cache has never talked to the server, so there is no row
    // to load and nothing to wait for from a plain GET. Asking anyway would
    // just be a 404 on every first launch (which browsers log as an error).
    if (!store.readCache()) {
      // But it DOES still need an install token (round-2 #1) — minting one
      // is the same POST /api/devices upsert that would otherwise only fire
      // on the phone's first actual edit (profile/home/prefs), which could
      // be never for someone who only ever reads the free forecast. Fire
      // and forget: a fresh device with Beach Mode off never notices either
      // way, and `ensureInstallToken` is exactly what Beach Mode start()
      // awaits before it needs the result. Native-only: the token only
      // guards native-only endpoints (hazards, Live Activities), and a plain
      // web visitor (or crawler) bootstrapping one writes a D1 device row on
      // the Free plan for nothing.
      if (shouldBootstrapInstallTokenOnMount()) void ensureInstallToken();
      setDeviceLoaded(true);
      return;
    }
    // Bootstrap the install token AND refresh the device row in parallel —
    // independent concerns (round-2 #1): a device that already has a token
    // short-circuits instantly (readInstallToken() cache hit inside
    // ensureInstallToken). A device that never received a token asks again
    // here on every mount. Once the server has stored a hash it will not mint
    // again (see lib/db/installTokenAuth.ts THREAT MODEL), so a lost token
    // stays lost and the token-gated features show "not available". Gated to
    // native (see note above) — web visitors still get `refresh()` below.
    if (shouldBootstrapInstallTokenOnMount()) void ensureInstallToken();
    void refresh().finally(() => setDeviceLoaded(true));
  }, [ready, refresh, ensureInstallToken]);

  useEffect(() => {
    if (!ready) return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      setNow(Date.now());
      // Only devices the server already knows are worth re-checking, and at
      // most once a minute.
      if (!store.readCache()) return;
      if (Date.now() - lastRefreshRef.current < REFRESH_THROTTLE_MS) return;
      void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [ready, refresh]);

  // Keep `now` moving so an entitlement that runs out while the app is open
  // actually takes effect.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  // A store grant's cached end date is a known moment, not "eventually" —
  // left open past it, the app would otherwise sit on a locally-expired
  // entitlement until the next foreground check happens to fall due (up to
  // REFRESH_THROTTLE_MS) or the every-60s `now` tick merely flips `entitled`
  // false without ever asking RevenueCat for a renewal (#2). This arms a
  // timer for STORE_EXPIRY_GRACE_MS after that moment instead (a renewal
  // right at the deadline may not be processed yet at the exact second —
  // L3), re-armed on every cache update (a renewal moves `until` further
  // out, so the effect re-runs and re-arms for the new date), and cleared
  // on unmount/re-arm like any other timer.
  useEffect(() => {
    if (!ready || !device) return;
    const ms = storeExpiryTimerMs({ cache, storeBased: isStoreBased(device), now: Date.now() });
    if (ms == null) return;
    const t = setTimeout(() => {
      // Ignores REFRESH_THROTTLE_MS (this isn't a routine foreground check)
      // and SELF_HEAL_THROTTLE_MS (forceSelfHeal below) — the cached date
      // passing is itself the reason to ask now. Still entitled with a new
      // end date → the effect above re-arms for it. Not entitled → the UI
      // locks, which is correct: RevenueCat had nothing newer to offer.
      void refresh({ forceSelfHeal: true });
    }, ms);
    return () => clearTimeout(t);
  }, [ready, device, cache, refresh]);

  // --- retry queue: saves that failed to reach the server --------------------
  // Merge/supersede rules live in lib/plus/pendingWrites.ts; this is only the
  // "when do we try again" half.
  const flushPending = useCallback(async (): Promise<void> => {
    const id = getDeviceId();
    if (!id) return;
    const pending = store.readPending();
    if (pending.profile) {
      const res = await plusApi.saveDevice(id, { ...baseFields(), profile: pending.profile });
      if (res.ok && res.device) {
        applyDevice(res.device);
        store.clearPendingProfile();
      } else if (!isRetryableSaveError(res)) {
        // The server rejected it outright — retrying would only repeat the
        // same rejected request.
        store.clearPendingProfile();
      }
    }
    if (pending.homeSlug) {
      const res = await plusApi.saveDevice(id, { ...baseFields(), homeSlug: pending.homeSlug });
      if (res.ok && res.device) {
        applyDevice(res.device);
        store.clearPendingHome();
      } else if (!isRetryableSaveError(res)) {
        store.clearPendingHome();
      }
    }
    if (pending.prefs && Object.keys(pending.prefs).length) {
      const res = await plusApi.saveDevice(id, { ...baseFields(), prefs: pending.prefs });
      if (res.ok && res.device) {
        applyDevice(res.device);
        store.clearPendingPrefs();
        setPendingPrefsKeys([]);
      } else if (!isRetryableSaveError(res)) {
        store.clearPendingPrefs();
        setPendingPrefsKeys([]);
      }
    }
    if (pending.purchaseSync) {
      // A store purchase that confirmed but never made it to our server
      // (#4) — retry the same RevenueCat confirmation syncPurchase() does.
      // Never clear this on a network failure: a paying subscriber's grant
      // must not quietly stop being retried just because one attempt failed.
      syncGenerationRef.current += 1; // a sync, not a plain read (#6/#L2)
      const res = await plusApi.syncPurchase(id);
      if (res.ok && res.device) {
        applyDevice(res.device);
        store.clearPendingPurchaseSync();
      } else if (!isRetryableSaveError(res)) {
        store.clearPendingPurchaseSync();
      }
    }
  }, [applyDevice]);

  // Try the queue on mount (a previous session may have left something
  // behind), whenever the phone comes back online, and on every foreground —
  // the three moments a save that failed offline is most likely to succeed.
  useEffect(() => {
    if (!ready) return;
    void flushPending();
    const onOnline = () => void flushPending();
    const onVisible = () => {
      if (document.visibilityState === "visible") void flushPending();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ready, flushPending]);

  // --- writes ---------------------------------------------------------------
  const flushProfile = useCallback(async (): Promise<void> => {
    const pending = pendingProfileRef.current;
    pendingProfileRef.current = null;
    if (!pending) return;
    const id = getDeviceId();
    if (!id) return;
    const res = await plusApi.saveDevice(id, { ...baseFields(), profile: pending });
    if (res.ok && res.device) {
      applyDevice(res.device);
      store.clearPendingProfile();
    } else if (isRetryableSaveError(res)) {
      // Offline, or the server had a bad moment: the local copy (already
      // written by saveProfile) is right, but the server never heard about
      // it — queue it so the retry loop (foreground/online/next flush) picks
      // it up instead of the edit quietly staying server-side stale forever.
      store.queuePendingProfile(pending);
    }
  }, [applyDevice]);

  const saveProfile = useCallback(
    (next: ScoreProfile) => {
      setProfile(next);
      store.writeProfile(next);
      pendingProfileRef.current = next;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => void flushProfile(), PROFILE_SAVE_DEBOUNCE_MS);
    },
    [flushProfile],
  );

  const commitProfile = useCallback(
    async (next: ScoreProfile, seen?: boolean): Promise<PlusResult> => {
      setProfile(next);
      store.writeProfile(next);
      pendingProfileRef.current = null;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (seen) {
        setPreviewSeen(true);
        store.writePreviewSeen(true);
      }
      const id = getDeviceId();
      if (!id) return { ok: false, device: null, error: "network", status: 0 };
      setLoading(true);
      const res = await plusApi.saveDevice(id, {
        ...baseFields(),
        profile: next,
        ...(seen ? { previewSeen: true } : {}),
      });
      setLoading(false);
      if (res.ok && res.device) applyDevice(res.device);
      return res;
    },
    [applyDevice],
  );

  // Never lose an edit to a closing sheet or a backgrounded app.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      void flushProfile();
    };
  }, [flushProfile]);

  const savePrefs = useCallback(
    async (patch: Partial<AlertPrefs>): Promise<PlusResult> => {
      const id = getDeviceId();
      if (!id) return { ok: false, device: null, error: "network", status: 0 };
      const prevPrefs = device?.prefs ?? defaultPrefs();
      // Optimistic: the toggle moves now, the server catches up.
      setDevice((d) => (d ? { ...d, prefs: { ...d.prefs, ...patch } } : d));
      setLoading(true);
      const res = await plusApi.saveDevice(id, { ...baseFields(), prefs: patch });
      setLoading(false);
      if (res.ok && res.device) {
        applyDevice(res.device);
        store.clearPendingPrefsKeys(Object.keys(patch));
        setPendingPrefsKeys(Object.keys(store.readPending().prefs ?? {}) as AlertKey[]);
      } else if (isRetryableSaveError(res)) {
        // The server never confirmed it: put the toggle back to what it
        // showed before this tap (never a fabricated guess) and remember the
        // intended value so the retry queue lands it on its own.
        setDevice((d) => (d ? { ...d, prefs: prevPrefs } : d));
        store.queuePendingPrefs(patch);
        setPendingPrefsKeys(Object.keys(store.readPending().prefs ?? {}) as AlertKey[]);
      } else {
        // The server rejected it outright: retrying would just repeat the
        // same rejected request, so revert and drop it from the queue.
        setDevice((d) => (d ? { ...d, prefs: prevPrefs } : d));
        store.clearPendingPrefsKeys(Object.keys(patch));
        setPendingPrefsKeys(Object.keys(store.readPending().prefs ?? {}) as AlertKey[]);
      }
      return res;
    },
    [applyDevice, device],
  );

  const setHome = useCallback(
    async (slug: string): Promise<PlusResult> => {
      const id = getDeviceId();
      if (!id) return { ok: false, device: null, error: "network", status: 0 };
      const res = await plusApi.saveDevice(id, { ...baseFields(), homeSlug: slug });
      if (res.ok && res.device) {
        applyDevice(res.device);
        store.clearPendingHome();
      } else if (isRetryableSaveError(res)) {
        // Local navigation already moved on; remember the intended home so
        // the next foreground/online try lands the server copy too.
        store.queuePendingHome(slug);
      }
      return res;
    },
    [applyDevice],
  );

  const startTrial = useCallback(async (): Promise<PlusResult> => {
    const id = getDeviceId();
    if (!id) return { ok: false, device: null, error: "network", status: 0 };
    setLoading(true);
    const res = await plusApi.startTrial(id);
    setLoading(false);
    if (res.ok && res.device) applyDevice(res.device);
    return res;
  }, [applyDevice]);

  const unlock = useCallback(
    async (code: string): Promise<PlusResult> => {
      const id = getDeviceId();
      if (!id) return { ok: false, device: null, error: "network", status: 0 };
      // Redeem — held so a mid-deploy reload can't cut off an entered code.
      const release = holdReload();
      setLoading(true);
      try {
        const res = await plusApi.unlock(id, code.trim());
        if (res.ok && res.device) applyDevice(res.device);
        return res;
      } finally {
        setLoading(false);
        release();
      }
    },
    [applyDevice],
  );

  const syncPurchase = useCallback(async (): Promise<PlusResult> => {
    const id = getDeviceId();
    if (!id) return { ok: false, device: null, error: "network", status: 0 };
    // A store purchase already confirmed — held so a reload can't strand a
    // charged customer before the server hears about it.
    const release = holdReload();
    setLoading(true);
    // A sync, never a plain read (#6): bumped before the request so any
    // slower device read already in flight (e.g. a foreground refresh())
    // knows, once it lands, that this call's answer is the newer one.
    syncGenerationRef.current += 1;
    try {
      const res = await plusApi.syncPurchase(id);
      if (res.ok && res.device) {
        applyDevice(res.device);
        if (deviceEntitled(res.device, Date.now())) {
          // A retry queued by an earlier failed sync is now settled.
          store.clearPendingPurchaseSync();
        } else {
          // The store's purchase sheet just resolved "purchased", so the
          // charge is real — but this 200 says the row isn't entitled (the
          // server asked RevenueCat and it hadn't caught up yet, or the
          // grant already lapsed again). Not the server's final word: queue
          // the same retry the network-failure branch below uses (#4),
          // rather than clearing the queue on a charged-but-unconfirmed sync.
          store.queuePendingPurchaseSync();
        }
      } else if (isRetryableSaveError(res)) {
        // The store already confirmed the purchase (that's the only reason a
        // caller calls syncPurchase after `buy()`); the server just didn't
        // hear about it this time — queue a retry rather than leave a
        // charged customer without Plus until they happen to tap Restore
        // (#4). A rejected (non-retryable) response has nothing to queue.
        store.queuePendingPurchaseSync();
      }
      return res;
    } finally {
      // A `finally` here, not a plain call after the await: plusApi never
      // rejects, but restoreBilling/purchasePlan callers rely on this same
      // shape, and a stray throw must not leave loading stuck true (#16).
      setLoading(false);
      release();
    }
  }, [applyDevice]);

  const restore = useCallback(async (): Promise<PlusResult> => {
    const id = getDeviceId();
    if (!id) return { ok: false, device: null, error: "network", status: 0 };
    lastRefreshRef.current = Date.now();
    // Held for the whole restore — store restore + server sync.
    const release = holdReload();
    setLoading(true);
    try {
      // With billing on, ask the store first: a reinstall or a new phone on
      // the same Apple ID has a purchase the server has never been told
      // about. restoreBilling itself never throws (lib/plus/billing.ts).
      if (billingAvailable() && (await restoreBilling(id))) {
        // A sync, not a plain read (#6) — see syncPurchase's own comment.
        syncGenerationRef.current += 1;
        const synced = await plusApi.syncPurchase(id);
        if (synced.ok && synced.device) {
          applyDevice(synced.device, { adoptProfile: true });
          if (deviceEntitled(synced.device, Date.now())) {
            store.clearPendingPurchaseSync();
            return synced;
          }
          // The server answered, but this 200 isn't entitled yet (RevenueCat
          // hasn't caught up, or the grant already lapsed again) — same
          // non-final-word reasoning as syncPurchase's own not-entitled
          // branch (#4/#L1). Falls through to the shared queue+retry below
          // rather than reading as "nothing to restore".
        }
        // Either the round trip itself failed, or it succeeded but wasn't
        // entitled yet: the store already confirmed the purchase for this
        // Apple ID, so this is not the server's final word. Queue the same
        // retry #4 uses (mount/online/foreground), PLUS one guarded, one-shot
        // retry ~10s from now (#M2) rather than making them wait for the
        // next foreground — and never fall through to plusApi.getDevice()
        // below, which would silently read back the OLD pre-restore row and
        // look to the person like Restore found nothing (#5).
        store.queuePendingPurchaseSync();
        if (restoreRetryTimerRef.current) clearTimeout(restoreRetryTimerRef.current);
        restoreRetryTimerRef.current = setTimeout(() => {
          restoreRetryTimerRef.current = null;
          void flushPending();
        }, RESTORE_RETRY_MS);
        return { ...synced, error: "restore-pending" };
      }
      syncGenerationRef.current += 1;
      const res = await plusApi.getDevice(id);
      // Explicit Restore: the server's copy wins, profile included.
      if (res.ok && res.device) applyDevice(res.device, { adoptProfile: true });
      return res;
    } finally {
      setLoading(false);
      release();
    }
  }, [applyDevice, flushPending]);

  // Clears a still-pending guarded restore retry on unmount, same as every
  // other timer ref here.
  useEffect(() => {
    return () => {
      if (restoreRetryTimerRef.current) clearTimeout(restoreRetryTimerRef.current);
    };
  }, []);

  const savePreview = useCallback((record: PreviewRecord) => {
    setPreview(record);
    store.writePreview(record);
  }, []);

  const arm = useCallback(
    async (presence: PresenceBody): Promise<PlusResult> => {
      const id = getDeviceId();
      if (!id) return { ok: false, device: null, error: "network", status: 0 };
      // Held for the presence write — a reload mid-arm must not race it.
      const release = holdReload();
      try {
        const res = await plusApi.arm(id, presence);
        if (res.ok && res.device) applyDevice(res.device);
        return res;
      } finally {
        release();
      }
    },
    [applyDevice],
  );

  const disarm = useCallback(async (): Promise<PlusResult> => {
    const id = getDeviceId();
    if (!id) return { ok: false, device: null, error: "network", status: 0 };
    const release = holdReload();
    try {
      const res = await plusApi.disarm(id);
      if (res.ok && res.device) applyDevice(res.device);
      return res;
    } finally {
      release();
    }
  }, [applyDevice]);

  const prefs = device?.prefs ?? defaultPrefs();
  const entitled = isEntitled(cache, now);

  return {
    ready,
    entitled,
    loading,
    deviceLoaded,
    device,
    profile,
    prefs,
    pendingPrefsKeys,
    previewSeen,
    preview,
    cache,
    deviceId,
    refresh,
    restore,
    startTrial,
    unlock,
    syncPurchase,
    saveProfile,
    commitProfile,
    savePrefs,
    setHome,
    savePreview,
    arm,
    disarm,
    ensureInstallToken,
  };
}

/** Stable identity for a profile, so a re-render with an equal object does not
 *  re-run the engine over 216 hourly buckets. */
function profileKey(profile: ScoreProfile | null): string {
  return profile ? JSON.stringify(profile) : "";
}

/**
 * This person's score for `res`, or null when there is no profile to score
 * with. Advanced edits are debounced so a run of taps produces one recompute,
 * not five; picking a profile applies at once (nobody wants to watch a chip lag).
 */
export function usePersonalScore(
  res: ConditionsResponse,
  profile: ScoreProfile | null,
  nowMs: number,
): PersonalScore | null {
  const key = profileKey(profile);
  const [settled, setSettled] = useState(key);
  const settledProfileRef = useRef<ScoreProfile | null>(profile);

  useEffect(() => {
    if (key === settled) return;
    const prev = settledProfileRef.current;
    // Only the Advanced dials are dragged in quick succession — everything else
    // is a single tap and should land immediately.
    const advancedOnly =
      !!prev &&
      !!profile &&
      JSON.stringify({ ...prev, advanced: undefined }) ===
        JSON.stringify({ ...profile, advanced: undefined });
    const apply = () => {
      settledProfileRef.current = profile;
      setSettled(key);
    };
    if (!advancedOnly) {
      apply();
      return;
    }
    const t = setTimeout(apply, SCORE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [key, settled, profile]);

  return useMemo(() => {
    const active = settledProfileRef.current;
    if (!active || !settled) return null;
    return computePersonalScore(res, resolveScoring(active), nowMs);
    // `settled` is the memo's real input: it changes exactly when the debounced
    // profile does. The ref it names is read inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [res, settled, nowMs]);
}

// --- device fix -------------------------------------------------------------
// One fix per session, shared by every component that needs one. Nothing here
// ever prompts: `useDeviceFix` only reads a position when permission has
// ALREADY been granted. The prompt belongs to an explicit tap (the first-run
// banner, Beach Mode), which calls `request()`.

type FixListener = (fix: Fix | null) => void;
let sessionFix: Fix | null = null;
const fixListeners = new Set<FixListener>();

/**
 * Publish a fix to every mounted consumer (and remember it for this session).
 * An older fix never replaces a newer one (R-02): several consumers can have
 * requests in flight at once, and the one that resolves last is not always
 * the one that was taken last. Returns the fix now in effect.
 */
export function setSessionFix(fix: Fix | null): Fix | null {
  if (fix && sessionFix && Number.isFinite(sessionFix.at) && fix.at < sessionFix.at) return sessionFix;
  sessionFix = fix;
  for (const fn of fixListeners) fn(fix);
  return fix;
}

export function getSessionFix(): Fix | null {
  return sessionFix;
}

export interface DeviceFixState {
  fix: Fix | null;
  /** True once we have decided whether a silent fix was possible. */
  settled: boolean;
  /** Ask for a position, prompting if the OS wants to. Never rejects. */
  request(): Promise<Fix | null>;
  /**
   * Ask for a FRESH, high-accuracy position for arming Beach Mode or
   * refreshing an armed presence (LOC-06). Null when the OS could not give
   * one — the caller must then NOT fall back to `fix`, which may be exactly
   * the obsolete reading this call was meant to replace.
   */
  requestFresh(): Promise<Fix | null>;
  /** How old the current fix is right now (ms), or null when there is none. */
  fixAgeMs(): number | null;
}

export function useDeviceFix(): DeviceFixState {
  const [fix, setFix] = useState<Fix | null>(sessionFix);
  const [settled, setSettled] = useState(sessionFix != null);

  useEffect(() => {
    const listener: FixListener = (next) => setFix(next);
    fixListeners.add(listener);
    return () => {
      fixListeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    if (sessionFix) {
      setSettled(true);
      return;
    }
    void (async () => {
      const perm = await checkLocationPermission();
      if (!alive) return;
      if (perm !== "granted") {
        setSettled(true);
        return;
      }
      const got = await getFix();
      if (!alive) return;
      if ("error" in got) setSettled(true);
      else {
        setSessionFix(got);
        setSettled(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const request = useCallback(async (): Promise<Fix | null> => {
    const got = await getFix();
    if ("error" in got) {
      setSettled(true);
      return null;
    }
    setSessionFix(got);
    setSettled(true);
    return got;
  }, []);

  const requestFresh = useCallback(async (): Promise<Fix | null> => {
    // Held for the location request — a reload mid-prompt would dismiss the
    // OS permission dialog / cut off the fix, and Beach Mode's arm() awaits
    // this before its own write anyway.
    const release = holdReload();
    try {
      const got = await getFreshFix();
      setSettled(true);
      if ("error" in got) return null;
      // Publish for everyone else, but hand THIS caller the fix it asked for,
      // whatever a concurrent request may have published in the meantime.
      setSessionFix(got);
      return got;
    } finally {
      release();
    }
  }, []);

  // Reads the module-level fix directly (not the `fix` state variable), so it
  // is always current even between a fix update and this component's next
  // render.
  const fixAgeMs = useCallback((): number | null => {
    return sessionFix ? Date.now() - sessionFix.at : null;
  }, []);

  // A fix from a few minutes ago is still a fine stand-in for "where the
  // phone is now"; one from before the app was backgrounded is not. Only
  // refreshes a fix that already exists — a phone that has never granted
  // location is not asked again just for reopening the app; that prompt
  // belongs to an explicit tap.
  useEffect(() => {
    if (!settled) return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (shouldRefreshFix(fixAgeMs())) void request();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [settled, request, fixAgeMs]);

  return { fix, settled, request, requestFresh, fixAgeMs };
}

// --- hazards at a point (Beach Mode "where you stand") ----------------------
// POST /api/hazards, throttled to once per HAZARDS_REFRESH_MS and re-checked
// on foreground — the same cadence pattern usePlus's refresh() uses above,
// not a new interval. Fetches only while `eligible` (the card's own arm +
// fresh-fix gates — see establishesArrival) is true; flips back to null the
// moment it isn't, so a disarmed or stale-fix card never shows a stale read.
// Never throws to the caller: any failure is a null read, i.e. no line
// (fail-soft).
//
// Codex review: `eligible` and the fix it closed over can both go stale
// between the render that armed this hook and the async work actually
// running (a backgrounded tab for minutes, a slow throttle tick, a
// concurrent disarm/move). So every dispatch re-reads the LATEST eligible
// flag and fix off refs (never a value captured at hook-call time), re-runs
// the same freshness gates `establishesArrival` uses (age, accuracy) right
// before sending, asks for a fresh fix when the held one has aged past the
// arrival limit, and stamps every request with a ticket — a response whose
// ticket is no longer current, or that lands after the card went ineligible,
// is dropped rather than repopulating state a disarm or a move already
// invalidated.

/** Never ask more than once every 5 minutes, however often the tab foregrounds. */
const HAZARDS_REFRESH_MS = 5 * 60_000;

export interface HazardPointRead {
  lightning: HazardAssessment;
  /** Display-only lightning distance the route measured for this anchor
   *  (lib/hazards/assess.ts itself never carries a distance). */
  lightningMi: number | null;
  rain: HazardAssessment;
}

export interface HazardsAtPoint {
  point: HazardPointRead;
  beach: HazardPointRead;
}

/** The input a dispatched (or applied) hazards read is FOR — beach + the
 *  exact fix (its timestamp, and position rounded to ~0.7 mi, plenty to
 *  distinguish one beach's fix from another's). Codex round 2 #3: a card
 *  that switched from eligible(A, fixA) to eligible(B, fixB) inside the
 *  throttle window must never let A's in-flight response paint B's card —
 *  comparing this key is how a stale response is told from a current one. */
export function hazardsInputKey(slug: string, fix: Fix | null): string {
  if (!fix) return `${slug}|no-fix`;
  return `${slug}|${fix.at}|${fix.lat.toFixed(2)}|${fix.lon.toFixed(2)}`;
}

export function useHazardsAtPoint(opts: {
  eligible: boolean;
  slug: string;
  fix: Fix | null;
  /** Every served beach, so a fix refreshed mid-dispatch can be re-checked
   *  against the CURRENT slug's centroid, not just its own age/accuracy. */
  beaches: LocationPublic[];
  /** DeviceFixState.requestFresh — asked for a fresh fix when the held one
   *  has aged past the arrival limit at dispatch time. */
  requestFresh: () => Promise<Fix | null>;
}): HazardsAtPoint | null {
  const { eligible, slug, fix, beaches, requestFresh } = opts;
  const [read, setRead] = useState<HazardsAtPoint | null>(null);
  const lastFetchAtRef = useRef(0);
  // A ticket per dispatch (R-02 pattern, mirroring BeachModeCard's armSeqRef):
  // only the response matching the CURRENT ticket may ever reach setRead.
  const ticketRef = useRef(0);
  const eligibleRef = useRef(eligible);
  const fixRef = useRef(fix);
  const slugRef = useRef(slug);
  const beachesRef = useRef(beaches);
  const requestFreshRef = useRef(requestFresh);
  // The input key the CURRENT (or most recently dispatched) request belongs
  // to. A response is only ever applied when its own key still matches this.
  const currentKeyRef = useRef(hazardsInputKey(slug, fix));

  useEffect(() => {
    eligibleRef.current = eligible;
  }, [eligible]);
  useEffect(() => {
    fixRef.current = fix;
  }, [fix]);
  useEffect(() => {
    slugRef.current = slug;
  }, [slug]);
  useEffect(() => {
    beachesRef.current = beaches;
  }, [beaches]);
  useEffect(() => {
    requestFreshRef.current = requestFresh;
  }, [requestFresh]);

  const fetchNow = useCallback(async () => {
    if (!eligibleRef.current) return;
    let f = fixRef.current;
    // Re-validate freshness AT DISPATCH, not at whatever render last computed
    // `eligible` — the same age gate establishesArrival uses. A fix aged past
    // it is refreshed once (reusing requestFresh), never silently reused.
    const tooOld = !f || Date.now() - f.at > ARRIVAL_MAX_FIX_AGE_MS;
    if (tooOld) {
      f = await requestFreshRef.current();
      if (!eligibleRef.current) return; // went ineligible while we waited
    }
    if (!f) return;

    // Re-run the FULL arrival gate (age, accuracy, future-skew, AND
    // proximity) against the fix that is actually about to be sent, for the
    // CURRENT slug (Codex round 2 #1). The checks above only cover freshness
    // — a just-refreshed fix can be accurate and recent but no longer near
    // the beach (the phone kept walking while the refresh was in flight), or
    // the slug itself can have moved on. Only `establishesArrival`'s
    // composite check — the same one Beach Mode's own arrival gate uses —
    // may clear a fix for dispatch.
    const centroid = beachesRef.current.find((b) => b.slug === slugRef.current) ?? null;
    if (!establishesArrival(f, centroid, Date.now())) return;

    const id = getDeviceId();
    if (!id) return;

    const key = hazardsInputKey(slugRef.current, f);
    currentKeyRef.current = key;
    const ticket = ++ticketRef.current;
    lastFetchAtRef.current = Date.now();
    const superseded = () => ticket !== ticketRef.current || !eligibleRef.current || key !== currentKeyRef.current;
    try {
      // /api/hazards requires the install token (Codex review #1) once this
      // device has one on file — same header lib/plus/api.ts attaches to
      // every plusApi call; this is a raw fetch, not one of those, so it's
      // attached explicitly here instead.
      const doFetch = (token: string | null) =>
        fetch("/api/hazards", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(token ? { "x-install-token": token } : {}),
          },
          body: JSON.stringify({
            deviceId: id,
            lat: f.lat,
            lon: f.lon,
            accuracyM: f.accuracyM,
            fixAt: f.at,
            slug: slugRef.current,
          }),
        });
      let res = await doFetch(store.readInstallToken());
      // A 401 here means either this device has never had a token minted
      // (`token-required`) or the one it's sending doesn't match what the
      // server has on file (`no-token` — stale/wrong/lost locally). Either
      // way the cached token (if any) is not trustworthy, so this forces a
      // real round trip rather than letting `bootstrapInstallToken` hand the
      // same bad cached value straight back. One bootstrap + one retry, then
      // give up quietly — the existing `!res.ok` fallback below already
      // reads as "no hazard read this pass", exactly the right degrade for a
      // device that still has nothing after the retry.
      if (res.status === 401 && !superseded()) {
        const { token } = await bootstrapInstallToken({ forceRefresh: true });
        if (token && !superseded()) res = await doFetch(token);
      }
      if (superseded()) return; // a newer dispatch, a disarm/move, or a different beach/fix now current
      if (!res.ok) {
        setRead(null);
        return;
      }
      const body = (await res.json()) as {
        ok?: boolean;
        lightning?: HazardAssessment;
        lightningMi?: number | null;
        rain?: HazardAssessment;
        beach?: { lightning?: HazardAssessment; lightningMi?: number | null; rain?: HazardAssessment };
      };
      if (superseded()) return;
      if (!body.ok || !body.lightning || !body.rain || !body.beach?.lightning || !body.beach?.rain) {
        setRead(null);
        return;
      }
      setRead({
        point: { lightning: body.lightning, lightningMi: body.lightningMi ?? null, rain: body.rain },
        beach: {
          lightning: body.beach.lightning,
          lightningMi: body.beach.lightningMi ?? null,
          rain: body.beach.rain,
        },
      });
    } catch {
      if (!superseded()) setRead(null); // a hazard-line failure is silence, never a stale claim
    }
  }, []);

  useEffect(() => {
    if (!eligible) {
      ticketRef.current += 1; // invalidate any response still in flight
      setRead(null);
      return;
    }
    // A beach or fix switch while staying eligible (Codex round 2 #3): the
    // in-flight response, if any, is now for a stale input, so it must be
    // invalidated even though `eligible` itself never went false.
    const key = hazardsInputKey(slug, fix);
    if (key !== currentKeyRef.current) {
      currentKeyRef.current = key;
      ticketRef.current += 1;
      setRead(null);
    }
    if (Date.now() - lastFetchAtRef.current >= HAZARDS_REFRESH_MS) void fetchNow();
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastFetchAtRef.current < HAZARDS_REFRESH_MS) return;
      void fetchNow();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [eligible, slug, fix, fetchNow]);

  return read;
}
