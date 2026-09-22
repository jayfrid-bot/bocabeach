// In-memory DeviceStore. Used by vitest (isolated, no files) and by `next dev`
// when no D1 binding is wired — there it also persists to a gitignored
// .plus-store.json, mirroring the old .push-native-store.json fallback so a dev
// restart doesn't lose the device you just registered.
//
// Same OBSERVABLE semantics as the D1 backend (#3, #4): a field left out of a
// patch survives a concurrent write to some other field, grants only ever
// move access up, and a trial can be claimed exactly once. d1Store gets there
// with one atomic SQL statement per write; this store gets there because
// Node is single-threaded and every read-modify-write below has no `await`
// between the read and the write, so nothing else can run in the gap.

import { promises as fs } from "node:fs";
import path from "node:path";
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
import { applyPatch, entitled, newDeviceRow, parseSent, toRecord } from "@/lib/db/types";
import { legacyDeviceId, legacyPatch } from "@/lib/db/legacy";
import type { DeviceStore } from "@/lib/db/store";
import { ABANDONED_CLAIM_MS, CLAIM_RETENTION_MS } from "@/lib/db/sendClaims";
import type { ArchiveCandidate, BeachHourlyRow } from "@/lib/history/types";
import { listLocations } from "@/config/locations";
import { compareByLastHourThenSlug, hourUtcOf, shouldArchiveNow } from "@/lib/history/archive";

const FILE = path.join(process.cwd(), ".plus-store.json");

interface AlertRow {
  device_id: string;
  alert_key: string;
  sent_at: number;
  meta_json: string | null;
}

/** One row of `send_claims` (#14) — see migrations/0004_send_claims.sql. */
interface ClaimRow {
  key: string;
  claimed_at: number;
  sent_at: number | null;
}

/** One row of `history_claims` — see migrations/0006_history.sql. */
interface HistoryClaimRow {
  key: string;
  claimed_at: number;
  completed_at: number | null;
}

interface Snapshot {
  devices: DeviceRow[];
  presence: PresenceRow[];
  alerts: AlertRow[];
  claims?: ClaimRow[];
  beachHourly?: BeachHourlyRow[];
  historyBudget?: { day: string; builds: number }[];
  historyClaims?: HistoryClaimRow[];
}

const alertKey = (deviceId: string, key: string) => `${deviceId}${key}`;

/**
 * Build a store over its own maps. `file` = null keeps it purely in memory
 * (tests); a path makes it read once on first use and write after each change.
 */
export function createMemoryStore(opts: { file?: string | null } = {}): DeviceStore {
  const file = opts.file ?? null;
  const devices = new Map<string, DeviceRow>();
  const presence = new Map<string, PresenceRow>();
  const alerts = new Map<string, AlertRow>();
  const claims = new Map<string, ClaimRow>();
  const beachHourly = new Map<string, BeachHourlyRow>(); // key: `${slug}|${hour_utc}`
  const historyBudget = new Map<string, number>(); // key: day
  const historyClaims = new Map<string, HistoryClaimRow>(); // key: `history:<slug>:<hour_utc>`
  let loaded = file === null;

  async function load(): Promise<void> {
    if (loaded) return;
    loaded = true; // even on failure — a missing file is the normal first run
    try {
      const raw = JSON.parse(await fs.readFile(file as string, "utf8")) as Snapshot;
      for (const d of raw.devices ?? []) devices.set(d.id, d);
      for (const p of raw.presence ?? []) presence.set(p.device_id, p);
      for (const a of raw.alerts ?? []) alerts.set(alertKey(a.device_id, a.alert_key), a);
      for (const c of raw.claims ?? []) claims.set(c.key, c);
      for (const h of raw.beachHourly ?? []) beachHourly.set(`${h.slug}|${h.hour_utc}`, h);
      for (const b of raw.historyBudget ?? []) historyBudget.set(b.day, b.builds);
      for (const c of raw.historyClaims ?? []) historyClaims.set(c.key, c);
    } catch {
      /* no file yet, or unreadable → start empty */
    }
  }

  async function save(): Promise<void> {
    if (file === null) return;
    const snap: Snapshot = {
      devices: [...devices.values()],
      presence: [...presence.values()],
      alerts: [...alerts.values()],
      claims: [...claims.values()],
      beachHourly: [...beachHourly.values()],
      historyBudget: [...historyBudget.entries()].map(([day, builds]) => ({ day, builds })),
      historyClaims: [...historyClaims.values()],
    };
    try {
      await fs.writeFile(file, JSON.stringify(snap, null, 2));
    } catch {
      /* read-only fs (deployed) → stay in memory */
    }
  }

  const record = (row: DeviceRow): DeviceRecord => toRecord(row, presence.get(row.id) ?? null);

  return {
    async getDevice(id) {
      await load();
      const row = devices.get(id);
      return row ? record(row) : null;
    },

    async upsertDevice(id, patch) {
      await load();
      const now = Date.now();
      // No `await` between this read and the `devices.set` below — that gap
      // is exactly what let a concurrent D1 write clobber another one (#3).
      // Node is single-threaded and nothing here yields in between, so this
      // read-modify-write is already atomic with respect to any other call.
      const base = devices.get(id) ?? newDeviceRow(id, now);
      const next = applyPatch(base, patch, now);
      devices.set(id, next);
      await save();
      return record(next);
    },

    async claimTrial(id, until) {
      await load();
      const now = Date.now();
      const base = devices.get(id) ?? newDeviceRow(id, now);
      // Same no-await-in-between guarantee as upsertDevice: whichever of two
      // concurrent claims runs first sees trial_used still 0 and wins; the
      // other reads it back as 1 and loses, atomically (#3, #4).
      if (base.trial_used) return "trial-used";
      const next = applyPatch(base, { trialUntil: until, trialUsed: true }, now);
      devices.set(id, next);
      await save();
      return record(next);
    },

    async clearPushToken(id, expectedToken) {
      await load();
      const row = devices.get(id);
      // Only clear if the token on file is still the dead one — a concurrent
      // re-registration with a fresh token must not be undone (#5).
      if (!row || row.push_token !== expectedToken) return;
      devices.set(id, applyPatch(row, { pushToken: null }, Date.now()));
      await save();
    },

    async findByPushToken(token) {
      await load();
      for (const row of devices.values()) {
        if (row.push_token === token) return record(row);
      }
      return null;
    },

    async deleteDevice(id) {
      await load();
      devices.delete(id);
      presence.delete(id);
      for (const k of [...alerts.keys()]) {
        if (alerts.get(k)?.device_id === id) alerts.delete(k);
      }
      await save();
    },

    async listDevices() {
      await load();
      return [...devices.values()].map(record);
    },

    async listArmed(nowMs) {
      await load();
      const out: ArmedDevice[] = [];
      for (const p of presence.values()) {
        if (p.armed_until <= nowMs) continue;
        const row = devices.get(p.device_id);
        if (!row || !entitled(row, nowMs)) continue;
        out.push({
          device: record(row),
          presence: {
            slug: p.slug,
            lat: p.lat,
            lon: p.lon,
            accuracyM: p.accuracy_m,
            fixAt: p.fix_at,
            armedUntil: p.armed_until,
            source: p.source === "auto" ? "auto" : "manual",
          },
        });
      }
      return out;
    },

    async setPresence(deviceId, p: PresenceInput) {
      await load();
      presence.set(deviceId, {
        device_id: deviceId,
        slug: p.slug,
        lat: p.lat ?? null,
        lon: p.lon ?? null,
        accuracy_m: p.accuracyM ?? null,
        fix_at: p.fixAt ?? null,
        armed_until: p.armedUntil,
        source: p.source,
        updated_at: Date.now(),
      });
      await save();
    },

    async clearPresence(deviceId) {
      await load();
      presence.delete(deviceId);
      await save();
    },

    async getSent(deviceId) {
      await load();
      return parseSent(devices.get(deviceId)?.sent_json);
    },

    async setSent(deviceId, sent: SentState) {
      await load();
      const row = devices.get(deviceId);
      if (!row) return;
      devices.set(deviceId, applyPatch(row, { sent }, Date.now()));
      await save();
    },

    async lastAlert(deviceId, key): Promise<AlertMark | null> {
      await load();
      const row = alerts.get(alertKey(deviceId, key));
      if (!row) return null;
      return { sentAt: row.sent_at, meta: row.meta_json ? JSON.parse(row.meta_json) : null };
    },

    async markAlert(deviceId, key, at, meta) {
      await load();
      alerts.set(alertKey(deviceId, key), {
        device_id: deviceId,
        alert_key: key,
        sent_at: at,
        meta_json: meta === undefined ? null : JSON.stringify(meta),
      });
      await save();
    },

    async importLegacy(subs: NativeSub[]) {
      await load();
      const known = new Set<string>();
      for (const row of devices.values()) if (row.push_token) known.add(row.push_token);
      let imported = 0;
      let skipped = 0;
      const now = Date.now();
      for (const sub of subs) {
        if (!sub?.token || known.has(sub.token)) {
          skipped += 1;
          continue;
        }
        const id = legacyDeviceId(sub.token);
        if (devices.has(id)) {
          skipped += 1;
          continue;
        }
        devices.set(
          id,
          applyPatch(newDeviceRow(id, now), legacyPatch(sub), now),
        );
        known.add(sub.token);
        imported += 1;
      }
      if (imported) await save();
      return { imported, skipped };
    },

    async getPushToken(id) {
      await load();
      return devices.get(id)?.push_token ?? null;
    },

    async listPushable(): Promise<PushableDevice[]> {
      await load();
      const out: PushableDevice[] = [];
      for (const row of devices.values()) {
        if (!row.push_token) continue;
        if (row.platform !== "ios" && row.platform !== "android") continue;
        out.push({
          device: record(row),
          token: row.push_token,
          platform: row.platform,
          sent: parseSent(row.sent_json),
        });
      }
      return out;
    },

    // --- Atomic send claims (#14) -----------------------------------------
    async claimSend(key, now) {
      await load();
      const existing = claims.get(key);
      // Free to claim: nobody holds it, or the holder never finished and its
      // claim is old enough to call abandoned.
      const abandoned =
        !!existing && existing.sent_at == null && now - existing.claimed_at >= ABANDONED_CLAIM_MS;
      if (existing && !abandoned) return false;
      claims.set(key, { key, claimed_at: now, sent_at: null });
      await save();
      return true;
    },

    async markSent(key, now) {
      await load();
      const existing = claims.get(key);
      if (!existing) return; // nothing to mark — a send without a claim never happens
      claims.set(key, { ...existing, sent_at: now });
      await save();
    },

    async pruneSendClaims(now) {
      await load();
      let changed = false;
      for (const [key, row] of claims) {
        if (now - row.claimed_at > CLAIM_RETENTION_MS) {
          claims.delete(key);
          changed = true;
        }
      }
      if (changed) await save();
    },

    async purgeExpiredPresenceFixes(now) {
      await load();
      let purged = 0;
      for (const [id, p] of presence) {
        if (p.armed_until >= now) continue;
        if (p.lat == null && p.lon == null && p.accuracy_m == null && p.fix_at == null) continue;
        presence.set(id, { ...p, lat: null, lon: null, accuracy_m: null, fix_at: null, updated_at: now });
        purged += 1;
      }
      if (purged) await save();
      return purged;
    },

    // --- Hourly history archive (Part A) ------------------------------------
    async upsertBeachHourly(row: BeachHourlyRow) {
      await load();
      const key = `${row.slug}|${row.hour_utc}`;
      const existing = beachHourly.get(key);
      if (existing && !(row.snapshot_generated_at > existing.snapshot_generated_at)) {
        return { written: false };
      }
      beachHourly.set(key, { ...row });
      // Codex round-2 finding #5: a successful write must persist — this
      // mutated `beachHourly` in memory but never called save(), so a
      // reopened file-backed store (a `next dev` restart, or a fresh test
      // instance against the same file) silently lost every archived row.
      await save();
      return { written: true };
    },

    // Fair ordering, mirroring d1Store (Codex round-3 finding #1): compute
    // each slug's most recent beach_hourly row from the in-memory map, then
    // sort never-archived-first, then oldest-last-row-first, ties by slug.
    async listArchiveCandidates(nowMs: number) {
      await load();
      const hourUtc = hourUtcOf(nowMs);
      const archivedThisHour = new Set(
        [...beachHourly.values()].filter((r) => r.hour_utc === hourUtc).map((r) => r.slug),
      );
      const lastHourBySlug = new Map<string, string>();
      for (const r of beachHourly.values()) {
        const cur = lastHourBySlug.get(r.slug);
        if (cur === undefined || r.hour_utc > cur) lastHourBySlug.set(r.slug, r.hour_utc);
      }
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
      await load();
      return historyBudget.get(day) ?? 0;
    },

    // No `await` between the read and the write below, same guarantee as
    // every other read-modify-write in this store (see file header) — that
    // is what makes "reserve only if under max" atomic without needing a
    // real SQL statement here.
    async reserveHistoryBuild(day: string, max: number) {
      await load();
      // max <= 0 must refuse outright, same as d1Store (Codex round-2
      // finding #2) — otherwise `cur >= max` is false on the very first
      // reservation of the day (0 >= 0 is true, so this alone would be
      // fine, but a negative max must refuse too, and this guard covers both
      // plainly rather than relying on that coincidence).
      if (max <= 0) return false;
      const cur = historyBudget.get(day) ?? 0;
      if (cur >= max) return false;
      historyBudget.set(day, cur + 1);
      await save();
      return true;
    },

    // Same abandonment-window shape as claimSend (Codex round-2 finding #4):
    // free to (re-)claim when nobody holds the key, or the holder never
    // completed its build and its claim is old enough to call abandoned.
    async claimHistoryBuild(slug: string, hourUtc: string, now: number) {
      await load();
      const key = `history:${slug}:${hourUtc}`;
      const existing = historyClaims.get(key);
      const abandoned =
        !!existing && existing.completed_at == null && now - existing.claimed_at >= ABANDONED_CLAIM_MS;
      if (existing && !abandoned) return false;
      historyClaims.set(key, { key, claimed_at: now, completed_at: null });
      await save();
      return true;
    },

    async completeHistoryClaim(slug: string, hourUtc: string, now: number) {
      await load();
      const key = `history:${slug}:${hourUtc}`;
      const existing = historyClaims.get(key);
      if (!existing) return; // completed without a claim never happens
      historyClaims.set(key, { ...existing, completed_at: now });
      await save();
    },

    async releaseHistoryClaim(slug: string, hourUtc: string) {
      await load();
      const key = `history:${slug}:${hourUtc}`;
      if (historyClaims.delete(key)) await save();
    },
  };
}

// The process-wide instance `getStore()` hands out when there is no D1 binding.
// Persists only outside vitest, so tests never touch the filesystem.
let shared: DeviceStore | null = null;

export function memoryStore(): DeviceStore {
  shared ??= createMemoryStore({ file: process.env.VITEST ? null : FILE });
  return shared;
}

/** Drop the shared instance — route tests call this to start from empty. */
export function resetMemoryStore(): void {
  shared = null;
}
