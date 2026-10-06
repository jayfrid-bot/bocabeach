// The one storage interface behind every Plus feature. Two backends implement
// it: D1 in production (`d1Store.ts`, binding `DB`) and an in-memory map for
// tests and `next dev` without bindings (`memoryStore.ts`, which mirrors the old
// KV file fallback by persisting to .plus-store.json).
//
// Routes never import a backend directly — they call `getStore()`.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  AlertMark,
  ArmedDevice,
  DevicePatch,
  DeviceRecord,
  PresenceInput,
  PushableDevice,
  SentState,
} from "@/lib/db/types";
import type { NativeSub } from "@/lib/push/nativeStore";
import type {
  ArchiveCandidate,
  BeachHourlyRow,
  CamObservationRow,
  CamReadRow,
  HistoryRecordsResult,
  SunEventObservationRow,
  SunEventPredictionRow,
} from "@/lib/history/types";
import { d1Store, getD1 } from "@/lib/db/d1Store";
import { memoryStore } from "@/lib/db/memoryStore";

// --- Install token identity (migrations/0008_device_tokens.sql, Codex ------
// combined-review #1) — server-only (node:crypto), so this file must never be
// imported from client code. Every caller (both store backends, and the
// /api/devices route that mints) shares these so the hashing rule can never
// drift between where a token is minted and where it is checked.

/** 32 random bytes, base64url — the raw install token handed to a caller
 *  exactly once. Never stored; only `hashInstallToken`'s digest is. */
export function mintInstallToken(): string {
  return randomBytes(32).toString("base64url");
}

/** sha256 hex digest — the one thing ever written to `devices.token_hash`. */
export function hashInstallToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time check of a caller-supplied token against the stored hash —
 *  a wrong-length guess must take exactly as long as a wrong-value one. */
export function installTokenMatches(storedHash: string, candidateToken: string): boolean {
  const a = Buffer.from(storedHash, "hex");
  const b = Buffer.from(hashInstallToken(candidateToken), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- Beach Session Live Activity (migrations/0007_live_activities.sql, ---
// --- docs/LIVE_ACTIVITY_PLAN.md "Server and D1 model") -------------------
//
// One row per ActivityKit activity. `pushToken` is a bearer capability for
// that one activity — callers must never put it in a response body or a log
// line (see the register/end routes).

export type LiveActivityStatus = "active" | "ended";

// --- "Coming up" sky-events alert ledger (migrations/0011_coming_up_ ------
// --- deliveries.sql, docs/SKY_EVENTS_PLAN.md §10, lib/db/comingUpClaims.ts)

export type ComingUpDeliveryStatus = "reserved" | "sent";

/** One `coming_up_deliveries` row, camelCase — mirrors the D1 columns 1:1. */
export interface ComingUpDeliveryRow {
  deviceId: string;
  eventKey: string;
  claimToken: string;
  claimedAt: number;
  sentAt: number | null;
  status: ComingUpDeliveryStatus;
}

/**
 * `claimComingUp`'s outcome (Codex round-4 HIGH — a bare boolean can't tell
 * "someone else's claim is still live, try again once it resolves" apart
 * from "this event is permanently done for this device", and the caller
 * needs that distinction to decide whether the device should stay `due`:
 *  - `"claimed"`: this call won the reservation — go ahead and build/send.
 *  - `"already-sent"`: `alert_log` already has this exact event for this
 *    device — the once-ever dedupe. Nothing to retry, ever.
 *  - `"capped"`: no once-ever record, but the device's 24h/30d cap is
 *    already used up. Nothing to retry THIS event this run, and retrying
 *    sooner won't help (the cap window hasn't moved) — but a DIFFERENT
 *    event next hour might.
 *  - `"in-flight"`: another run currently holds a live (non-abandoned)
 *    reservation for this exact (device, event) pair — a genuine race, not
 *    a terminal outcome. The caller must NOT mark this device "checked"
 *    for today: it should stay `due` so a LATER pass can see whether the
 *    other run finished (→ `already-sent` next time) or abandoned its claim
 *    (→ reclaimable next time).
 */
export type ComingUpClaimResult = "claimed" | "already-sent" | "capped" | "in-flight";

/** One `live_activities` row, camelCase — mirrors the D1 columns 1:1. */
export interface LiveActivityRow {
  activityId: string;
  deviceId: string;
  beachSlug: string;
  schemaVersion: number;
  appBuild: string | null;
  apnsEnvironment: string | null;
  pushToken: string;
  tokenUpdatedAt: number;
  startedAt: number;
  expiresAt: number;
  endedAt: number | null;
  status: LiveActivityStatus;
  lastStateJson: string | null;
  lastStateHash: string | null;
  pendingStateJson: string | null;
  pendingSince: number | null;
  nextSendAt: number | null;
  lastSentAt: number | null;
  lastApnsTimestamp: number | null;
  lastApnsStatus: number | null;
  /** The native plugin's own monotonic per-activity rotation counter (Codex
   *  review #4). `registerLiveActivity` only replaces `pushToken` when the
   *  caller's `rotation` is strictly greater than this. */
  tokenRotation: number;
  /** The wire protocol's own monotonic counter (Codex review #7) — every push
   *  this activity receives (update or end) carries `seq = lastSeq + 1`. */
  lastSeq: number;
}

/**
 * Register or rotate an activity's push token. Idempotent on `activityId`:
 * a second call for the same activity replaces its token/expiry atomically
 * (never touching any other row) and revives it to 'active' if it had
 * ended; `startedAt` is kept from the FIRST call for that activityId, never
 * overwritten by a later rotation, so the 8-hour ActivityKit ceiling is
 * always measured from the real start.
 */
export interface UpsertLiveActivityInput {
  activityId: string;
  deviceId: string;
  beachSlug: string;
  schemaVersion: number;
  appBuild: string | null;
  apnsEnvironment: string | null;
  pushToken: string;
  /** Only used the FIRST time this activityId is seen. */
  startedAt: number;
  expiresAt: number;
}

/** `registerLiveActivity`'s input — `upsertLiveActivity`'s fields plus the
 *  native plugin's own rotation counter. `rotation: null` means the caller
 *  didn't send one (an app build that predates the field) — accepted
 *  unconditionally, same as before this counter existed, and the existing
 *  `token_rotation` on file is left untouched rather than reset. */
export interface RegisterLiveActivityInput extends UpsertLiveActivityInput {
  rotation: number | null;
}

/** `registerLiveActivity`'s failure outcomes (success is a `LiveActivityRow`).
 *  `device-mismatch`: this activityId already belongs to a different device
 *  (a client bug or attack, checked before the write). `not-owner`: the same
 *  fact, but discovered AFTER the write from a lost race (Codex round-3 #2)
 *  — this call's own write did not land because another device's register
 *  for the same brand-new activityId won it first. `stale-rotation`: the
 *  activity is this device's own, but the incoming rotation didn't exceed
 *  what's already on file. `ended`: the activity exists (or existed) for
 *  this device but is no longer 'active' — a register must never silently
 *  reactivate an ended or superseded session (Codex round-3 #3). */
export type RegisterLiveActivityResult =
  | LiveActivityRow
  | "device-mismatch"
  | "not-owner"
  | "stale-rotation"
  | "ended";

// Re-exported so callers can import the whole storage vocabulary from one path.
export type {
  AlertMark,
  ArmedDevice,
  DevicePatch,
  PresenceInput,
  PushableDevice,
} from "@/lib/db/types";
export { isLegacyId, legacyDeviceId, legacyPatch, prefsFromLegacy } from "@/lib/db/legacy";

export interface DeviceStore {
  getDevice(id: string): Promise<DeviceRecord | null>;
  /** Create or patch. Returns the device as it now stands. Atomic and
   *  field-specific in both backends (#3) — a field left out of `patch` is
   *  guaranteed to survive a concurrent write to some other field. */
  upsertDevice(id: string, patch: DevicePatch): Promise<DeviceRecord>;
  /**
   * Grant the free trial, exactly once, no matter how many requests race for
   * it (#3, #4). Sets `trialUntil` and `trialUsed` together in one atomic
   * conditional write — "only if trial_used is still 0" — so two concurrent
   * calls can never both succeed, and returns the sentinel string instead of
   * a record when the trial was already spent.
   */
  claimTrial(id: string, until: number): Promise<DeviceRecord | "trial-used">;
  /**
   * Clear a device's push token, but only if it still equals `expectedToken`
   * (#5). Used when a token turned out to be dead: if the phone re-registered
   * a fresh token in the meantime, this is a no-op instead of erasing the new
   * one. Never touches anything else on the row — entitlement, profile, and
   * trial history all survive a dead-token cleanup.
   */
  clearPushToken(id: string, expectedToken: string): Promise<void>;
  findByPushToken(token: string): Promise<DeviceRecord | null>;
  deleteDevice(id: string): Promise<void>;
  listDevices(): Promise<DeviceRecord[]>;
  /** Entitled devices whose presence window has not expired at `nowMs`. */
  listArmed(nowMs: number): Promise<ArmedDevice[]>;
  setPresence(deviceId: string, p: PresenceInput): Promise<void>;
  clearPresence(deviceId: string): Promise<void>;
  getSent(deviceId: string): Promise<SentState>;
  /** Replace the WHOLE sent-state blob — a field left out of `sent` is
   *  CLEARED, not preserved (the opposite of `patchSent` below). Callers
   *  that only mean to update one or two fields alongside whatever else is
   *  already there want `patchSent`, not this. */
  setSent(deviceId: string, sent: SentState): Promise<void>;
  /**
   * Atomically merge `patch`'s keys into the device's CURRENT sent-state —
   * a field the caller doesn't mention is left exactly as it is, even if
   * another concurrent call changes it in between (Codex round-4 HIGH: the
   * push route's home-digest loop and the at-beach/hourly-fallback runs can
   * overlap, each merging a DIFFERENT field — `morningDate` vs
   * `comingUpCheckedDate` — off the SAME request-start snapshot; a
   * wholesale `setSent({...stale, ...patch})` from either one can silently
   * erase the other's write). D1 does this with a single `json_patch` SQL
   * UPDATE (no read-then-write); the memory backend's own no-await-between-
   * read-and-write guarantee gets there without one. A key set to
   * `undefined` in `patch` is treated as "not mentioned", same as every
   * other patch shape in this file — `SentState` has no nullable fields, so
   * there is no "explicitly clear" case to support here.
   */
  patchSent(deviceId: string, patch: Partial<SentState>): Promise<void>;
  lastAlert(deviceId: string, key: string): Promise<AlertMark | null>;
  markAlert(deviceId: string, key: string, at: number, meta?: unknown): Promise<void>;
  /** Import legacy KV push subscriptions. Idempotent: a token that already has
   *  a device row is skipped, so it never resurrects or clobbers live state. */
  importLegacy(subs: NativeSub[]): Promise<{ imported: number; skipped: number }>;
  /** Raw push token for a device — the sender needs it; the API shape hides it. */
  getPushToken(id: string): Promise<string | null>;
  /** Every device that can receive a push, with its token. */
  listPushable(): Promise<PushableDevice[]>;

  // --- Atomic send claims (#14) — appended, not mixed into the device rows
  // above. See migrations/0004_send_claims.sql and lib/db/sendClaims.ts for
  // the key format and the concurrency story.
  /**
   * Claim the right to send one alert. Returns true only for the caller that
   * wins the race for `key` (built with `sendClaimKey`); every other
   * concurrent caller gets false and must not send. A claim with no
   * `markSent` after `ABANDONED_CLAIM_MS` may be re-claimed.
   */
  claimSend(key: string, now: number): Promise<boolean>;
  /**
   * Record that a claimed send actually went out. `claimedAt` MUST be the
   * exact value the caller originally passed to `claimSend` for this key —
   * it doubles as both `sent_at`'s value and the ownership check
   * (`WHERE ... AND claimed_at = ?`, round-2 item 1): if the claim was
   * abandoned and reclaimed by a LATER run in the meantime (which stamps a
   * NEW `claimed_at`), this stale caller's write no longer matches and is a
   * no-op — it must never mark a claim it no longer owns as sent. Returns
   * whether the write actually matched (false = lost ownership to a
   * reclaim; the caller should log this, not treat it as a hard failure —
   * the send itself already happened).
   */
  markSent(key: string, claimedAt: number): Promise<boolean>;
  /**
   * Release a claimed-but-unsent send immediately (a transient transport
   * failure, or a decision not to send after all) — deletes the row only
   * when it still belongs to THIS caller (`claimedAt` must match the row's
   * current `claimed_at`, same ownership guard as `markSent`) and was never
   * marked sent (defensive: never undo a confirmed send, and never delete a
   * row a LATER run has since reclaimed). Freeing the claim right away,
   * rather than waiting out `ABANDONED_CLAIM_MS`, lets a genuinely failed
   * attempt be retried by the very next cron tick instead of sitting
   * unclaimable until the abandonment window passes — which mattered for
   * the sun-color alert's short send window. Returns whether the delete
   * actually matched (false = lost ownership to a reclaim; the caller
   * should log this — nothing to release anymore, the reclaimer owns it).
   */
  releaseSend(key: string, claimedAt: number): Promise<boolean>;
  /** Drop claims old enough (`CLAIM_RETENTION_MS`) to never matter again. */
  pruneSendClaims(now: number): Promise<void>;
  /**
   * Blank the stored fix (lat/lon/accuracy/fixAt) on every presence row whose
   * window has run out. The row and its slug stay — the card still knows which
   * beach was last monitored — but a phone's coordinates have no business
   * outliving the window they were sent for. Returns how many rows changed.
   */
  purgeExpiredPresenceFixes(now: number): Promise<number>;

  // --- Hourly history archive (Part A, migrations/0006_history.sql) --------
  /**
   * Conditional upsert: only replaces an existing (slug, hour_utc) row when
   * `row.snapshot_generated_at` is strictly newer than what's already there —
   * so a stale/retried build can never clobber a fresher archived snapshot.
   * Returns whether a write actually happened.
   */
  upsertBeachHourly(row: BeachHourlyRow): Promise<{ written: boolean }>;
  /**
   * Sun-event prediction log (migrations/0013): upsert the (0-2) rows built
   * for one archive pass — ONE statement on D1. Keyed by (slug, event_kind,
   * event_iso, as_of_hour_utc); an existing row is replaced only by a
   * strictly newer `snapshot_generated_at`, and the reserved observed_*
   * columns are never touched. Kept permanently. Returns rows changed.
   */
  upsertSunEventPredictions(rows: SunEventPredictionRow[]): Promise<{ written: number }>;
  // --- Cam archive (migrations/0006 cam_observations + 0014 cam_reads) ------
  /** Newest `captured_at_utc` stored for a beach, or null when none. */
  latestCamObservationUtc(slug: string): Promise<string | null>;
  /** Stored `captured_at_utc` values for a beach at or after `sinceUtc`. */
  camObservationUtcsSince(slug: string, sinceUtc: string): Promise<string[]>;
  /** INSERT OR IGNORE on (slug, captured_at_utc) — re-archiving the same feed
   *  entry is a no-op. Returns rows actually inserted. */
  insertCamObservations(rows: CamObservationRow[]): Promise<{ written: number }>;
  /** INSERT OR IGNORE on (slug, captured_at_utc, cam_id). */
  insertCamReads(rows: CamReadRow[]): Promise<{ written: number }>;
  /** A beach's stored cam observations at or after `sinceUtc`, oldest first. */
  camObservationsSince(slug: string, sinceUtc: string): Promise<CamObservationRow[]>;
  /** Every stored per-cam read for one beach + capture instant. */
  camReadsAt(slug: string, capturedAtUtc: string): Promise<CamReadRow[]>;
  /** Every prediction logged for one beach's one event, oldest `as_of_hour_utc`
   *  first — how the forecast for that event evolved as it approached. */
  sunEventPredictionsFor(slug: string, eventIso: string): Promise<SunEventPredictionRow[]>;
  /**
   * Sun-event observations (migrations/0015, scripts/sun_cam_check.py): upsert
   * one cam's scored observation of one event (keyed slug + event_kind +
   * event_date_local + cam_id), THEN fill observed_score / observed_source /
   * observed_at on the matching sun_event_predictions rows (same slug +
   * event_kind, event_iso within +-15 min).
   *
   * The upsert replaces a stored row only when the incoming (score_version,
   * scored_at) is strictly newer (isNewerSunScore), so an exact duplicate or a
   * stale replay is a no-op (`stored: false`) and a late retry can never
   * overwrite a newer re-score. created_at keeps the first-received time.
   *
   * When several cams have reported the same event, the BEST one is written
   * onto the predictions: solar view before antisolar, then the smaller
   * distance_mi, then cam_id. So an antisolar observation never overwrites a
   * solar one, whatever order they arrive in. A prediction row whose
   * observed_source was set by something other than a sun cam (a manual label)
   * is left alone, and a row that already holds the best observation is not
   * rewritten. Returns whether the row was stored and how many prediction rows
   * changed.
   */
  recordSunEventObservation(row: SunEventObservationRow): Promise<{ stored: boolean; predictionsUpdated: number }>;
  /** Every observation of one beach's one event, best first (solar before
   *  antisolar, then nearest cam). */
  sunEventObservationsFor(
    slug: string,
    eventKind: "sunrise" | "sunset",
    eventDateLocal: string,
  ): Promise<SunEventObservationRow[]>;
  /**
   * Every served beach (curated + generated) that has no `beach_hourly` row
   * for the CURRENT UTC hour yet, filtered by the daylight rule for
   * `tier: "auto"` beaches (curated beaches are candidates every hour).
   */
  listArchiveCandidates(nowMs: number): Promise<ArchiveCandidate[]>;
  /** Open-Meteo call-budget guard (docs/HISTORY_AND_IMAGERY_PLAN.md): builds
   *  already spent today (UTC calendar day). Reporting only — the actual gate
   *  is `reserveHistoryBuild`. */
  getHistoryBudget(day: string): Promise<number>;
  /**
   * Atomically reserve one build's worth of the daily budget for `day` (UTC
   * calendar day) — ONE conditional statement, "increment only if
   * builds < max". Returns whether the reservation succeeded; the caller must
   * reserve BEFORE calling getConditions, never bump after the fact, or two
   * overlapping cron calls can both read the same remaining budget and both
   * proceed (Codex review 2026-09-22). A build that fails after a successful
   * reservation does NOT give the unit back — conservative, and simpler than
   * tracking in-flight reservations. `max <= 0` always refuses outright
   * (Codex round-2 finding #2) — without this, the first INSERT branch of the
   * UPSERT sets `builds = 1` unconditionally, so a caller-supplied
   * `?batch=`/env of 0 would still let exactly one build through per day.
   */
  reserveHistoryBuild(day: string, max: number): Promise<boolean>;
  /**
   * Atomically claim the right to build history for (slug, hour_utc) this
   * run — same abandonment-window shape as `claimSend`/`send_claims`
   * (Codex round-2 finding #4): wins when no claim exists yet, OR the
   * existing claim is older than `ABANDONED_CLAIM_MS` (10 min) and was never
   * completed. Call BEFORE `reserveHistoryBuild` and before fetching, so two
   * overlapping cron calls never both build the same beach/hour. A winner
   * that goes on to write a row must call `completeHistoryClaim`; a winner
   * that must give the hour up at once (rather than let the claim expire)
   * calls `releaseHistoryClaim`. (Since the archiver builds directly, the
   * stale-cache release that motivated it no longer happens.)
   */
  claimHistoryBuild(slug: string, hourUtc: string, now: number): Promise<boolean>;
  /** Mark a claimed (slug, hour_utc) build as done — the claim can never be
   *  re-claimed after this, even once ABANDONED_CLAIM_MS has passed. */
  completeHistoryClaim(slug: string, hourUtc: string, now: number): Promise<void>;
  /**
   * Delete a claim outright (unlike `completeHistoryClaim`, which marks it
   * done). Used when a winning claim turns out to be unusable — the caller's
   * `getConditions` cache handed back a snapshot generated before the
   * claimed hour even started — so the next tick can retry immediately
   * instead of waiting out the full abandonment window.
   */
  releaseHistoryClaim(slug: string, hourUtc: string): Promise<void>;

  // --- Hourly history READ (Plus "Last N days" feature, docs/HISTORY_AND_ ---
  // --- IMAGERY_PLAN.md Part A) -----------------------------------------------
  /**
   * Every `beach_hourly` row for `slug` with `local_date` in
   * [`sinceLocalDate`, `untilLocalDate`] inclusive (YYYY-MM-DD, beach-local —
   * the same `local_date` column the archiver writes), oldest first. Only
   * `row_kind = 'snapshot'` rows come back — a `cam-backfill` row has no
   * score and must never be summarized as if it did. One query, no
   * aggregation here: `lib/history/summary.ts` turns the rows into day
   * summaries. `untilLocalDate` is normally "today" (the API route passes
   * its own beach-local today) — bounding BOTH ends keeps the route's "≤31
   * days" claim literally true, since without it a clock skew or a stray
   * future-dated row could pull in more than the caller asked for.
   */
  hourlyHistory(slug: string, sinceLocalDate: string, untilLocalDate: string): Promise<BeachHourlyRow[]>;
  /**
   * Lifetime records for `slug` — best score, hottest sand, biggest surf,
   * quietest midday reading — each the single (slug, hour) row that wins
   * its own ORDER BY/LIMIT 1 across the WHOLE `beach_hourly` archive for
   * this beach, never bounded by any `days` window (Codex review: records
   * must survive switching the 7/14/30 chip, and must not silently regress
   * as a beach accumulates more history than the widest window shows).
   * `archiveStartedAt` (MIN(local_date)) and `dayCount`
   * (COUNT(DISTINCT local_date)) describe the same lifetime archive — the
   * UI's "Records since <archiveStartedAt>" caption and its 30-day chip gate
   * both read off `archiveStartedAt`, never a hardcoded date. A beach with
   * no snapshot rows at all returns `{ records: [], archiveStartedAt: null,
   * dayCount: 0 }`.
   */
  historyRecords(slug: string): Promise<HistoryRecordsResult>;

  // --- Install token identity (migrations/0008_device_tokens.sql, Codex ----
  // combined-review #1) --------------------------------------------------
  /** The stored sha256 hex digest, or null when this device has never been
   *  issued a token. Never returns the raw token — there isn't one to
   *  return, only the hash (see `installTokenMatches`). */
  getInstallTokenHash(id: string): Promise<string | null>;
  /**
   * Atomically set `token_hash`/`token_issued_at`, but ONLY when the row
   * currently has no hash (mirrors `claimTrial`'s exactly-once guard) —
   * returns true iff THIS call is the one that set it, which is the caller's
   * (POST /api/devices) signal that it may return the raw token in this
   * response, exactly once. A device row must already exist (upsert it
   * first); a missing row returns false rather than creating one half-built.
   */
  setInstallTokenHash(id: string, tokenHash: string, issuedAt: number): Promise<boolean>;
  /** Epoch ms the current token was first successfully presented and
   *  verified, or null when it has never been used yet, or this device has
   *  no token at all. Cheap diagnostics only — nothing gates on this value.
   *  See lib/db/installTokenAuth.ts's THREAT MODEL comment for the current
   *  recovery model (there isn't a server-side recovery path: a device that
   *  loses its token after use reads as `no-token` and degrades to "not
   *  available" client-side; reinstall + RevenueCat restore-purchases is
   *  how the entitlement comes back). */
  getInstallTokenUsedAt(id: string): Promise<number | null>;
  /**
   * Mark the CURRENT token used, once — a single `UPDATE ... WHERE
   * token_used_at IS NULL`, called from lib/db/installTokenAuth.ts's shared
   * `requireInstallToken` on every successfully authenticated
   * register/end/hazards call. A no-op (and cheap) on every call after the
   * first for a given token. Diagnostics only.
   */
  markInstallTokenUsed(id: string, usedAt: number): Promise<void>;

  // --- Beach Session Live Activity (migrations/0007_live_activities.sql) --
  /** Register a new activity, or atomically rotate an existing one's token.
   *  Superseded by `registerLiveActivity` for the register ROUTE (which needs
   *  the ownership/rotation/one-batch guarantees below); this lower-level
   *  primitive is kept for direct test setup and any caller that doesn't
   *  need those guarantees. */
  upsertLiveActivity(input: UpsertLiveActivityInput): Promise<LiveActivityRow>;
  /**
   * The register route's real entry point (Codex review #4): supersedes any
   * OTHER active row for this device and upserts/rotates the given one in a
   * single atomic step (a D1 batch, or — for the memory backend — the same
   * no-`await`-in-between guarantee every other read-modify-write here
   * relies on), so a device can never be observed holding two 'active' rows,
   * and two callers racing for the same device can't interleave their
   * supersede and upsert. Returns:
   *   - "device-mismatch" when `activityId` already belongs to a DIFFERENT
   *     device — ownership can never move.
   *   - "stale-rotation" when `input.rotation` is a number that is not
   *     strictly greater than the row's stored `tokenRotation` — an
   *     out-of-order token upload, left untouched.
   *   - the row, on success. `input.rotation === null` (a caller that never
   *     sent a rotation counter) always succeeds and leaves `tokenRotation`
   *     as it was.
   */
  registerLiveActivity(input: RegisterLiveActivityInput): Promise<RegisterLiveActivityResult>;
  /**
   * Recompute `expires_at` from the CURRENT presence/entitlement (Codex
   * review #3) — called every fan-out pass and on token rotation, never left
   * as the value frozen at registration time. A presence extension can raise
   * it; a shrunk presence, an entitlement lapse, or a rotation can only lower
   * it, and it can never exceed the row's own ORIGINAL `startedAt + 8h`
   * (ActivityKit's ceiling) even across a rotation — the caller computes
   * that bound (`LIVE_ACTIVITY_MAX_SESSION_MS` in
   * lib/liveActivity/server/decide.ts) from the row's own `startedAt`, this
   * just persists it. A no-op if the row doesn't exist.
   */
  setLiveActivityExpiry(activityId: string, expiresAt: number): Promise<void>;
  /** Advance the row's `next_send_at` round-robin cursor without touching
   *  anything else (Codex review #2) — used by the bounded fan-out so a row
   *  the run actually considered (whether or not it ended up sending) moves
   *  to the back of the queue, and a row skipped for being over
   *  `LA_MAX_PER_RUN` keeps its old (earlier) cursor and sorts first next
   *  run. A no-op if the row doesn't exist. */
  touchLiveActivityCursor(activityId: string, nextSendAt: number): Promise<void>;
  /** Every 'active' row, for the cron's fan-out + due-end sweep. */
  listActiveLiveActivities(now: number): Promise<LiveActivityRow[]>;
  /** Every row (active or ended) for one device — the end route uses this to
   *  confirm an activityId actually belongs to the caller's device before
   *  ending it, and the register route uses it to find this device's other
   *  active rows (one active session per device). */
  listLiveActivitiesForDevice(deviceId: string): Promise<LiveActivityRow[]>;
  /** Flip status → 'ended', stamp endedAt = `now` (explicit, like
   *  `markAlert`/`claimSend` — never `Date.now()` internally, so a run's own
   *  injected clock also governs when a row becomes eligible for
   *  `purgeLiveActivities`). A no-op if already ended or the id doesn't
   *  exist. `reason` is diagnostics only (not stored as its own column —
   *  folded into the caller's logs). `clearToken` (Codex review #10): blanks
   *  `push_token` to `""` in the SAME write — the column stays `NOT NULL`
   *  (no schema change needed), but an empty string is never a usable bearer
   *  credential, so this is effectively "forget the token now" rather than
   *  retaining it for the full 72h `purgeLiveActivities` window. Callers
   *  pass it whenever the token is truly done being useful: the due-end
   *  sweep on a successful or permanently-rejected (410/BadDeviceToken) end
   *  push, the explicit Off/dismiss route, and a superseded row. */
  markLiveActivityEnded(
    activityId: string,
    reason: string,
    now: number,
    opts?: { clearToken?: boolean },
  ): Promise<void>;
  /** Record a push that was actually sent: advances lastSentAt/
   *  lastApnsTimestamp/lastApnsStatus, the last-sent state (hash, and the
   *  full state JSON so the next run can read back e.g. the lightning
   *  sub-state for the escalation check), `lastSeq` (the wire protocol's own
   *  monotonic counter, Codex review #7), and `nextSendAt` (the bounded
   *  fan-out's round-robin cursor, Codex review #2 — same as
   *  `touchLiveActivityCursor`, folded in here so a caller that already sent
   *  doesn't need a second write). */
  recordLiveActivitySend(
    activityId: string,
    send: { timestamp: number; status: number; hash: string; stateJson?: string; seq: number },
  ): Promise<void>;
  /**
   * Atomically claim the NEXT wire seq AND the APNs payload timestamp for an
   * active row in the SAME write — `last_seq = last_seq + 1, last_sent_at =
   * MAX(COALESCE(last_sent_at, 0) + 1, ?)` (Codex round-3 fix), read back
   * together. Must be called BEFORE the APNs send, never after: reading
   * `row.lastSeq`/`row.lastSentAt` from an earlier SELECT and computing both
   * in JS left a race window (the network call in between) where two
   * overlapping runs could allocate seq N+1/N+2 but hand out timestamps out
   * of order relative to that seq — ActivityKit orders updates by
   * TIMESTAMP, so a lower timestamp on a higher seq can make the client
   * discard the newer content. Folding the timestamp into this same atomic
   * statement makes seq and timestamp strictly co-monotonic: allocation N+1
   * always gets both a higher seq AND a higher (or equal, via `now`)
   * timestamp than allocation N. A null return means the row is gone or no
   * longer 'active' by the time this runs — the caller must skip the send
   * rather than invent a seq or timestamp. Both values are durably persisted
   * the moment this resolves, so a crash or timeout between allocating and
   * the APNs call just burns that one number/timestamp rather than ever
   * reusing them. */
  allocateLiveActivitySeq(activityId: string, now: number): Promise<{ seq: number; timestampMs: number } | null>;
  /** Delete 'ended' rows whose endedAt is strictly before `cutoffMs` (the
   *  caller passes `now - retentionMs`, keeping the store deterministic and
   *  clock-injectable like every other method here). Returns how many rows
   *  were deleted. */
  purgeLiveActivities(cutoffMs: number): Promise<number>;

  // --- "Coming up" sky-events alert ledger (migrations/0011_coming_up_ ----
  // --- deliveries.sql, docs/SKY_EVENTS_PLAN.md §10) ------------------------
  //
  // Every clock is an explicit `nowMs` parameter — no `Date.now()` inside
  // any of these, same SSR-safety rule as every other clock-taking method
  // here (§9).
  /**
   * Atomically reserve the right to deliver `eventKey` to `deviceId`, or
   * refuse on any of three independent grounds (§10, discriminated per
   * `ComingUpClaimResult` above — Codex round-4 HIGH): (a) `eventKey`
   * already has a row in `alert_log` for this device — the once-ever
   * dedupe, which survives `coming_up_deliveries` being pruned, since
   * `alert_log` is the durable record, not this ledger (→ `"already-sent"`);
   * (b) granting the reservation would push this device's SENT rows plus
   * still-live (non-abandoned) reservations, within the trailing 24-hour or
   * 30-day window, to or past the cap (`COMING_UP_MAX_PER_24H`/
   * `COMING_UP_MAX_PER_30D`, lib/db/comingUpClaims.ts) (→ `"capped"`); or
   * (c) a DIFFERENT, still-live (non-abandoned) reservation for this exact
   * (deviceId, eventKey) already exists — another run got there first and
   * hasn't finished yet (→ `"in-flight"`, never treated as terminal by a
   * caller). All checks and the reservation insert happen atomically. A
   * previously ABANDONED reservation for the same (deviceId, eventKey) —
   * unsent and older than `ABANDONED_CLAIM_MS` — may be reclaimed with a
   * fresh token, re-checked against the caps at the moment of reclaim
   * (→ `"claimed"`).
   */
  claimComingUp(deviceId: string, eventKey: string, claimToken: string, nowMs: number): Promise<ComingUpClaimResult>;
  /**
   * Confirm a claimed send: sets `sent_at = nowMs` on the reservation AND
   * writes the durable `alert_log` row (`alert_key = eventKey`) — together,
   * in one atomic write, so a crash between the two can never leave the
   * ledger and the once-ever dedupe record disagreeing. Only the caller
   * holding the CURRENT `claim_token` for this row may complete it — a
   * stale claimant that lost a race to a newer (reclaimed) token silently
   * does nothing.
   */
  completeComingUp(deviceId: string, eventKey: string, claimToken: string, nowMs: number): Promise<void>;
  /**
   * Release a claimed-but-unsent reservation immediately (a transient send
   * failure, a dead token, or a decision not to send after all) — only when
   * the caller's token still matches the stored one, same stale-claimant
   * guard as `completeComingUp`. Freeing the row right away (rather than
   * waiting out `ABANDONED_CLAIM_MS`) lets a genuinely failed attempt not
   * count against the cap for the full abandonment window.
   */
  releaseComingUp(deviceId: string, eventKey: string, claimToken: string): Promise<void>;
  /**
   * Prune two kinds of row (§10): SENT rows older than
   * `COMING_UP_RETENTION_MS` (30 days — the cap math needs the full
   * window), and UNSENT rows past `ABANDONED_CLAIM_MS` regardless of age
   * (a crashed reservation must not sit forever). Called on the same
   * cadence other pruning already runs on (`pruneSendClaims`).
   */
  pruneComingUp(nowMs: number): Promise<void>;
}

/**
 * Pick a backend: D1 when the `DB` binding is wired (production, and `next dev`
 * once `initOpenNextCloudflareForDev` has run), otherwise the memory/file store.
 * Tests always get memory — no bindings, no files, no network.
 */
export async function getStore(): Promise<DeviceStore> {
  if (!process.env.VITEST) {
    const db = await getD1();
    if (db) return d1Store(db);
  }
  return memoryStore();
}
