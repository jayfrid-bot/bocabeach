// Device/presence types for the Beach Day Plus store. Row types mirror the D1
// schema (snake_case, migrations/0001_init.sql); `DeviceRecord` is the camelCase
// shape every API route returns. Pure — no I/O, so it is safe to import from
// client code that only needs the types.

import type { ScoreProfile } from "@/lib/profile/types";

/** Every alert the engine can send. Prefs default to all-on, EXCEPT
 *  `"coming-up"` (SKY_EVENTS_PLAN.md §10) and `"sun-color"` — two opt-in
 *  keys, each overridden explicitly in `defaultPrefs()` below rather than by
 *  a blanket rule change, so a future reader can't miss either one. */
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
  | "score-excellent"
  | "coming-up"
  | "sun-color";

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
  "coming-up",
  "sun-color",
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

/** All-on prefs — the default for a device that has never set any —
 *  EXCEPT `"coming-up"` (SKY_EVENTS_PLAN.md §10) and `"sun-color"` (the
 *  sunrise/sunset color alert), which both start OFF: a subscriber opts in
 *  rather than opting out of either sky-related alert. This applies to
 *  every existing device (its stored prefs blob has no `"coming-up"` or
 *  `"sun-color"` key yet, so `parsePrefs` falls back to this default too)
 *  and every brand-new one. */
export function defaultPrefs(): AlertPrefs {
  const out = {} as AlertPrefs;
  for (const k of ALERT_KEYS) out[k] = true;
  out["coming-up"] = false;
  out["sun-color"] = false;
  return out;
}

/**
 * Which sunrise/sunset color quality counts for the "sun-color" alert —
 * `"vivid"`/`"epic"` are `lib/sunQuality.ts`'s own `SunQualityBand` values
 * (labels "Great"/"Amazing"); this is deliberately narrowed to just the two
 * a person can pick as a THRESHOLD (never "good" or worse — nobody wants to
 * be woken for a merely decent sky). See `lib/alerts/sunColor.ts` for the
 * score cutoff each one maps to.
 */
export type SunColorMinBand = "vivid" | "epic";

export const DEFAULT_SUN_COLOR_MIN_BAND: SunColorMinBand = "vivid"; // "Great or better"

/** How long before the event to send the alert — the only choices the
 *  settings sheet offers (components/plus/PlusSettingsSheet.tsx). */
export const SUN_COLOR_LEAD_OPTIONS = [30, 60, 120, 180] as const;
export type SunColorLeadMin = (typeof SUN_COLOR_LEAD_OPTIONS)[number];

export const DEFAULT_SUN_COLOR_LEAD_MIN: SunColorLeadMin = 60;

/** A device's sun-color settings, always resolved to real values (never
 *  null) — `toRecord` below fills in the default the moment a column reads
 *  NULL, so every caller gets a value it can use directly. */
export interface SunColorPrefs {
  minBand: SunColorMinBand;
  leadMin: number;
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
  /** Beach-local date (YYYY-MM-DD) this device's coming-up eligibility was
   *  last EVALUATED at an 8:00 AM run (SKY_EVENTS_PLAN.md §10) — set
   *  regardless of whether an event was found, claimed, or sent. Mirrors
   *  `morningDate`'s role exactly: once it matches today, the push route's
   *  `slugConditionsNeed` stops treating this device as making its beach
   *  "due", so a limited-capacity tick's round-robin slots go to a beach
   *  that still needs a look, not one already checked today (Codex round-2
   *  HIGH — a coming-up-only device with nothing to say would otherwise
   *  stay "due" for the WHOLE 8 AM hour, crowding out other beaches'
   *  morning digests too). */
  comingUpCheckedDate?: string;
  /** The sun-color alert's ESTIMATE-based event identity
   *  (`sun-color:<kind>:<beach-local date>`, lib/alerts/sunColor.ts's
   *  `sunColorEstimateKey`/`sunColorEventKey`) for the LAST event this
   *  device was evaluated for INSIDE its own send window — set regardless
   *  of outcome (nothing eligible / already sent / confirmed sent or dead
   *  token / a lost claim race another run already confirmed), EXCEPT on a
   *  transient send failure or an UNSETTLED claim race, where it is left
   *  unset/stale so a later tick inside the SAME window retries (same
   *  "regardless of outcome, except a retryable one" rule
   *  `comingUpCheckedDate` follows for its own alert). Deliberately the
   *  ESTIMATE's own identity, not the real conditions snapshot's — the two
   *  can legitimately disagree at a boundary (a different local day, or
   *  even a different kind), and the latch must still stop the SELECTOR
   *  (which only ever sees the estimate) from re-selecting this beach for
   *  the event it just evaluated; the snapshot's own true event, if
   *  different, gets its own later estimate window. Unlike
   *  `comingUpCheckedDate` (a calendar date, since coming-up evaluates once
   *  a day), this is keyed to the specific EVENT, since a device can have a
   *  sun-color opportunity at a different hour on a different day — a stale
   *  key for a past event simply never matches a future one's key, so there
   *  is nothing to separately "expire" here. Read by `slugConditionsNeed`
   *  (app/api/push/run/route.ts) via `lib/alerts/sunColor.ts`'s
   *  `sunColorSlugNeed`, so a beach stops being kept `due` once this run's
   *  device has nothing further to send for this hour — otherwise a
   *  cluster of same-timezone beaches could starve each other for the
   *  whole send window. */
  sunColorCheckedKey?: string;
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
  /** `plan` and `entitlement_until` are DERIVED — never written directly.
   *  They are recomputed from the three grant columns below on every write
   *  (migrations/0003_grant_sources.sql), so they can never drift out of sync
   *  with what actually grants access. */
  plan: string;
  entitlement_until: number | null;
  /** Plus bought on the App/Play Store, mirrored from RevenueCat. */
  store_until: number | null;
  /** Plus granted by redeeming a code (`/api/devices/unlock`). */
  code_until: number | null;
  /** The one free trial (`/api/devices/trial`). */
  trial_until: number | null;
  trial_used: number;
  preview_seen: number;
  sent_json: string | null;
  created_at: number;
  updated_at: number;
  /** Install token identity (migrations/0008_device_tokens.sql, Codex review
   *  #1) — sha256 hex digest of the token minted once by POST /api/devices.
   *  `?` (not read by the big multi-column SELECTs every other route uses):
   *  only `lib/db/store.ts`'s dedicated `getInstallTokenHash`/
   *  `setInstallTokenHash` touch these two columns, so a row built without
   *  them (every other query in d1Store.ts/memoryStore.ts) is still a valid
   *  DeviceRow. Never included in `DeviceRecord` — the hash must never reach
   *  an API response. */
  token_hash?: string | null;
  token_issued_at?: number | null;
  /** Epoch ms the current token was first successfully presented and
   *  verified (round-2 #2 followup) — see migrations/0008_device_tokens.sql
   *  and lib/db/installTokenAuth.ts. `?` for the same reason as the two
   *  columns above: only the dedicated install-token store methods touch it. */
  token_used_at?: number | null;
  /** The "sun-color" alert's two settings (migrations/0012_sun_color_prefs.sql).
   *  Two plain nullable columns, not `prefs_json` — that blob is typed as a
   *  strict `Record<AlertKey, boolean>` (see `parsePrefs`/`ALERT_KEYS` below),
   *  and these are a band enum + a lead-time enum, not booleans. NULL means
   *  "use the default" (see `DEFAULT_SUN_COLOR_MIN_BAND`/
   *  `DEFAULT_SUN_COLOR_LEAD_MIN`) — `toRecord` resolves that default so
   *  every reader gets real values. `?` because, like the token columns
   *  above, only devices that ever changed a sun-color setting have these
   *  set; every other query building a `DeviceRow` by hand (not through
   *  `DEVICE_COLS`) is still a valid row without them. */
  sun_color_min_band?: string | null;
  sun_color_lead_min?: number | null;
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

/** The three independent sources Plus access can come from (#4). A device
 *  keeps whichever grants it has ever earned; none of them can shorten
 *  another. `null` means that source has never granted anything. */
export interface DeviceGrants {
  storeUntil: number | null;
  codeUntil: number | null;
  trialUntil: number | null;
}

/** The API shape: what every Plus route returns as `device`. */
export interface DeviceRecord {
  id: string;
  platform: Platform | null;
  tz: string | null;
  homeSlug: string | null;
  profile: StoredProfile | null;
  prefs: AlertPrefs;
  /** Derived: "plus" iff any grant below is still in the future. */
  plan: Plan;
  /** Derived: the latest (max) of the three grants below. */
  entitlementUntil: number | null;
  grants: DeviceGrants;
  trialUsed: boolean;
  previewSeen: boolean;
  /** The "sun-color" alert's two settings, always resolved (never null) —
   *  see `SunColorPrefs`. */
  sunColor: SunColorPrefs;
  presence: {
    slug: string;
    armedUntil: number;
    source: PresenceSource;
    /** The session carries the phone's own coordinates (LOC-03/LOC-05: the
     *  card says whether geometry is "your spot" or "the beach"). The fix
     *  itself is never returned. */
    hasFix: boolean;
  } | null;
}

/**
 * Fields an upsert may change. Anything left `undefined` is untouched; `null`
 * clears a nullable column. `prefs` is MERGED over the stored prefs (so a client
 * can flip one toggle); everything else replaces.
 *
 * `plan` and `entitlementUntil` are NOT patchable — they are derived from
 * `storeUntil`/`codeUntil`/`trialUntil` on every write (#4), so a caller can
 * never accidentally shorten access by writing the derived field directly.
 * Grant a trial through `DeviceStore.claimTrial`, not this patch — it needs
 * the atomic "only if unused" guard from #3.
 */
export interface DevicePatch {
  platform?: Platform | null;
  pushToken?: string | null;
  tz?: string | null;
  homeSlug?: string | null;
  profile?: StoredProfile | null;
  prefs?: Partial<AlertPrefs>;
  storeUntil?: number | null;
  codeUntil?: number | null;
  trialUntil?: number | null;
  trialUsed?: boolean;
  previewSeen?: boolean;
  sent?: SentState;
  /** `null` resets to the default (`DEFAULT_SUN_COLOR_MIN_BAND`). */
  sunColorMinBand?: SunColorMinBand | null;
  /** `null` resets to the default (`DEFAULT_SUN_COLOR_LEAD_MIN`). */
  sunColorLeadMin?: number | null;
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
    store_until: null,
    code_until: null,
    trial_until: null,
    trial_used: 0,
    preview_seen: 0,
    sent_json: null,
    created_at: now,
    updated_at: now,
    token_hash: null,
    token_issued_at: null,
    token_used_at: null,
    sun_color_min_band: null,
    sun_color_lead_min: null,
  };
}

/** Resolve a possibly-NULL/invalid stored band into a real one — an unknown
 *  string (a corrupt write, or a future value this build doesn't know about)
 *  falls back to the default rather than propagating garbage. */
function resolveSunColorMinBand(v: string | null | undefined): SunColorMinBand {
  return v === "epic" ? "epic" : v === "vivid" ? "vivid" : DEFAULT_SUN_COLOR_MIN_BAND;
}

/** Same fallback rule for the lead time — anything not one of the offered
 *  choices (corrupt write, or a future option this build predates) reads as
 *  the default. */
function resolveSunColorLeadMin(v: number | null | undefined): number {
  return typeof v === "number" && (SUN_COLOR_LEAD_OPTIONS as readonly number[]).includes(v)
    ? v
    : DEFAULT_SUN_COLOR_LEAD_MIN;
}

/**
 * The single rule for "what does this device's access add up to" (#4): the
 * LATEST of the three grants, never their sum and never whichever was written
 * most recently. A shorter grant arriving later (a 30-day Restore, say) can
 * never shorten a longer one already on file — it just stops being the max.
 * Both backends call this so they can't drift: d1Store recomputes the same
 * formula in SQL (so it stays correct under a concurrent write), memoryStore
 * calls this function directly.
 */
export function deriveEntitlement(grants: DeviceGrants, now: number): { plan: Plan; until: number | null } {
  const until = Math.max(grants.storeUntil ?? -Infinity, grants.codeUntil ?? -Infinity, grants.trialUntil ?? -Infinity);
  if (!Number.isFinite(until)) return { plan: "free", until: null };
  return { plan: until > now ? "plus" : "free", until };
}

/**
 * Apply a patch to a row, returning a NEW row. Used by the memory backend
 * (and by legacy-import on both backends, which only ever creates a fresh
 * row). d1Store does NOT use this for a live upsert — it needs the patch
 * applied as one atomic SQL statement (#3), not read-then-write in JS.
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
  if (patch.storeUntil !== undefined) next.store_until = patch.storeUntil;
  if (patch.codeUntil !== undefined) next.code_until = patch.codeUntil;
  if (patch.trialUntil !== undefined) next.trial_until = patch.trialUntil;
  if (patch.trialUsed !== undefined) next.trial_used = patch.trialUsed ? 1 : 0;
  if (patch.previewSeen !== undefined) next.preview_seen = patch.previewSeen ? 1 : 0;
  if (patch.sunColorMinBand !== undefined) next.sun_color_min_band = patch.sunColorMinBand;
  if (patch.sunColorLeadMin !== undefined) next.sun_color_lead_min = patch.sunColorLeadMin;
  if (patch.sent !== undefined) {
    const keys = Object.keys(patch.sent).filter(
      (k) => (patch.sent as Record<string, unknown>)[k] !== undefined,
    );
    next.sent_json = keys.length ? JSON.stringify(patch.sent) : null;
  }
  // plan/entitlement_until are derived, always, from whatever the three grant
  // columns now hold — never taken from the patch.
  const derived = deriveEntitlement(
    { storeUntil: next.store_until, codeUntil: next.code_until, trialUntil: next.trial_until },
    now,
  );
  next.plan = derived.plan;
  next.entitlement_until = derived.until;
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
    grants: {
      storeUntil: typeof row.store_until === "number" ? row.store_until : null,
      codeUntil: typeof row.code_until === "number" ? row.code_until : null,
      trialUntil: typeof row.trial_until === "number" ? row.trial_until : null,
    },
    trialUsed: !!row.trial_used,
    previewSeen: !!row.preview_seen,
    sunColor: {
      minBand: resolveSunColorMinBand(row.sun_color_min_band),
      leadMin: resolveSunColorLeadMin(row.sun_color_lead_min),
    },
    presence: presence
      ? {
          slug: presence.slug,
          armedUntil: presence.armed_until,
          source: presence.source === "auto" ? "auto" : "manual",
          hasFix: presence.lat != null && presence.lon != null,
        }
      : null,
  };
}
