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
import { checkLocationPermission, getFix, type Fix } from "@/lib/location/device";
import { nativePlatform } from "@/lib/push/native";
import { defaultPrefs, type AlertPrefs, type DeviceRecord } from "@/lib/db/types";
import { resolveScoring } from "@/lib/profile/resolve";
import type { ScoreProfile } from "@/lib/profile/types";
import type { ConditionsResponse } from "@/lib/types";
import { plusApi, type PlusResult, type PresenceBody } from "@/lib/plus/api";
import { cacheFromDevice, isEntitled, shouldRefresh } from "@/lib/plus/entitlement";
import { computePersonalScore, type PersonalScore } from "@/lib/plus/personalScore";
import * as store from "@/lib/plus/storage";
import type { PlusCache, PreviewRecord } from "@/lib/plus/types";

/** Never ask the server twice inside this window on foreground. */
const REFRESH_THROTTLE_MS = 60_000;
/** How long a profile edit sits before it is written to the server. */
const PROFILE_SAVE_DEBOUNCE_MS = 600;
/** How long an Advanced edit sits before the score is recomputed. */
const SCORE_DEBOUNCE_MS = 150;

export interface PlusState {
  /** The phone has been read. Everything below is meaningless until this is true. */
  ready: boolean;
  entitled: boolean;
  /** A server call is in flight. */
  loading: boolean;
  device: DeviceRecord | null;
  profile: ScoreProfile | null;
  prefs: AlertPrefs;
  previewSeen: boolean;
  preview: PreviewRecord | null;
  cache: PlusCache | null;
  deviceId: string;
  refresh(): Promise<PlusResult | null>;
  restore(): Promise<PlusResult>;
  startTrial(): Promise<PlusResult>;
  unlock(code: string): Promise<PlusResult>;
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

export function usePlus(): PlusState {
  const [ready, setReady] = useState(false);
  const [deviceId, setDeviceId] = useState("");
  const [cache, setCache] = useState<PlusCache | null>(null);
  const [device, setDevice] = useState<DeviceRecord | null>(null);
  const [profile, setProfile] = useState<ScoreProfile | null>(null);
  const [previewSeen, setPreviewSeen] = useState(false);
  const [preview, setPreview] = useState<PreviewRecord | null>(null);
  const [loading, setLoading] = useState(false);
  // `now` only has to move often enough to expire an entitlement while the app
  // is open; a minute is plenty and costs one render an hour in practice.
  const [now, setNow] = useState(() => Date.now());

  const lastRefreshRef = useRef(0);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingProfileRef = useRef<ScoreProfile | null>(null);

  // --- first read of the phone ---------------------------------------------
  useEffect(() => {
    setDeviceId(getDeviceId());
    setCache(store.readCache());
    setProfile(store.readProfile());
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

  const refresh = useCallback(async (): Promise<PlusResult | null> => {
    const id = getDeviceId();
    if (!id) return null;
    lastRefreshRef.current = Date.now();
    setLoading(true);
    const res = await plusApi.getDevice(id);
    setLoading(false);
    if (res.ok && res.device) applyDevice(res.device);
    else if (res.error === "not-found") {
      // The server has never seen this device: it is free, and saying so stops
      // the app asking again on every foreground.
      const free: PlusCache = { plan: "free", until: null, checkedAt: Date.now() };
      setCache(free);
      store.writeCache(free);
    }
    return res;
  }, [applyDevice]);

  // --- re-check: stale cache on open, and on every foreground ---------------
  useEffect(() => {
    if (!ready) return;
    if (shouldRefresh(store.readCache(), Date.now())) void refresh();
  }, [ready, refresh]);

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

  // --- writes ---------------------------------------------------------------
  const flushProfile = useCallback(async (): Promise<void> => {
    const pending = pendingProfileRef.current;
    pendingProfileRef.current = null;
    if (!pending) return;
    const id = getDeviceId();
    if (!id) return;
    const res = await plusApi.saveDevice(id, { ...baseFields(), profile: pending });
    if (res.ok && res.device) applyDevice(res.device);
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
      // Optimistic: the toggle moves now, the server catches up.
      setDevice((d) => (d ? { ...d, prefs: { ...d.prefs, ...patch } } : d));
      setLoading(true);
      const res = await plusApi.saveDevice(id, { ...baseFields(), prefs: patch });
      setLoading(false);
      if (res.ok && res.device) applyDevice(res.device);
      return res;
    },
    [applyDevice],
  );

  const setHome = useCallback(
    async (slug: string): Promise<PlusResult> => {
      const id = getDeviceId();
      if (!id) return { ok: false, device: null, error: "network", status: 0 };
      const res = await plusApi.saveDevice(id, { ...baseFields(), homeSlug: slug });
      if (res.ok && res.device) applyDevice(res.device);
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
      setLoading(true);
      const res = await plusApi.unlock(id, code.trim());
      setLoading(false);
      if (res.ok && res.device) applyDevice(res.device);
      return res;
    },
    [applyDevice],
  );

  const restore = useCallback(async (): Promise<PlusResult> => {
    const id = getDeviceId();
    if (!id) return { ok: false, device: null, error: "network", status: 0 };
    lastRefreshRef.current = Date.now();
    setLoading(true);
    const res = await plusApi.getDevice(id);
    setLoading(false);
    // Explicit Restore: the server's copy wins, profile included.
    if (res.ok && res.device) applyDevice(res.device, { adoptProfile: true });
    return res;
  }, [applyDevice]);

  const savePreview = useCallback((record: PreviewRecord) => {
    setPreview(record);
    store.writePreview(record);
  }, []);

  const arm = useCallback(
    async (presence: PresenceBody): Promise<PlusResult> => {
      const id = getDeviceId();
      if (!id) return { ok: false, device: null, error: "network", status: 0 };
      const res = await plusApi.arm(id, presence);
      if (res.ok && res.device) applyDevice(res.device);
      return res;
    },
    [applyDevice],
  );

  const disarm = useCallback(async (): Promise<PlusResult> => {
    const id = getDeviceId();
    if (!id) return { ok: false, device: null, error: "network", status: 0 };
    const res = await plusApi.disarm(id);
    if (res.ok && res.device) applyDevice(res.device);
    return res;
  }, [applyDevice]);

  const prefs = device?.prefs ?? defaultPrefs();
  const entitled = isEntitled(cache, now);

  return {
    ready,
    entitled,
    loading,
    device,
    profile,
    prefs,
    previewSeen,
    preview,
    cache,
    deviceId,
    refresh,
    restore,
    startTrial,
    unlock,
    saveProfile,
    commitProfile,
    savePrefs,
    setHome,
    savePreview,
    arm,
    disarm,
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

/** Publish a fix to every mounted consumer (and remember it for this session). */
export function setSessionFix(fix: Fix | null): void {
  sessionFix = fix;
  for (const fn of fixListeners) fn(fix);
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

  return { fix, settled, request };
}
