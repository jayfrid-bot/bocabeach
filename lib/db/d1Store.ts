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
  };
}
