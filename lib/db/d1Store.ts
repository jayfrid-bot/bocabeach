// D1 backend for the Plus device store (binding `DB`, schema in migrations/).
//
// Bindings are reached the same way `lib/push/nativeStore.ts` reaches PUSH_KV:
// a STATIC top-level import of @opennextjs/cloudflare plus the async form of
// getCloudflareContext, which resolves outside a live request scope too. A
// dynamic import here would resolve a context whose bindings the OpenNext bundle
// never wired.
//
// Every statement is parameterized — no string interpolation into SQL.

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
import { applyPatch, newDeviceRow, parseSent, toRecord } from "@/lib/db/types";
import { legacyDeviceId, legacyPatch } from "@/lib/db/legacy";
import type { DeviceStore } from "@/lib/db/store";

/** The slice of the D1 API we use (avoids a @cloudflare/workers-types dep). */
export interface D1Stmt {
  bind(...values: unknown[]): D1Stmt;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<unknown>;
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
  "entitlement_until, trial_used, preview_seen, sent_json, created_at, updated_at";

/** Full-row upsert — the patch is applied in JS so both backends behave alike. */
const UPSERT_DEVICE =
  `INSERT INTO devices (${DEVICE_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ` +
  "ON CONFLICT(id) DO UPDATE SET platform=excluded.platform, push_token=excluded.push_token, " +
  "tz=excluded.tz, home_slug=excluded.home_slug, profile_json=excluded.profile_json, " +
  "prefs_json=excluded.prefs_json, plan=excluded.plan, entitlement_until=excluded.entitlement_until, " +
  "trial_used=excluded.trial_used, preview_seen=excluded.preview_seen, sent_json=excluded.sent_json, " +
  "updated_at=excluded.updated_at";

function deviceValues(row: DeviceRow): unknown[] {
  return [
    row.id,
    row.platform,
    row.push_token,
    row.tz,
    row.home_slug,
    row.profile_json,
    row.prefs_json,
    row.plan,
    row.entitlement_until,
    row.trial_used,
    row.preview_seen,
    row.sent_json,
    row.created_at,
    row.updated_at,
  ];
}

export function d1Store(db: D1Like): DeviceStore {
  const getRow = (id: string) =>
    db.prepare(`SELECT ${DEVICE_COLS} FROM devices WHERE id = ?`).bind(id).first<DeviceRow>();

  const getPresenceRow = (id: string) =>
    db.prepare("SELECT * FROM presence WHERE device_id = ?").bind(id).first<PresenceRow>();

  async function write(row: DeviceRow): Promise<void> {
    await db.prepare(UPSERT_DEVICE).bind(...deviceValues(row)).run();
  }

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
      const base = (await getRow(id)) ?? newDeviceRow(id, now);
      const next = applyPatch(base, patch, now);
      await write(next);
      return toApi(next);
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
                "d.prefs_json, d.plan, d.entitlement_until, d.trial_used, d.preview_seen, d.sent_json, " +
                "d.created_at, d.updated_at, p.device_id, p.slug, p.lat, p.lon, p.accuracy_m, " +
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
        await write(applyPatch(newDeviceRow(id, now), legacyPatch(sub), now));
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
  };
}
