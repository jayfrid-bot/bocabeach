// Device/presence types for the Beach Day Plus store. Row types mirror the D1
// schema (snake_case, migrations/0001_init.sql); `DeviceRecord` is the camelCase
// shape every API route returns. Pure — no I/O, so it is safe to import from
// client code that only needs the types.

import type { ScoreProfile } from "@/lib/profile/types";

/** Every alert the engine can send. Prefs default to all-on. */
export type AlertKey =
  | "lightning"
  | "thunder"
  | "severe"
  | "rain-soon"
  | "rain-clearing"
  | "wind-gust"
  | "flag"
  | "rip"
  | "water-advisory"
  | "morning"
  | "score-excellent";

export const ALERT_KEYS: readonly AlertKey[] = [
  "lightning",
  "thunder",
  "severe",
  "rain-soon",
  "rain-clearing",
  "wind-gust",
  "flag",
  "rip",
  "water-advisory",
  "morning",
  "score-excellent",
] as const;

/**
 * The alert keys the legacy KV `prefs.safety` toggle covered — the set a device
 * imported from KV (and the old native register call) maps its single "safety"
 * switch onto. The rest keep their default.
 */
export const SAFETY_ALERT_KEYS: readonly AlertKey[] = [
  "lightning",
  "thunder",
  "severe",
  "flag",
  "rip",
  "water-advisory",
] as const;

export type AlertPrefs = Record<AlertKey, boolean>;

/** All-on prefs — the default for a device that has never set any. */
export function defaultPrefs(): AlertPrefs {
  const out = {} as AlertPrefs;
  for (const k of ALERT_KEYS) out[k] = true;
  return out;
}

export type Platform = "ios" | "android" | "web";
export type Plan = "free" | "plus";
export type PresenceSource = "auto" | "manual";

/**
 * A person's beach taste, exactly as the scoring engine defines it. The store
 * only round-trips it as JSON and never interprets it, but sharing the type
 * means the column and `resolveScoring()` can never drift apart.
 */
export type StoredProfile = ScoreProfile;
export type { ProfileId, ScoreProfile } from "@/lib/profile/types";

/** Push dedup state — same shape the legacy KV record carried. */
export interface SentState {
  morningDate?: string;
  safetyKey?: string;
  safetyAt?: string;
}

/** One row of `devices`, exactly as D1 stores it. */
export interface DeviceRow {
  id: string;
  platform: string | null;
  push_token: string | null;
  tz: string | null;
  home_slug: string | null;
  profile_json: string | null;
  prefs_json: string | null;
  plan: string;
  entitlement_until: number | null;
  trial_used: number;
  preview_seen: number;
  sent_json: string | null;
  created_at: number;
  updated_at: number;
}

/** One row of `presence`, exactly as D1 stores it. */
export interface PresenceRow {
  device_id: string;
  slug: string;
  lat: number | null;
  lon: number | null;
  accuracy_m: number | null;
  fix_at: number | null;
  armed_until: number;
  source: string;
  updated_at: number;
}

/** The API shape: what every Plus route returns as `device`. */
export interface DeviceRecord {
  id: string;
  platform: Platform | null;
  tz: string | null;
  homeSlug: string | null;
  profile: StoredProfile | null;
  prefs: AlertPrefs;
  plan: Plan;
  entitlementUntil: number | null;
  trialUsed: boolean;
  previewSeen: boolean;
  presence: { slug: string; armedUntil: number; source: PresenceSource } | null;
}

/**
 * Fields an upsert may change. Anything left `undefined` is untouched; `null`
 * clears a nullable column. `prefs` is MERGED over the stored prefs (so a client
 * can flip one toggle); everything else replaces.
 */
export interface DevicePatch {
  platform?: Platform | null;
  pushToken?: string | null;
  tz?: string | null;
  homeSlug?: string | null;
  profile?: StoredProfile | null;
  prefs?: Partial<AlertPrefs>;
  plan?: Plan;
  entitlementUntil?: number | null;
  trialUsed?: boolean;
  previewSeen?: boolean;
  sent?: SentState;
}

/** An armed "I'm at the beach" window. */
export interface PresenceInput {
  slug: string;
  lat?: number | null;
  lon?: number | null;
  accuracyM?: number | null;
  fixAt?: number | null;
  armedUntil: number;
  source: PresenceSource;
}

/** A device with a live presence window — what the alerts engine iterates. */
export interface ArmedDevice {
  device: DeviceRecord;
  presence: {
    slug: string;
    lat: number | null;
    lon: number | null;
    accuracyM: number | null;
    fixAt: number | null;
    armedUntil: number;
    source: PresenceSource;
  };
}

/** A device with a push token — the sender's working shape. */
export interface PushableDevice {
  device: DeviceRecord;
  token: string;
  platform: "ios" | "android";
  sent: SentState;
}

/** A previously sent alert, for the engine's repeat window. */
export interface AlertMark {
  sentAt: number;
  meta: unknown;
}

/** Anything that can answer "is this device entitled" — a row or a record. */
type EntitlementLike =
  | { plan: string; entitlement_until: number | null }
  | { plan: string; entitlementUntil: number | null };

/** Plus and not expired. The single gate for every paid feature. */
export function entitled(device: EntitlementLike, now: number): boolean {
  if (device.plan !== "plus") return false;
  const until =
    "entitlement_until" in device ? device.entitlement_until : device.entitlementUntil;
  return typeof until === "number" && until > now;
}

function isPlatform(v: unknown): v is Platform {
  return v === "ios" || v === "android" || v === "web";
}

/** Parse a stored prefs blob, filling every missing key with its default (true). */
export function parsePrefs(json: string | null | undefined): AlertPrefs {
  const prefs = defaultPrefs();
  if (!json) return prefs;
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    if (!raw || typeof raw !== "object") return prefs;
    for (const k of ALERT_KEYS) {
      if (typeof raw[k] === "boolean") prefs[k] = raw[k] as boolean;
    }
  } catch {
    /* corrupt blob → defaults */
  }
  return prefs;
}

/** Parse a stored profile blob. Anything unreadable reads as "no profile". */
export function parseProfile(json: string | null | undefined): StoredProfile | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    return raw as StoredProfile;
  } catch {
    return null;
  }
}

/** Parse a stored dedup blob. */
export function parseSent(json: string | null | undefined): SentState {
  if (!json) return {};
  try {
    const raw = JSON.parse(json) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return raw as SentState;
  } catch {
    return {};
  }
}

/** A blank device row — every column at its schema default. */
export function newDeviceRow(id: string, now: number): DeviceRow {
  return {
    id,
    platform: null,
    push_token: null,
    tz: null,
    home_slug: null,
    profile_json: null,
    prefs_json: null,
    plan: "free",
    entitlement_until: null,
    trial_used: 0,
    preview_seen: 0,
    sent_json: null,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Apply a patch to a row, returning a NEW row. Shared by both backends so
 * "only provided fields change" (and the prefs merge) can't drift between them.
 */
export function applyPatch(row: DeviceRow, patch: DevicePatch, now: number): DeviceRow {
  const next: DeviceRow = { ...row, updated_at: now };
  if (patch.platform !== undefined) next.platform = patch.platform;
  if (patch.pushToken !== undefined) next.push_token = patch.pushToken;
  if (patch.tz !== undefined) next.tz = patch.tz;
  if (patch.homeSlug !== undefined) next.home_slug = patch.homeSlug;
  if (patch.profile !== undefined) {
    next.profile_json = patch.profile === null ? null : JSON.stringify(patch.profile);
  }
  if (patch.prefs !== undefined) {
    // Merge, so a client can flip one toggle without resending the whole set.
    next.prefs_json = JSON.stringify({ ...parsePrefs(row.prefs_json), ...patch.prefs });
  }
  if (patch.plan !== undefined) next.plan = patch.plan;
  if (patch.entitlementUntil !== undefined) next.entitlement_until = patch.entitlementUntil;
  if (patch.trialUsed !== undefined) next.trial_used = patch.trialUsed ? 1 : 0;
  if (patch.previewSeen !== undefined) next.preview_seen = patch.previewSeen ? 1 : 0;
  if (patch.sent !== undefined) {
    const keys = Object.keys(patch.sent).filter(
      (k) => (patch.sent as Record<string, unknown>)[k] !== undefined,
    );
    next.sent_json = keys.length ? JSON.stringify(patch.sent) : null;
  }
  return next;
}

/** Row (+ its presence row, when armed) → the API record. */
export function toRecord(row: DeviceRow, presence?: PresenceRow | null): DeviceRecord {
  return {
    id: row.id,
    platform: isPlatform(row.platform) ? row.platform : null,
    tz: row.tz ?? null,
    homeSlug: row.home_slug ?? null,
    profile: parseProfile(row.profile_json),
    prefs: parsePrefs(row.prefs_json),
    plan: row.plan === "plus" ? "plus" : "free",
    entitlementUntil: typeof row.entitlement_until === "number" ? row.entitlement_until : null,
    trialUsed: !!row.trial_used,
    previewSeen: !!row.preview_seen,
    presence: presence
      ? {
          slug: presence.slug,
          armedUntil: presence.armed_until,
          source: presence.source === "auto" ? "auto" : "manual",
        }
      : null,
  };
}
