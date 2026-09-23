// D1 backend for the Plus device store (binding `DB`, schema in migrations/).
//
// Bindings are reached the same way `lib/push/nativeStore.ts` reaches PUSH_KV:
// a STATIC top-level import of @opennextjs/cloudflare plus the async form of
// getCloudflareContext, which resolves outside a live request scope too. A
// dynamic import here would resolve a context whose bindings the OpenNext bundle
// never wired.
//
// Every statement is parameterized — no string interpolation into SQL.
//
// upsertDevice used to read the row, patch it in JavaScript, then write the
// whole thing back (#3). Two overlapping calls — a purchase landing while a
// preference save is in flight, say — raced on that read, and whichever wrote
// last won outright: a granted purchase could vanish, or a revoked one could
// come back. Every write below is now ONE SQL statement per method, with a
// "was this field actually provided" flag bound alongside each value, so a
// field the caller did not mention is guaranteed to survive no matter what
// else changes underneath it in between.

import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { NativeSub } from "@/lib/push/nativeStore";
import type {
  AlertMark,
  ArmedDevice,
  DeviceRecord,
  DeviceRow,
  PresenceInput,
  PresenceRow,
  PushableDevice,
  SentState,
} from "@/lib/db/types";
import { applyPatch, defaultPrefs, newDeviceRow, parseSent, toRecord } from "@/lib/db/types";
import { legacyDeviceId, legacyPatch } from "@/lib/db/legacy";
import type { DeviceStore } from "@/lib/db/store";
import { ABANDONED_CLAIM_MS, CLAIM_RETENTION_MS } from "@/lib/db/sendClaims";
import type { ArchiveCandidate, BeachHourlyRow } from "@/lib/history/types";
import { listLocations } from "@/config/locations";
import { compareByLastHourThenSlug, hourUtcOf, shouldArchiveNow } from "@/lib/history/archive";
import type {
  LiveActivityRow,
  RegisterLiveActivityInput,
  RegisterLiveActivityResult,
  UpsertLiveActivityInput,
} from "@/lib/db/store";

/** The slice of the D1 API we use (avoids a @cloudflare/workers-types dep).
 *  `run()`'s `meta.changes` mirrors real D1 — `claimTrial` reads it to tell
 *  "I won the race" from "someone already claimed this". */
export interface D1RunResult {
  success?: boolean;
  meta?: { changes?: number; last_row_id?: number };
}
export interface D1Stmt {
  bind(...values: unknown[]): D1Stmt;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<D1RunResult>;
  all<T = unknown>(): Promise<{ results?: T[] }>;
}
export interface D1Like {
  prepare(sql: string): D1Stmt;
  /** Real D1 bindings expose this: run several bound statements as one
   *  atomic transaction. Optional here because the SQLite-backed test
   *  harnesses (lib/db/d1Store.sql.test.ts) don't implement it — callers use
   *  `runBatch` below, which falls back to running the statements
   *  sequentially when it's missing (still correct, just not atomic against
   *  a concurrent writer, which those single-threaded test harnesses never
   *  have anyway). */
  batch?<T = unknown>(stmts: D1Stmt[]): Promise<D1RunResult[]>;
}

/** Run a list of already-bound statements as one D1 batch when the binding
 *  supports it, else sequentially (Codex review #4 — "db.batch or a single
 *  statement"). */
async function runBatch(db: D1Like, stmts: D1Stmt[]): Promise<D1RunResult[]> {
  if (typeof db.batch === "function") return db.batch(stmts);
  const out: D1RunResult[] = [];
  for (const s of stmts) out.push(await s.run());
  return out;
}

/** The `DB` binding, or null when we are not running on Cloudflare. */
export async function getD1(): Promise<D1Like | null> {
  try {
    const ctx = await getCloudflareContext({ async: true });
    const env = ctx?.env as Record<string, unknown> | undefined;
    const db = env?.DB as D1Like | undefined;
    return db && typeof db.prepare === "function" ? db : null;
  } catch {
    return null; // no bindings (plain `next dev`, tests) → memory/file store
  }
}

const DEVICE_COLS =
  "id, platform, push_token, tz, home_slug, profile_json, prefs_json, plan, " +
  "entitlement_until, store_until, code_until, trial_until, trial_used, preview_seen, " +
  "sent_json, created_at, updated_at";

/** `beach_hourly` columns, in the exact order both the INSERT and the
 *  positional binds below use — see migrations/0006_history.sql. */
const HOURLY_COLS = [
  "slug", "hour_utc", "snapshot_generated_at", "archived_at", "local_date", "local_hour",
  "utc_offset_minutes", "timezone", "score", "raw_score", "rating", "available_weight",
  "observed_weight", "coverage_tier", "air_temp_f", "water_temp_f", "sand_temp_f", "wave_ft",
  "wave_source", "wind_mph", "gust_mph", "uv", "cloud_pct", "rain_now", "lightning_near",
  "tide_state", "crowd_pct", "seaweed_pct", "seaweed_level", "clarity_pct", "engine_version",
  "scoring_config_version", "build_sha", "row_kind", "archive_reason", "caps_json",
  "factors_json", "missing_json", "extra_json",
] as const satisfies readonly (keyof BeachHourlyRow)[];

const UPSERT_BEACH_HOURLY = `
INSERT INTO beach_hourly (${HOURLY_COLS.join(", ")})
VALUES (${HOURLY_COLS.map((_, i) => `?${i + 1}`).join(", ")})
ON CONFLICT(slug, hour_utc) DO UPDATE SET
  ${HOURLY_COLS.filter((c) => c !== "slug" && c !== "hour_utc")
    .map((c) => `${c} = excluded.${c}`)
    .join(", ")}
WHERE excluded.snapshot_generated_at > beach_hourly.snapshot_generated_at
`;

/** A device with never-touched prefs stores no row at all for them — this is
 *  the merge base `json_patch` starts from, so a bare "all alerts on" device
 *  never needs a row here in the first place. Fixed content, safe to inline
 *  as a SQL literal (never contains a user-supplied value or a quote). */
const DEFAULT_PREFS_JSON = JSON.stringify(defaultPrefs());

// The three grant columns, resolved to "the caller's new value if they
// provided one, else whatever is already on the row" — duplicated wherever
// the derived plan/entitlement_until need to read it, because a single
// INSERT ... ON CONFLICT DO UPDATE SET has no way to name a subexpression.
const RESOLVED_STORE = "CASE WHEN ?22 THEN ?8 ELSE devices.store_until END";
const RESOLVED_CODE = "CASE WHEN ?23 THEN ?9 ELSE devices.code_until END";
const RESOLVED_TRIAL = "CASE WHEN ?24 THEN ?10 ELSE devices.trial_until END";
const MAX_UPDATE =
  `MAX(COALESCE(${RESOLVED_STORE},0), COALESCE(${RESOLVED_CODE},0), COALESCE(${RESOLVED_TRIAL},0))`;
const MAX_INSERT = "MAX(COALESCE(?8,0), COALESCE(?9,0), COALESCE(?10,0))";

/**
 * One atomic upsert. Every column is either a plain bound value (?1..?15,
 * ?16 = now) or, for a field the caller can leave untouched, guarded by a
 * "present" flag (?17..?27): `CASE WHEN <present> THEN <new value> ELSE
 * <current column> END`. `plan` and `entitlement_until` are never taken from
 * the caller — they are always MAX(store, code, trial), recomputed from
 * whichever of the three this write actually touches (#4). `prefs_json` is
 * always a `json_patch` merge, so a caller who didn't mention prefs merges
 * `{}` — a no-op — instead of needing its own present flag.
 */
const UPSERT_COLS =
  "id, platform, push_token, tz, home_slug, profile_json, prefs_json, " +
  "store_until, code_until, trial_until, plan, entitlement_until, trial_used, preview_seen, " +
  "sent_json, created_at, updated_at";

const UPSERT_DEVICE = `
INSERT INTO devices (${UPSERT_COLS})
VALUES (
  ?1, ?2, ?3, ?4, ?5, ?6,
  json_patch('${DEFAULT_PREFS_JSON}', ?7),
  ?8, ?9, ?10,
  CASE WHEN ${MAX_INSERT} > ?16 THEN 'plus' ELSE 'free' END,
  CASE WHEN ${MAX_INSERT} = 0 THEN NULL ELSE ${MAX_INSERT} END,
  ?11, ?12,
  ?13, ?14, ?15
)
ON CONFLICT(id) DO UPDATE SET
  platform = CASE WHEN ?17 THEN ?2 ELSE devices.platform END,
  push_token = CASE WHEN ?18 THEN ?3 ELSE devices.push_token END,
  tz = CASE WHEN ?19 THEN ?4 ELSE devices.tz END,
  home_slug = CASE WHEN ?20 THEN ?5 ELSE devices.home_slug END,
  profile_json = CASE WHEN ?21 THEN ?6 ELSE devices.profile_json END,
  prefs_json = json_patch(COALESCE(devices.prefs_json, '${DEFAULT_PREFS_JSON}'), ?7),
  store_until = ${RESOLVED_STORE},
  code_until = ${RESOLVED_CODE},
  trial_until = ${RESOLVED_TRIAL},
  plan = CASE WHEN ${MAX_UPDATE} > ?16 THEN 'plus' ELSE 'free' END,
  entitlement_until = CASE WHEN ${MAX_UPDATE} = 0 THEN NULL ELSE ${MAX_UPDATE} END,
  trial_used = CASE WHEN ?25 THEN ?11 ELSE devices.trial_used END,
  preview_seen = CASE WHEN ?26 THEN ?12 ELSE devices.preview_seen END,
  sent_json = CASE WHEN ?27 THEN ?13 ELSE devices.sent_json END,
  updated_at = ?15
`;

/** DevicePatch → the 27 positional binds `UPSERT_DEVICE` expects. */
function upsertBinds(id: string, patch: Record<string, unknown>, now: number): unknown[] {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(patch, k) && patch[k] !== undefined;
  const val = <T,>(k: string, transform: (v: unknown) => T = (v) => v as T): T | null =>
    has(k) ? transform(patch[k]) : null;

  const sentVal = has("sent")
    ? (() => {
        const sent = patch.sent as Record<string, unknown>;
        const keys = Object.keys(sent).filter((k) => sent[k] !== undefined);
        return keys.length ? JSON.stringify(sent) : null;
      })()
    : null;

  return [
    id, // 1
    val("platform"), // 2
    val("pushToken"), // 3
    val("tz"), // 4
    val("homeSlug"), // 5
    has("profile") ? (patch.profile === null ? null : JSON.stringify(patch.profile)) : null, // 6
    JSON.stringify(patch.prefs ?? {}), // 7 — always applied; absent → no-op merge
    val("storeUntil"), // 8
    val("codeUntil"), // 9
    val("trialUntil"), // 10
    val("trialUsed", (v) => (v ? 1 : 0)) ?? 0, // 11
    val("previewSeen", (v) => (v ? 1 : 0)) ?? 0, // 12
    sentVal, // 13
    now, // 14 created_at (insert only)
    now, // 15 updated_at
    now, // 16 "now", for the plan comparison
    has("platform") ? 1 : 0, // 17
    has("pushToken") ? 1 : 0, // 18
    has("tz") ? 1 : 0, // 19
    has("homeSlug") ? 1 : 0, // 20
    has("profile") ? 1 : 0, // 21
    has("storeUntil") ? 1 : 0, // 22
    has("codeUntil") ? 1 : 0, // 23
    has("trialUntil") ? 1 : 0, // 24
    has("trialUsed") ? 1 : 0, // 25
    has("previewSeen") ? 1 : 0, // 26
    has("sent") ? 1 : 0, // 27
  ];
}

/** `live_activities` columns, in the exact order the row mapper below reads
 *  them (migrations/0007_live_activities.sql). */
const LIVE_ACTIVITY_COLS =
  "activity_id, device_id, beach_slug, schema_version, app_build, apns_environment, " +
  "push_token, token_updated_at, started_at, expires_at, ended_at, status, " +
  "last_state_json, last_state_hash, pending_state_json, pending_since, " +
  "next_send_at, last_sent_at, last_apns_timestamp, last_apns_status, " +
  "token_rotation, last_seq";

function toLiveActivityRow(r: Record<string, unknown>): LiveActivityRow {
  return {
    activityId: String(r.activity_id),
    deviceId: String(r.device_id),
    beachSlug: String(r.beach_slug),
    schemaVersion: Number(r.schema_version),
    appBuild: (r.app_build as string | null) ?? null,
    apnsEnvironment: (r.apns_environment as string | null) ?? null,
    pushToken: String(r.push_token),
    tokenUpdatedAt: Number(r.token_updated_at),
    startedAt: Number(r.started_at),
    expiresAt: Number(r.expires_at),
    endedAt: (r.ended_at as number | null) ?? null,
    status: r.status === "ended" ? "ended" : "active",
    lastStateJson: (r.last_state_json as string | null) ?? null,
    lastStateHash: (r.last_state_hash as string | null) ?? null,
    pendingStateJson: (r.pending_state_json as string | null) ?? null,
    pendingSince: (r.pending_since as number | null) ?? null,
    nextSendAt: (r.next_send_at as number | null) ?? null,
    lastSentAt: (r.last_sent_at as number | null) ?? null,
    lastApnsTimestamp: (r.last_apns_timestamp as number | null) ?? null,
    lastApnsStatus: (r.last_apns_status as number | null) ?? null,
    tokenRotation: Number(r.token_rotation ?? 0),
    lastSeq: Number(r.last_seq ?? 0),
  };
}

// Insert a fresh activity, or — on a repeat call for the same activity_id
// (a token rotation, or a re-register after a transient failure) — replace
// its token/expiry/metadata and revive it to 'active' in one statement.
// `started_at` (?9) is deliberately left out of the UPDATE SET list: it
// stays whatever the first INSERT wrote, so a later rotation can never push
// the 8-hour ActivityKit ceiling out from under the real start time.
const UPSERT_LIVE_ACTIVITY = `
INSERT INTO live_activities (
  activity_id, device_id, beach_slug, schema_version, app_build, apns_environment,
  push_token, token_updated_at, started_at, expires_at, ended_at, status
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, 'active')
ON CONFLICT(activity_id) DO UPDATE SET
  device_id = ?2,
  beach_slug = ?3,
  schema_version = ?4,
  app_build = ?5,
  apns_environment = ?6,
  push_token = ?7,
  token_updated_at = ?8,
  expires_at = ?10,
  ended_at = NULL,
  status = 'active'
`;

// The register ROUTE's real entry point (Codex review #4, hardened round-2
// #3) — same shape as UPSERT_LIVE_ACTIVITY, plus a rotation guard: ?11 is the
// caller's rotation counter, or NULL for a caller that never sent one
// (accepted unconditionally, `token_rotation` left untouched). The WHERE
// clause also re-checks ownership (`device_id = ?2`) AND that the row is
// still 'active' (Codex round-3 #3 — HIGH) as a second line of defense
// alongside the pre-batch SELECT below: without the status check, a delayed
// register for an activity that has since ended (or been superseded) could
// silently reactivate it, undoing an explicit end/supersede.
//
// CODEX ROUND-3 #1 correction: this statement runs SECOND in the batch, not
// first, despite an earlier version of this comment claiming otherwise —
// see `registerLiveActivity` below, which binds `[supersede, register]` in
// that literal order, and SUPERSEDE_OTHER_ACTIVE_IF_LANDED's own doc for why
// that physical order is required (a brand-new activity's INSERT would trip
// `idx_live_activities_active_device`'s unique index if an old row for this
// device were still 'active' when it runs). Running register "logically
// first" is achieved instead by SUPERSEDE's own guard replicating this
// statement's success condition (see its doc) so it only ever fires when
// this UPDATE/INSERT is guaranteed to land — and, as of round-3 #2, by
// `registerLiveActivity` re-reading and verifying the row after the batch
// rather than trusting the pre-batch read or this statement's own change
// count.
export const REGISTER_LIVE_ACTIVITY = `
INSERT INTO live_activities (
  activity_id, device_id, beach_slug, schema_version, app_build, apns_environment,
  push_token, token_updated_at, started_at, expires_at, ended_at, status, token_rotation
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, 'active', COALESCE(?11, 0))
ON CONFLICT(activity_id) DO UPDATE SET
  device_id = ?2,
  beach_slug = ?3,
  schema_version = ?4,
  app_build = ?5,
  apns_environment = ?6,
  push_token = ?7,
  token_updated_at = ?8,
  expires_at = ?10,
  ended_at = NULL,
  status = 'active',
  token_rotation = CASE WHEN ?11 IS NULL THEN live_activities.token_rotation ELSE ?11 END
WHERE live_activities.device_id = ?2
  AND live_activities.status = 'active'
  AND (?11 IS NULL OR ?11 > live_activities.token_rotation)
`;

/** Ends every OTHER active row for this device — the "supersede" half of
 *  `registerLiveActivity`'s one-active-per-device guarantee (Codex review
 *  #4, hardened round-2 #3). Also blanks its token (Codex review #10 — see
 *  `markLiveActivityEnded`'s doc): a superseded row's token is as done as an
 *  explicitly-ended one's.
 *
 *  Runs FIRST (register must run second, since inserting a brand-new active
 *  row for this device while an old one is STILL active would trip
 *  `idx_live_activities_active_device`'s unique constraint — SQLite checks it
 *  immediately, not deferred). To close the round-2 #3 bug (a stale retry
 *  superseding a newer, still-current activity) without reordering, THIS
 *  statement is itself guarded to only fire when the paired
 *  REGISTER_LIVE_ACTIVITY that follows is guaranteed to succeed: either no
 *  row for ?3/this activity exists yet (a brand-new activity always wins its
 *  INSERT, nothing to gate), or one does and it belongs to this device with
 *  a rotation the incoming one will actually exceed (?4 IS NULL — no
 *  rotation sent, register's own guard always accepts that — or ?4 strictly
 *  greater than what's on file). A stale/rejected retry (device mismatch, or
 *  a rotation that doesn't exceed what's on file) makes both EXISTS branches
 *  false, so this UPDATE is a no-op and no other row is touched. */
export const SUPERSEDE_OTHER_ACTIVE_IF_LANDED = `
UPDATE live_activities SET status = 'ended', ended_at = ?1, push_token = ''
WHERE device_id = ?2 AND status = 'active' AND activity_id != ?3
  AND (
    NOT EXISTS (SELECT 1 FROM live_activities WHERE activity_id = ?3)
    OR EXISTS (
      SELECT 1 FROM live_activities
      WHERE activity_id = ?3 AND device_id = ?2 AND status = 'active'
        AND (?4 IS NULL OR ?4 > token_rotation)
    )
  )
`;

export function d1Store(db: D1Like): DeviceStore {
  const getRow = (id: string) =>
    db.prepare(`SELECT ${DEVICE_COLS} FROM devices WHERE id = ?`).bind(id).first<DeviceRow>();

  const getPresenceRow = (id: string) =>
    db.prepare("SELECT * FROM presence WHERE device_id = ?").bind(id).first<PresenceRow>();

  async function toApi(row: DeviceRow): Promise<DeviceRecord> {
    return toRecord(row, await getPresenceRow(row.id));
  }

  return {
    async getDevice(id) {
      const row = await getRow(id);
      return row ? toApi(row) : null;
    },

    async upsertDevice(id, patch) {
      const now = Date.now();
      await db
        .prepare(UPSERT_DEVICE)
        .bind(...upsertBinds(id, patch as Record<string, unknown>, now))
        .run();
      const row = await getRow(id);
      // The row we just wrote must exist — but fall back to the JS patcher
      // over a blank row rather than throw, so a transient read-after-write
      // hiccup degrades to "act like the write hadn't landed yet" instead of
      // crashing the request.
      return row ? toApi(row) : toApi(applyPatch(newDeviceRow(id, now), patch, now));
    },

    async claimTrial(id, until) {
      const now = Date.now();
      // Make sure a row exists (no-op if it already does) — a device can
      // start its trial before it has ever called POST /api/devices.
      await db
        .prepare(
          "INSERT INTO devices (id, plan, entitlement_until, trial_used, preview_seen, prefs_json, created_at, updated_at) " +
            "VALUES (?, 'free', NULL, 0, 0, NULL, ?, ?) ON CONFLICT(id) DO NOTHING",
        )
        .bind(id, now, now)
        .run();
      // The WHERE clause is the whole trick: two concurrent claims both reach
      // this UPDATE, but SQLite serializes writes, so only the first one's
      // WHERE still matches by the time it runs — the second sees
      // trial_used already 1 and changes nothing.
      const result = await db
        .prepare(
          "UPDATE devices SET trial_until = ?1, trial_used = 1, " +
            "entitlement_until = CASE WHEN MAX(COALESCE(store_until,0), COALESCE(code_until,0), COALESCE(?1,0)) = 0 " +
            "THEN NULL ELSE MAX(COALESCE(store_until,0), COALESCE(code_until,0), COALESCE(?1,0)) END, " +
            "plan = CASE WHEN MAX(COALESCE(store_until,0), COALESCE(code_until,0), COALESCE(?1,0)) > ?2 THEN 'plus' ELSE 'free' END, " +
            "updated_at = ?2 WHERE id = ?3 AND trial_used = 0",
        )
        .bind(until, now, id)
        .run();
      if (!result.meta?.changes) return "trial-used";
      const row = await getRow(id);
      return row ? toApi(row) : "trial-used";
    },

    async clearPushToken(id, expectedToken) {
      // Conditional on the CURRENT value, not just the id: if the phone
      // already re-registered a new token by the time this runs, that new
      // token is what is live and must not be erased (#5).
      await db
        .prepare("UPDATE devices SET push_token = NULL, updated_at = ? WHERE id = ? AND push_token = ?")
        .bind(Date.now(), id, expectedToken)
        .run();
    },

    // --- Install token identity (migrations/0008_device_tokens.sql) --------
    async getInstallTokenHash(id) {
      const row = await db
        .prepare("SELECT token_hash FROM devices WHERE id = ?")
        .bind(id)
        .first<{ token_hash: string | null }>();
      return row?.token_hash ?? null;
    },

    async setInstallTokenHash(id, tokenHash, issuedAt) {
      const result = await db
        .prepare(
          "UPDATE devices SET token_hash = ?, token_issued_at = ?, updated_at = ? " +
            "WHERE id = ? AND token_hash IS NULL",
        )
        .bind(tokenHash, issuedAt, issuedAt, id)
        .run();
      return ((result as D1RunResult | undefined)?.meta?.changes ?? 0) > 0;
    },

    async getInstallTokenUsedAt(id) {
      const row = await db
        .prepare("SELECT token_used_at FROM devices WHERE id = ?")
        .bind(id)
        .first<{ token_used_at: number | null }>();
      return row?.token_used_at ?? null;
    },

    async markInstallTokenUsed(id, usedAt) {
      // Cheap on every call after the first for a given token: the WHERE
      // guard makes every call after the winning one a real no-op UPDATE
      // (SQLite/D1 still has to find the row, but writes nothing).
      await db
        .prepare("UPDATE devices SET token_used_at = ? WHERE id = ? AND token_used_at IS NULL")
        .bind(usedAt, id)
        .run();
    },

    async findByPushToken(token) {
      const row = await db
        .prepare(`SELECT ${DEVICE_COLS} FROM devices WHERE push_token = ? LIMIT 1`)
        .bind(token)
        .first<DeviceRow>();
      return row ? toApi(row) : null;
    },

    async deleteDevice(id) {
      await db.prepare("DELETE FROM presence WHERE device_id = ?").bind(id).run();
      await db.prepare("DELETE FROM alert_log WHERE device_id = ?").bind(id).run();
      await db.prepare("DELETE FROM devices WHERE id = ?").bind(id).run();
    },

    async listDevices() {
      const rows = (await db.prepare(`SELECT ${DEVICE_COLS} FROM devices`).all<DeviceRow>()).results ?? [];
      const armed = new Map<string, PresenceRow>();
      for (const p of (await db.prepare("SELECT * FROM presence").all<PresenceRow>()).results ?? []) {
        armed.set(p.device_id, p);
      }
      return rows.map((r) => toRecord(r, armed.get(r.id) ?? null));
    },

    async listArmed(nowMs) {
      const rows =
        (
          await db
            .prepare(
              `SELECT d.id AS d_id, d.platform, d.push_token, d.tz, d.home_slug, d.profile_json, ` +
                "d.prefs_json, d.plan, d.entitlement_until, d.store_until, d.code_until, d.trial_until, " +
                "d.trial_used, d.preview_seen, d.sent_json, d.created_at, d.updated_at, " +
                "p.device_id, p.slug, p.lat, p.lon, p.accuracy_m, " +
                "p.fix_at, p.armed_until, p.source, p.updated_at AS p_updated_at " +
                "FROM presence p JOIN devices d ON d.id = p.device_id " +
                "WHERE p.armed_until > ? AND d.plan = 'plus' AND d.entitlement_until > ?",
            )
            .bind(nowMs, nowMs)
            .all<Record<string, unknown>>()
        ).results ?? [];
      return rows.map((r): ArmedDevice => {
        const device: DeviceRow = {
          id: String(r.d_id),
          platform: (r.platform as string | null) ?? null,
          push_token: (r.push_token as string | null) ?? null,
          tz: (r.tz as string | null) ?? null,
          home_slug: (r.home_slug as string | null) ?? null,
          profile_json: (r.profile_json as string | null) ?? null,
          prefs_json: (r.prefs_json as string | null) ?? null,
          plan: String(r.plan),
          entitlement_until: (r.entitlement_until as number | null) ?? null,
          store_until: (r.store_until as number | null) ?? null,
          code_until: (r.code_until as number | null) ?? null,
          trial_until: (r.trial_until as number | null) ?? null,
          trial_used: Number(r.trial_used ?? 0),
          preview_seen: Number(r.preview_seen ?? 0),
          sent_json: (r.sent_json as string | null) ?? null,
          created_at: Number(r.created_at ?? 0),
          updated_at: Number(r.updated_at ?? 0),
        };
        const presence: PresenceRow = {
          device_id: String(r.device_id),
          slug: String(r.slug),
          lat: (r.lat as number | null) ?? null,
          lon: (r.lon as number | null) ?? null,
          accuracy_m: (r.accuracy_m as number | null) ?? null,
          fix_at: (r.fix_at as number | null) ?? null,
          armed_until: Number(r.armed_until),
          source: String(r.source),
          updated_at: Number(r.p_updated_at ?? 0),
        };
        return {
          device: toRecord(device, presence),
          presence: {
            slug: presence.slug,
            lat: presence.lat,
            lon: presence.lon,
            accuracyM: presence.accuracy_m,
            fixAt: presence.fix_at,
            armedUntil: presence.armed_until,
            source: presence.source === "auto" ? "auto" : "manual",
          },
        };
      });
    },

    async setPresence(deviceId, p: PresenceInput) {
      await db
        .prepare(
          "INSERT INTO presence (device_id, slug, lat, lon, accuracy_m, fix_at, armed_until, source, updated_at) " +
            "VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET slug=excluded.slug, " +
            "lat=excluded.lat, lon=excluded.lon, accuracy_m=excluded.accuracy_m, fix_at=excluded.fix_at, " +
            "armed_until=excluded.armed_until, source=excluded.source, updated_at=excluded.updated_at",
        )
        .bind(
          deviceId,
          p.slug,
          p.lat ?? null,
          p.lon ?? null,
          p.accuracyM ?? null,
          p.fixAt ?? null,
          p.armedUntil,
          p.source,
          Date.now(),
        )
        .run();
    },

    async clearPresence(deviceId) {
      await db.prepare("DELETE FROM presence WHERE device_id = ?").bind(deviceId).run();
    },

    async getSent(deviceId) {
      const row = await db
        .prepare("SELECT sent_json FROM devices WHERE id = ?")
        .bind(deviceId)
        .first<{ sent_json: string | null }>();
      return parseSent(row?.sent_json);
    },

    async setSent(deviceId, sent: SentState) {
      const keys = Object.keys(sent).filter((k) => (sent as Record<string, unknown>)[k] !== undefined);
      await db
        .prepare("UPDATE devices SET sent_json = ?, updated_at = ? WHERE id = ?")
        .bind(keys.length ? JSON.stringify(sent) : null, Date.now(), deviceId)
        .run();
    },

    async lastAlert(deviceId, key): Promise<AlertMark | null> {
      const row = await db
        .prepare("SELECT sent_at, meta_json FROM alert_log WHERE device_id = ? AND alert_key = ?")
        .bind(deviceId, key)
        .first<{ sent_at: number; meta_json: string | null }>();
      if (!row) return null;
      let meta: unknown = null;
      try {
        meta = row.meta_json ? JSON.parse(row.meta_json) : null;
      } catch {
        meta = null;
      }
      return { sentAt: Number(row.sent_at), meta };
    },

    async markAlert(deviceId, key, at, meta) {
      await db
        .prepare(
          "INSERT INTO alert_log (device_id, alert_key, sent_at, meta_json) VALUES (?,?,?,?) " +
            "ON CONFLICT(device_id, alert_key) DO UPDATE SET sent_at=excluded.sent_at, meta_json=excluded.meta_json",
        )
        .bind(deviceId, key, at, meta === undefined ? null : JSON.stringify(meta))
        .run();
    },

    async importLegacy(subs: NativeSub[]) {
      let imported = 0;
      let skipped = 0;
      if (!subs.length) return { imported, skipped };
      const known = new Set<string>();
      for (const r of (
        await db
          .prepare("SELECT push_token FROM devices WHERE push_token IS NOT NULL")
          .all<{ push_token: string }>()
      ).results ?? []) {
        known.add(r.push_token);
      }
      const now = Date.now();
      for (const sub of subs) {
        if (!sub?.token || known.has(sub.token)) {
          skipped += 1;
          continue;
        }
        const id = legacyDeviceId(sub.token);
        await db
          .prepare(UPSERT_DEVICE)
          .bind(...upsertBinds(id, legacyPatch(sub) as Record<string, unknown>, now))
          .run();
        known.add(sub.token);
        imported += 1;
      }
      return { imported, skipped };
    },

    async getPushToken(id) {
      const row = await db
        .prepare("SELECT push_token FROM devices WHERE id = ?")
        .bind(id)
        .first<{ push_token: string | null }>();
      return row?.push_token ?? null;
    },

    async listPushable(): Promise<PushableDevice[]> {
      const rows =
        (
          await db
            .prepare(
              `SELECT ${DEVICE_COLS} FROM devices WHERE push_token IS NOT NULL AND platform IN ('ios','android')`,
            )
            .all<DeviceRow>()
        ).results ?? [];
      const armed = new Map<string, PresenceRow>();
      for (const p of (await db.prepare("SELECT * FROM presence").all<PresenceRow>()).results ?? []) {
        armed.set(p.device_id, p);
      }
      return rows.map((row) => ({
        device: toRecord(row, armed.get(row.id) ?? null),
        token: row.push_token as string,
        platform: row.platform as "ios" | "android",
        sent: parseSent(row.sent_json),
      }));
    },

    // --- Atomic send claims (#14, migrations/0004_send_claims.sql) ---------
    //
    // One statement, no read-then-write race: INSERT the claim, or — only
    // when the existing claim is unsent AND old enough to call abandoned —
    // UPDATE it to hand it to this caller. D1 serializes writes to a single
    // key, so of any two callers racing for the same key, at most one
    // statement actually changes a row; the other's WHERE clause fails and it
    // changes nothing. That is also why this does NOT compare the read-back
    // row to `now`: two real callers can share the same millisecond, and a
    // value-equality check would then (wrongly) tell both of them they won.
    async claimSend(key, now) {
      const result = await db
        .prepare(
          "INSERT INTO send_claims (key, claimed_at, sent_at) VALUES (?, ?, NULL) " +
            "ON CONFLICT(key) DO UPDATE SET claimed_at = excluded.claimed_at " +
            "WHERE send_claims.sent_at IS NULL AND send_claims.claimed_at <= ?",
        )
        .bind(key, now, now - ABANDONED_CLAIM_MS)
        .run();
      // D1's real `.run()` result carries `meta.changes` (its documented
      // shape); the local D1Stmt type leaves `run()` untyped to avoid a
      // @cloudflare/workers-types dependency, so this is the one place that
      // reads it. changes > 0 means THIS statement is the one that inserted
      // or updated the row — i.e. this caller won the claim.
      const changes = (result as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0;
      return changes > 0;
    },

    async markSent(key, now) {
      await db.prepare("UPDATE send_claims SET sent_at = ? WHERE key = ?").bind(now, key).run();
    },

    async pruneSendClaims(now) {
      await db
        .prepare("DELETE FROM send_claims WHERE claimed_at < ?")
        .bind(now - CLAIM_RETENTION_MS)
        .run();
    },

    async purgeExpiredPresenceFixes(now) {
      const r = await db
        .prepare(
          "UPDATE presence SET lat = NULL, lon = NULL, accuracy_m = NULL, fix_at = NULL, updated_at = ? " +
            "WHERE armed_until < ? AND (lat IS NOT NULL OR lon IS NOT NULL OR accuracy_m IS NOT NULL OR fix_at IS NOT NULL)",
        )
        .bind(now, now)
        .run();
      return Number(r.meta?.changes ?? 0);
    },

    // --- Hourly history archive (Part A) ------------------------------------
    async upsertBeachHourly(row: BeachHourlyRow) {
      const result = await db
        .prepare(UPSERT_BEACH_HOURLY)
        .bind(...HOURLY_COLS.map((c) => row[c] ?? null))
        .run();
      const changes = (result as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0;
      return { written: changes > 0 };
    },

    // Codex round-3 finding #1: candidates used to come back in fixed config
    // order, reset every UTC hour, so with only ~30 builds/hour possible the
    // beaches at the end of that order systematically never got archived.
    // Fair ordering instead: never-archived-at-all beaches first, then the
    // beach whose most recent beach_hourly row is OLDEST, ties broken by
    // slug — so every beach gets a turn instead of the same prefix winning
    // every hour. `last_hour` is each slug's MAX(hour_utc) across ALL of
    // beach_hourly (not just the current hour), via a single GROUP BY —
    // equivalent to a correlated-subquery LEFT JOIN per candidate, cheaper
    // to express as one aggregate query plus an in-memory merge since the
    // candidate set itself (config `listLocations()`) isn't a DB table.
    async listArchiveCandidates(nowMs: number) {
      const hourUtc = hourUtcOf(nowMs);
      const currentHourRows =
        (
          await db
            .prepare("SELECT slug FROM beach_hourly WHERE hour_utc = ?")
            .bind(hourUtc)
            .all<{ slug: string }>()
        ).results ?? [];
      const archivedThisHour = new Set(currentHourRows.map((r) => r.slug));

      const lastHourRows =
        (
          await db
            .prepare("SELECT slug, MAX(hour_utc) AS last_hour FROM beach_hourly GROUP BY slug")
            .all<{ slug: string; last_hour: string }>()
        ).results ?? [];
      const lastHourBySlug = new Map(lastHourRows.map((r) => [r.slug, r.last_hour]));

      return listLocations()
        .map((l): ArchiveCandidate => ({
          slug: l.slug,
          lat: l.lat,
          lon: l.lon,
          timezone: l.timezone,
          tier: l.tier ?? "curated",
        }))
        .filter((c) => !archivedThisHour.has(c.slug) && shouldArchiveNow(c, nowMs))
        .sort((a, b) => compareByLastHourThenSlug(lastHourBySlug.get(a.slug), a.slug, lastHourBySlug.get(b.slug), b.slug));
    },

    async getHistoryBudget(day: string) {
      const row = await db
        .prepare("SELECT builds FROM history_budget WHERE day = ?")
        .bind(day)
        .first<{ builds: number }>();
      return row?.builds ?? 0;
    },

    // Single statement: insert the day's first build unconditionally, or
    // increment an existing row ONLY while under `max`. SQLite runs the
    // whole INSERT-or-DO-UPDATE as one atomic step, so of any two overlapping
    // callers racing for the same day, at most `max` reservations total ever
    // succeed — there is no read-then-write gap for a second caller to land
    // in between (the bug this replaces: read remaining budget, fetch, THEN
    // bump, which let two overlapping calls both read the same headroom).
    async reserveHistoryBuild(day: string, max: number) {
      // max <= 0 must refuse outright — the INSERT branch below would
      // otherwise set builds = 1 unconditionally on the day's first call,
      // regardless of `max` (Codex round-2 finding #2).
      if (max <= 0) return false;
      const result = await db
        .prepare(
          "INSERT INTO history_budget (day, builds) VALUES (?, 1) " +
            "ON CONFLICT(day) DO UPDATE SET builds = builds + 1 WHERE history_budget.builds < ?",
        )
        .bind(day, max)
        .run();
      const changes = (result as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0;
      return changes > 0;
    },

    // Same abandonment-window shape as claimSend: INSERT the claim, or —
    // only when the existing claim was never completed AND is old enough to
    // call abandoned — UPDATE it to hand it to this caller (Codex round-2
    // finding #4). See lib/db/store.ts claimHistoryBuild doc for the retry
    // story this closes.
    async claimHistoryBuild(slug: string, hourUtc: string, now: number) {
      const key = `history:${slug}:${hourUtc}`;
      const result = await db
        .prepare(
          "INSERT INTO history_claims (key, claimed_at, completed_at) VALUES (?, ?, NULL) " +
            "ON CONFLICT(key) DO UPDATE SET claimed_at = excluded.claimed_at " +
            "WHERE history_claims.completed_at IS NULL AND history_claims.claimed_at <= ?",
        )
        .bind(key, now, now - ABANDONED_CLAIM_MS)
        .run();
      const changes = (result as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0;
      return changes > 0;
    },

    async completeHistoryClaim(slug: string, hourUtc: string, now: number) {
      await db
        .prepare("UPDATE history_claims SET completed_at = ? WHERE key = ?")
        .bind(now, `history:${slug}:${hourUtc}`)
        .run();
    },

    async releaseHistoryClaim(slug: string, hourUtc: string) {
      await db.prepare("DELETE FROM history_claims WHERE key = ?").bind(`history:${slug}:${hourUtc}`).run();
    },

    // --- Beach Session Live Activity (migrations/0007_live_activities.sql) -
    async upsertLiveActivity(input: UpsertLiveActivityInput) {
      const now = Date.now();
      await db
        .prepare(UPSERT_LIVE_ACTIVITY)
        .bind(
          input.activityId,
          input.deviceId,
          input.beachSlug,
          input.schemaVersion,
          input.appBuild,
          input.apnsEnvironment,
          input.pushToken,
          now,
          input.startedAt,
          input.expiresAt,
        )
        .run();
      const row = await db
        .prepare(`SELECT ${LIVE_ACTIVITY_COLS} FROM live_activities WHERE activity_id = ?`)
        .bind(input.activityId)
        .first<Record<string, unknown>>();
      // The row we just wrote must exist — but degrade to an in-memory
      // reconstruction over throwing, mirroring upsertDevice's own guard
      // against a transient read-after-write hiccup.
      return row
        ? toLiveActivityRow(row)
        : {
            activityId: input.activityId,
            deviceId: input.deviceId,
            beachSlug: input.beachSlug,
            schemaVersion: input.schemaVersion,
            appBuild: input.appBuild,
            apnsEnvironment: input.apnsEnvironment,
            pushToken: input.pushToken,
            tokenUpdatedAt: now,
            startedAt: input.startedAt,
            expiresAt: input.expiresAt,
            endedAt: null,
            status: "active" as const,
            lastStateJson: null,
            lastStateHash: null,
            pendingStateJson: null,
            pendingSince: null,
            nextSendAt: null,
            lastSentAt: null,
            lastApnsTimestamp: null,
            lastApnsStatus: null,
            tokenRotation: 0,
            lastSeq: 0,
          };
    },

    async registerLiveActivity(input: RegisterLiveActivityInput): Promise<RegisterLiveActivityResult> {
      const now = Date.now();
      // Cheap pre-check, NOT relied on for correctness (see the re-read
      // below, Codex round-3 #2) — just lets an obvious device mismatch or
      // an already-ended activity fail fast without running the batch.
      const existing = await db
        .prepare("SELECT device_id, status FROM live_activities WHERE activity_id = ?")
        .bind(input.activityId)
        .first<{ device_id: string; status: string }>();
      if (existing && existing.device_id !== input.deviceId) return "device-mismatch";
      if (existing && existing.status !== "active") return "ended";

      // SUPERSEDE runs FIRST, REGISTER second — see REGISTER_LIVE_ACTIVITY's
      // doc for why that physical order can't be swapped (the unique index
      // on one-active-row-per-device). SUPERSEDE_OTHER_ACTIVE_IF_LANDED's
      // own guard (see its doc) only fires when the paired REGISTER that
      // follows is guaranteed to succeed, so a stale/rejected register can
      // never end a different, still-current activity. ?4 in that guard and
      // ?11 in REGISTER_LIVE_ACTIVITY are the same `input.rotation`.
      const rotation = input.rotation ?? null;
      const supersede = db
        .prepare(SUPERSEDE_OTHER_ACTIVE_IF_LANDED)
        .bind(now, input.deviceId, input.activityId, rotation);
      const register = db
        .prepare(REGISTER_LIVE_ACTIVITY)
        .bind(
          input.activityId,
          input.deviceId,
          input.beachSlug,
          input.schemaVersion,
          input.appBuild,
          input.apnsEnvironment,
          input.pushToken,
          now,
          input.startedAt,
          input.expiresAt,
          rotation,
        );
      await runBatch(db, [supersede, register]);

      // Codex round-3 #2 (first-seen race): ALWAYS re-read the row after the
      // batch and decide the outcome from what actually landed — never trust
      // the pre-batch `existing` read or the register statement's own change
      // count. Two concurrent first-time registers for the SAME brand-new
      // activityId can both see `existing === null` before either writes;
      // only one INSERT actually wins the row (the other's ON CONFLICT
      // UPDATE branch loses on the `device_id = ?2` guard), so the loser
      // must discover that from the row's real, current owner/rotation/
      // status, not from its own now-stale pre-read.
      const row = await db
        .prepare(`SELECT ${LIVE_ACTIVITY_COLS} FROM live_activities WHERE activity_id = ?`)
        .bind(input.activityId)
        .first<Record<string, unknown>>();
      if (!row) return "device-mismatch"; // defensive: nothing landed at all
      const liveRow = toLiveActivityRow(row);
      if (liveRow.deviceId !== input.deviceId) return "not-owner";
      if (liveRow.status !== "active") return "ended";
      if (rotation != null && liveRow.tokenRotation !== rotation) return "stale-rotation";
      return liveRow;
    },

    async setLiveActivityExpiry(activityId: string, expiresAt: number) {
      await db
        .prepare("UPDATE live_activities SET expires_at = ? WHERE activity_id = ?")
        .bind(expiresAt, activityId)
        .run();
    },

    async touchLiveActivityCursor(activityId: string, nextSendAt: number) {
      await db
        .prepare("UPDATE live_activities SET next_send_at = ? WHERE activity_id = ?")
        .bind(nextSendAt, activityId)
        .run();
    },

    async listActiveLiveActivities(now: number) {
      // `now` is accepted for interface parity (the caller decides what's
      // due to end against expiresAt) — this query itself is unfiltered by
      // time, same as memoryStore's implementation.
      void now;
      const rows =
        (
          await db
            .prepare(`SELECT ${LIVE_ACTIVITY_COLS} FROM live_activities WHERE status = 'active'`)
            .all<Record<string, unknown>>()
        ).results ?? [];
      return rows.map(toLiveActivityRow);
    },

    async listLiveActivitiesForDevice(deviceId: string) {
      const rows =
        (
          await db
            .prepare(`SELECT ${LIVE_ACTIVITY_COLS} FROM live_activities WHERE device_id = ?`)
            .bind(deviceId)
            .all<Record<string, unknown>>()
        ).results ?? [];
      return rows.map(toLiveActivityRow);
    },

    async markLiveActivityEnded(activityId: string, _reason: string, now: number, opts) {
      void _reason; // diagnostics only — not a stored column (see store.ts doc)
      await db
        .prepare(
          "UPDATE live_activities SET status = 'ended', ended_at = ?, " +
            "push_token = CASE WHEN ? THEN '' ELSE push_token END " +
            "WHERE activity_id = ? AND status != 'ended'",
        )
        .bind(now, opts?.clearToken ? 1 : 0, activityId)
        .run();
    },

    async allocateLiveActivitySeq(activityId, now) {
      // D1 supports RETURNING (round-2 #5) — the increment and the read of
      // its new value are the same statement, so no other writer can land a
      // seq in between "compute" and "persist". The timestamp is folded into
      // this SAME statement (Codex round-3 fix) so it is allocated
      // atomically with the seq, not computed separately in JS with a
      // network call in between — see store.ts's doc for why that ordering
      // matters to ActivityKit. The floor is +1000ms, not +1ms (Codex
      // round-4 #5): lib/push/apns.ts's wire payload sends
      // `Math.floor(timestampMs / 1000)` — whole epoch SECONDS, the unit
      // ActivityKit actually orders by — so two allocations only 1ms apart
      // used to collapse to the identical transmitted timestamp. A full
      // second's worth of floor guarantees each allocation lands in a
      // strictly later second than the last, even back-to-back.
      const row = await db
        .prepare(
          "UPDATE live_activities SET last_seq = last_seq + 1, " +
            "last_sent_at = MAX(COALESCE(last_sent_at, 0) + 1000, ?) " +
            "WHERE activity_id = ? AND status = 'active' RETURNING last_seq, last_sent_at",
        )
        .bind(now, activityId)
        .first<{ last_seq: number; last_sent_at: number }>();
      return row ? { seq: Number(row.last_seq), timestampMs: Number(row.last_sent_at) } : null;
    },

    async recordLiveActivitySend(activityId, send) {
      // Compare-and-swap on last_seq (round-2 #5): this bookkeeping write
      // only lands if last_seq still equals the seq this call actually sent
      // — i.e. no OTHER call has allocated (and therefore sent) a newer seq
      // for this row since. A stale write here (an overlapping run's older
      // send finally resolving after a newer one already recorded) must
      // never overwrite fresher status/hash/state with older ones.
      await db
        .prepare(
          "UPDATE live_activities SET last_sent_at = ?, last_apns_timestamp = ?, last_apns_status = ?, " +
            "last_state_hash = ?, last_state_json = COALESCE(?, last_state_json), " +
            "next_send_at = ? WHERE activity_id = ? AND last_seq = ?",
        )
        .bind(
          send.timestamp,
          send.timestamp,
          send.status,
          send.hash,
          send.stateJson ?? null,
          send.timestamp,
          activityId,
          send.seq,
        )
        .run();
    },

    async purgeLiveActivities(cutoffMs: number) {
      const r = await db
        .prepare("DELETE FROM live_activities WHERE status = 'ended' AND ended_at IS NOT NULL AND ended_at < ?")
        .bind(cutoffMs)
        .run();
      return Number(r.meta?.changes ?? 0);
    },
  };
}
