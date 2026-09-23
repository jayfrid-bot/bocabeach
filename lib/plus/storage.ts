// Everything Beach Day Plus keeps on the phone. One place, so no component ever
// touches localStorage directly and every read is validated before it is trusted
// (a hand-edited or half-written value must never crash the dashboard).
//
// Guarded on `localStorage` rather than `window`, so these are safe on the
// server (no localStorage there → the null/no-op path) AND unit-testable in the
// node test environment by assigning a fake `globalThis.localStorage`.

import { ALERT_KEYS, type AlertPrefs } from "@/lib/db/types";
import { isProfileId } from "@/lib/profile/presets";
import type { AdvancedProfile, ScoreProfile, SubKey } from "@/lib/profile/types";
import { clearField, clearPrefsKeys, isEmpty as pendingIsEmpty, mergeHomeSlug, mergePrefs, mergeProfile, mergePurchaseSync } from "@/lib/plus/pendingWrites";
import type { LiveActivityDismissal, OffSuppression, PendingWrites, PlusCache, PreviewRecord } from "@/lib/plus/types";

export const PLUS_KEYS = {
  profile: "bd:profile",
  plus: "bd:plus",
  previewSeen: "bd:preview-seen",
  preview: "bd:preview",
  firstRunDone: "bd:first-run-done",
  offSuppression: "bd:off-suppression",
  pending: "bd:pending-writes",
  liveActivity: "bd:live-activity",
  liveActivityDismissed: "bd:live-activity-dismissed",
  installToken: "bd:install-token",
} as const;

function store(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // private mode / storage disabled
  }
}

function readJson(key: string): unknown {
  const s = store();
  if (!s) return null;
  try {
    const raw = s.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  const s = store();
  if (!s) return;
  try {
    s.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / private mode — the server copy is the backup */
  }
}

function remove(key: string): void {
  const s = store();
  if (!s) return;
  try {
    s.removeItem(key);
  } catch {
    /* ignore */
  }
}

function readFlag(key: string): boolean {
  const s = store();
  if (!s) return false;
  try {
    return s.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string, on: boolean): void {
  const s = store();
  if (!s) return;
  try {
    if (on) s.setItem(key, "1");
    else s.removeItem(key);
  } catch {
    /* ignore */
  }
}

// --- profile ---------------------------------------------------------------

const HEATS = new Set(["cooler", "normal", "hot"]);
const CROWDS = new Set(["low", "normal", "high"]);
const WAVES = new Set(["calm", "some", "surf"]);
const MULTS = new Set([0, 0.5, 1, 2, 3]);

function cleanRange(v: unknown): [number, number] | undefined {
  if (!Array.isArray(v) || v.length !== 2) return undefined;
  const [lo, hi] = v;
  if (typeof lo !== "number" || typeof hi !== "number") return undefined;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return undefined;
  return [lo, hi];
}

function cleanAdvanced(v: unknown): AdvancedProfile | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const raw = v as Record<string, unknown>;
  const out: AdvancedProfile = {};
  if (raw.mult && typeof raw.mult === "object" && !Array.isArray(raw.mult)) {
    const mult: AdvancedProfile["mult"] = {};
    for (const [k, m] of Object.entries(raw.mult as Record<string, unknown>)) {
      if (typeof m === "number" && MULTS.has(m)) mult[k as SubKey] = m as 0 | 0.5 | 1 | 2 | 3;
    }
    if (Object.keys(mult).length) out.mult = mult;
  }
  const air = cleanRange(raw.airIdeal);
  if (air) out.airIdeal = air;
  const water = cleanRange(raw.waterIdeal);
  if (water) out.waterIdeal = water;
  if (typeof raw.wavePref === "string" && WAVES.has(raw.wavePref)) {
    out.wavePref = raw.wavePref as AdvancedProfile["wavePref"];
  }
  return Object.keys(out).length ? out : undefined;
}

/** Validate anything claiming to be a ScoreProfile. Null when it isn't one. */
export function cleanProfile(v: unknown): ScoreProfile | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const raw = v as Record<string, unknown>;
  const profiles = Array.isArray(raw.profiles) ? raw.profiles.filter(isProfileId).slice(0, 2) : [];
  if (!profiles.length) return null;
  const heat = typeof raw.heat === "string" && HEATS.has(raw.heat) ? raw.heat : "normal";
  const crowds = typeof raw.crowds === "string" && CROWDS.has(raw.crowds) ? raw.crowds : "normal";
  const advanced = cleanAdvanced(raw.advanced);
  const out: ScoreProfile = {
    profiles,
    heat: heat as ScoreProfile["heat"],
    crowds: crowds as ScoreProfile["crowds"],
  };
  if (advanced) out.advanced = advanced;
  return out;
}

export function readProfile(): ScoreProfile | null {
  return cleanProfile(readJson(PLUS_KEYS.profile));
}

export function writeProfile(profile: ScoreProfile | null): void {
  if (!profile) remove(PLUS_KEYS.profile);
  else writeJson(PLUS_KEYS.profile, profile);
}

// --- entitlement cache -----------------------------------------------------

/** Validate anything claiming to be the cached entitlement. */
export function cleanCache(v: unknown): PlusCache | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const raw = v as Record<string, unknown>;
  const plan = raw.plan === "plus" ? "plus" : raw.plan === "free" ? "free" : null;
  if (!plan) return null;
  const until =
    typeof raw.until === "number" && Number.isFinite(raw.until) ? raw.until : null;
  const checkedAt =
    typeof raw.checkedAt === "number" && Number.isFinite(raw.checkedAt) ? raw.checkedAt : 0;
  return { plan, until, checkedAt };
}

export function readCache(): PlusCache | null {
  return cleanCache(readJson(PLUS_KEYS.plus));
}

export function writeCache(cache: PlusCache): void {
  writeJson(PLUS_KEYS.plus, cache);
}

// --- reveal / first run ----------------------------------------------------

/** Validate anything claiming to be the saved one-time reveal. */
export function cleanPreview(v: unknown): PreviewRecord | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const raw = v as Record<string, unknown>;
  if (typeof raw.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date)) return null;
  if (typeof raw.personal !== "number" || !Number.isFinite(raw.personal)) return null;
  if (typeof raw.everyone !== "number" || !Number.isFinite(raw.everyone)) return null;
  const label = typeof raw.label === "string" ? raw.label : "";
  return { date: raw.date, personal: raw.personal, everyone: raw.everyone, label };
}

export function readPreview(): PreviewRecord | null {
  return cleanPreview(readJson(PLUS_KEYS.preview));
}

export function writePreview(preview: PreviewRecord): void {
  writeJson(PLUS_KEYS.preview, preview);
}

export function readPreviewSeen(): boolean {
  return readFlag(PLUS_KEYS.previewSeen);
}

export function writePreviewSeen(seen: boolean): void {
  writeFlag(PLUS_KEYS.previewSeen, seen);
}

export function readFirstRunDone(): boolean {
  return readFlag(PLUS_KEYS.firstRunDone);
}

export function writeFirstRunDone(done: boolean): void {
  writeFlag(PLUS_KEYS.firstRunDone, done);
}

// --- Beach Mode Off suppression ---------------------------------------------

/** Validate anything claiming to be a stored Off suppression. */
export function cleanOffSuppression(v: unknown): OffSuppression | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const raw = v as Record<string, unknown>;
  if (typeof raw.slug !== "string" || !raw.slug) return null;
  if (typeof raw.since !== "number" || !Number.isFinite(raw.since)) return null;
  if (typeof raw.lat !== "number" || !Number.isFinite(raw.lat)) return null;
  if (typeof raw.lon !== "number" || !Number.isFinite(raw.lon)) return null;
  return { slug: raw.slug, since: raw.since, lat: raw.lat, lon: raw.lon };
}

export function readOffSuppression(): OffSuppression | null {
  return cleanOffSuppression(readJson(PLUS_KEYS.offSuppression));
}

export function writeOffSuppression(suppression: OffSuppression | null): void {
  if (!suppression) remove(PLUS_KEYS.offSuppression);
  else writeJson(PLUS_KEYS.offSuppression, suppression);
}

// --- pending writes (failed saves waiting to retry) -------------------------
//
// Small queue for the three kinds of save that can silently diverge from the
// server on a bad connection: profile, home beach, prefs. The merge rules
// (supersede vs. per-key merge) live in lib/plus/pendingWrites.ts and are
// tested there directly; this is just that structure's localStorage wiring.

/** Validate anything claiming to be the pending-writes queue. Corrupt or
 *  partly-unreadable input degrades to whatever pieces of it ARE readable,
 *  never to a crash — losing a queued edit is bad, but throwing is worse. */
function cleanPendingWrites(v: unknown): PendingWrites {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const raw = v as Record<string, unknown>;
  const out: PendingWrites = {};
  const profile = cleanProfile(raw.profile);
  if (profile) out.profile = profile;
  if (typeof raw.homeSlug === "string" && raw.homeSlug) out.homeSlug = raw.homeSlug;
  if (raw.prefs && typeof raw.prefs === "object" && !Array.isArray(raw.prefs)) {
    const prefs: Partial<AlertPrefs> = {};
    for (const k of ALERT_KEYS) {
      const val = (raw.prefs as Record<string, unknown>)[k];
      if (typeof val === "boolean") prefs[k] = val;
    }
    if (Object.keys(prefs).length) out.prefs = prefs;
  }
  if (raw.purchaseSync === true) out.purchaseSync = true;
  return out;
}

export function readPending(): PendingWrites {
  return cleanPendingWrites(readJson(PLUS_KEYS.pending));
}

function writePendingRaw(p: PendingWrites): void {
  if (pendingIsEmpty(p)) remove(PLUS_KEYS.pending);
  else writeJson(PLUS_KEYS.pending, p);
}

/** Queue a profile edit, superseding whatever was pending before — a later
 *  local edit always wins over an earlier unsent one. */
export function queuePendingProfile(profile: ScoreProfile): void {
  writePendingRaw(mergeProfile(readPending(), profile));
}

export function queuePendingHome(slug: string): void {
  writePendingRaw(mergeHomeSlug(readPending(), slug));
}

/** Merge a prefs patch into what is pending, per key — so toggling two
 *  different alerts offline queues both instead of the second overwriting
 *  the first. */
export function queuePendingPrefs(patch: Partial<AlertPrefs>): void {
  writePendingRaw(mergePrefs(readPending(), patch));
}

/** The store confirmed a purchase but syncPurchase() failed to reach the
 *  server — remember to retry it on the next foreground/online/mount. */
export function queuePendingPurchaseSync(): void {
  writePendingRaw(mergePurchaseSync(readPending()));
}

export function clearPendingPurchaseSync(): void {
  writePendingRaw(clearField(readPending(), "purchaseSync"));
}

export function clearPendingProfile(): void {
  writePendingRaw(clearField(readPending(), "profile"));
}

export function clearPendingHome(): void {
  writePendingRaw(clearField(readPending(), "homeSlug"));
}

export function clearPendingPrefs(): void {
  writePendingRaw(clearField(readPending(), "prefs"));
}

/** Drop just the given keys from pending prefs — used when only some of a
 *  multi-key patch has landed (or been rejected), leaving the rest queued. */
export function clearPendingPrefsKeys(keys: readonly string[]): void {
  writePendingRaw(clearPrefsKeys(readPending(), keys));
}

// --- Beach Session Live Activity opt-in -------------------------------------
//
// One-time choice, asked the first time Beach Mode arms with the plugin
// available (`bd:live-activity`). `null` means "never asked" — BeachModeCard
// shows the prompt exactly once and then always has an explicit "on"/"off".

/** Validate anything claiming to be the saved Live Activity preference. */
export function cleanLiveActivityPref(v: unknown): "on" | "off" | null {
  return v === "on" || v === "off" ? v : null;
}

export function readLiveActivityPref(): "on" | "off" | null {
  const s = store();
  if (!s) return null;
  try {
    return cleanLiveActivityPref(s.getItem(PLUS_KEYS.liveActivity));
  } catch {
    return null;
  }
}

export function writeLiveActivityPref(pref: "on" | "off"): void {
  const s = store();
  if (!s) return;
  try {
    s.setItem(PLUS_KEYS.liveActivity, pref);
  } catch {
    /* quota / private mode */
  }
}

// --- Beach Session Live Activity dismissal ----------------------------------
//
// A ref alone (BeachModeCard's `laDismissedRef`) only survives for as long as
// the component stays mounted — a backgrounded app or a relaunch loses it,
// so the card would recreate the exact activity the user just swiped away.
// Persisted here, keyed on the armed session's `armedUntil` so it applies to
// THIS session only and doesn't linger onto the next arm.

/** Validate anything claiming to be a saved Live Activity dismissal. */
export function cleanLiveActivityDismissal(v: unknown): LiveActivityDismissal | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const raw = v as Record<string, unknown>;
  if (typeof raw.slug !== "string" || !raw.slug) return null;
  if (typeof raw.armedUntil !== "number" || !Number.isFinite(raw.armedUntil)) return null;
  return { slug: raw.slug, armedUntil: raw.armedUntil };
}

export function readLiveActivityDismissal(): LiveActivityDismissal | null {
  return cleanLiveActivityDismissal(readJson(PLUS_KEYS.liveActivityDismissed));
}

/** `null` clears it — used once the armed session it applied to has ended. */
export function writeLiveActivityDismissal(dismissal: LiveActivityDismissal | null): void {
  if (!dismissal) remove(PLUS_KEYS.liveActivityDismissed);
  else writeJson(PLUS_KEYS.liveActivityDismissed, dismissal);
}

// --- Install token (Codex review #1) ----------------------------------------
//
// Minted once by POST /api/devices and returned exactly once in that
// response's `installToken` field. Stored here as a plain string (not JSON —
// same reasoning as the boolean flags above: nothing to validate as a shape,
// just "is there a non-empty string"), and sent by lib/plus/api.ts as the
// `x-install-token` header on every Plus API call.

export function readInstallToken(): string | null {
  const s = store();
  if (!s) return null;
  try {
    const v = s.getItem(PLUS_KEYS.installToken);
    return v || null;
  } catch {
    return null;
  }
}

export function writeInstallToken(token: string): void {
  const s = store();
  if (!s || !token) return;
  try {
    s.setItem(PLUS_KEYS.installToken, token);
  } catch {
    /* quota / private mode */
  }
}

/** Drop a locally-cached token that the server no longer recognizes (a
 *  `no-token` 401) — used by `lib/plus/client.ts`'s `bootstrapInstallToken`
 *  before it retries the mint so a stale value can't be read back and resent
 *  on the very next call. */
export function clearInstallToken(): void {
  remove(PLUS_KEYS.installToken);
}
