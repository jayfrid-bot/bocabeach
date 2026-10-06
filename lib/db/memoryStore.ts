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
import {
  ABANDONED_CLAIM_MS as COMING_UP_ABANDONED_CLAIM_MS,
  COMING_UP_24H_MS,
  COMING_UP_30D_MS,
  COMING_UP_MAX_PER_24H,
  COMING_UP_MAX_PER_30D,
  COMING_UP_RETENTION_MS,
} from "@/lib/db/comingUpClaims";
import type { ComingUpDeliveryRow } from "@/lib/db/store";
import type {
  ArchiveCandidate,
  BeachHourlyRow,
  HistoryRecordRow,
  HistoryRecordsResult,
  SunEventObservationRow,
  SunEventPredictionRow,
} from "@/lib/history/types";
import { sunCamObservedSource } from "@/lib/history/types";
import { listLocations } from "@/config/locations";
import { compareByLastHourThenSlug, hourUtcOf, shouldArchiveNow } from "@/lib/history/archive";
import type {
  LiveActivityRow,
  RegisterLiveActivityInput,
  RegisterLiveActivityResult,
  UpsertLiveActivityInput,
} from "@/lib/db/store";

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
  sunEventPredictions?: SunEventPredictionRow[];
  sunEventObservations?: SunEventObservationRow[];
  historyBudget?: { day: string; builds: number }[];
  historyClaims?: HistoryClaimRow[];
  liveActivities?: LiveActivityRow[];
  comingUpDeliveries?: ComingUpDeliveryRow[];
}

const sunPredKey = (r: Pick<SunEventPredictionRow, "slug" | "event_kind" | "event_iso" | "as_of_hour_utc">) =>
  `${r.slug}|${r.event_kind}|${r.event_iso}|${r.as_of_hour_utc}`;
const sunObsKey = (r: Pick<SunEventObservationRow, "slug" | "event_kind" | "event_date_local" | "cam_id">) =>
  `${r.slug}|${r.event_kind}|${r.event_date_local}|${r.cam_id}`;
/** Solar before antisolar, then the nearest cam, then cam_id (mirrors d1Store's BEST_SUN_OBSERVATION). */
const compareSunObservations = (a: SunEventObservationRow, b: SunEventObservationRow): number =>
  Number(b.view === "solar") - Number(a.view === "solar") ||
  a.distance_mi - b.distance_mi ||
  (a.cam_id < b.cam_id ? -1 : a.cam_id > b.cam_id ? 1 : 0);
const SUN_OBS_MATCH_WINDOW_MS = 15 * 60_000;
const alertKey = (deviceId: string, key: string) => `${deviceId}${key}`;
const comingUpKey = (deviceId: string, eventKey: string) => `${deviceId}|${eventKey}`;

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
  const sunPredictions = new Map<string, SunEventPredictionRow>(); // key: `${slug}|${kind}|${event_iso}|${as_of_hour_utc}`
  const sunObservations = new Map<string, SunEventObservationRow>(); // key: `${slug}|${kind}|${event_date_local}|${cam_id}`
  const historyBudget = new Map<string, number>(); // key: day
  const historyClaims = new Map<string, HistoryClaimRow>(); // key: `history:<slug>:<hour_utc>`
  const liveActivities = new Map<string, LiveActivityRow>(); // key: activityId
  const comingUpDeliveries = new Map<string, ComingUpDeliveryRow>(); // key: `${deviceId}|${eventKey}`
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
      for (const r of raw.sunEventPredictions ?? []) sunPredictions.set(sunPredKey(r), r);
      for (const r of raw.sunEventObservations ?? []) sunObservations.set(sunObsKey(r), r);
      for (const b of raw.historyBudget ?? []) historyBudget.set(b.day, b.builds);
      for (const c of raw.historyClaims ?? []) historyClaims.set(c.key, c);
      for (const a of raw.liveActivities ?? []) liveActivities.set(a.activityId, a);
      for (const c of raw.comingUpDeliveries ?? []) comingUpDeliveries.set(comingUpKey(c.deviceId, c.eventKey), c);
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
      sunEventPredictions: [...sunPredictions.values()],
      sunEventObservations: [...sunObservations.values()],
      historyBudget: [...historyBudget.entries()].map(([day, builds]) => ({ day, builds })),
      historyClaims: [...historyClaims.values()],
      liveActivities: [...liveActivities.values()],
      comingUpDeliveries: [...comingUpDeliveries.values()],
    };
    try {
      await fs.writeFile(file, JSON.stringify(snap, null, 2));
    } catch {
      /* read-only fs (deployed) → stay in memory */
    }
  }

  const record = (row: DeviceRow): DeviceRecord => toRecord(row, presence.get(row.id) ?? null);

  // Round-6: bumps the OWNING device row's `updated_at` for a write that
  // changes what a `DeviceRecord` carries (its `presence` field) without
  // touching any column ON `devices` itself — mirrors d1Store's own
  // same-batch devices-bump for `setPresence`/`clearPresence`. Without
  // this, `isStaleDeviceResponse` (lib/plus/client.ts) would see the SAME
  // revision as before and drop a response that's actually carrying fresh
  // arm/disarm state. A no-op when the device row doesn't exist (a
  // presence write for an id with no devices row is not a real scenario
  // this store needs to invent one for).
  const touchDevice = (id: string, now: number): void => {
    const row = devices.get(id);
    if (row) devices.set(id, { ...row, updated_at: Math.max((row.updated_at ?? 0) + 1, now) });
  };

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

    // --- Install token identity (migrations/0008_device_tokens.sql) --------
    async getInstallTokenHash(id) {
      await load();
      return devices.get(id)?.token_hash ?? null;
    },

    async setInstallTokenHash(id, tokenHash, issuedAt) {
      await load();
      const row = devices.get(id);
      // No `await` between this read and the `devices.set` below — same
      // no-race guarantee as `claimTrial` above.
      if (!row || row.token_hash) return false;
      // Round-5 item 1: monotonic, same as every other write here (via
      // `applyPatch`) — this is the one memoryStore write that doesn't go
      // through it, since it sets `token_issued_at` (a distinct column) to
      // the SAME value as `updated_at`, which `applyPatch`'s `DevicePatch`
      // shape has no field for.
      devices.set(id, {
        ...row,
        token_hash: tokenHash,
        token_issued_at: issuedAt,
        updated_at: Math.max((row.updated_at ?? 0) + 1, issuedAt),
      });
      await save();
      return true;
    },

    async getInstallTokenUsedAt(id) {
      await load();
      return devices.get(id)?.token_used_at ?? null;
    },

    async markInstallTokenUsed(id, usedAt) {
      await load();
      const row = devices.get(id);
      if (!row || row.token_used_at != null) return;
      devices.set(id, { ...row, token_used_at: usedAt });
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
      for (const k of [...comingUpDeliveries.keys()]) {
        if (comingUpDeliveries.get(k)?.deviceId === id) comingUpDeliveries.delete(k);
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
      const now = Date.now();
      presence.set(deviceId, {
        device_id: deviceId,
        slug: p.slug,
        lat: p.lat ?? null,
        lon: p.lon ?? null,
        accuracy_m: p.accuracyM ?? null,
        fix_at: p.fixAt ?? null,
        armed_until: p.armedUntil,
        source: p.source,
        updated_at: now,
      });
      touchDevice(deviceId, now);
      await save();
    },

    async clearPresence(deviceId) {
      await load();
      presence.delete(deviceId);
      touchDevice(deviceId, Date.now());
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

    // Atomic partial merge (Codex round-4 HIGH) — see lib/db/store.ts's doc.
    // No `await` between reading the current sent-state and writing the
    // merged one back, same no-race guarantee every other read-modify-write
    // in this file relies on (see the file header).
    async patchSent(deviceId, patch: Partial<SentState>) {
      await load();
      const row = devices.get(deviceId);
      if (!row) return;
      const keys = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
      if (!keys.length) return;
      const merged: SentState = { ...parseSent(row.sent_json) };
      for (const k of keys) (merged as Record<string, unknown>)[k] = (patch as Record<string, unknown>)[k];
      devices.set(deviceId, applyPatch(row, { sent: merged }, Date.now()));
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

    async markSent(key, claimedAt) {
      await load();
      const existing = claims.get(key);
      // Ownership guard (round-2 item 1), mirroring d1Store's SQL WHERE:
      // only the caller whose `claimedAt` still matches the row's CURRENT
      // `claimed_at` may mark it sent — a reclaim by a later run (which
      // stamps a new `claimed_at`) makes a stale caller's write a no-op.
      if (!existing || existing.claimed_at !== claimedAt || existing.sent_at != null) return false;
      claims.set(key, { ...existing, sent_at: claimedAt });
      await save();
      return true;
    },

    async releaseSend(key, claimedAt) {
      await load();
      const existing = claims.get(key);
      // Same ownership guard as `markSent`, plus never undo a confirmed send.
      if (!existing || existing.claimed_at !== claimedAt || existing.sent_at != null) return false;
      claims.delete(key);
      await save();
      return true;
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

    // Sun-event prediction log (migrations/0013) — mirrors d1Store: replace
    // only on a strictly newer snapshot, never touch the observed_* truth
    // columns of an existing row.
    async upsertSunEventPredictions(rows: SunEventPredictionRow[]) {
      await load();
      let written = 0;
      for (const row of rows) {
        const key = sunPredKey(row);
        const existing = sunPredictions.get(key);
        if (existing && !(row.snapshot_generated_at > existing.snapshot_generated_at)) continue;
        sunPredictions.set(key, {
          ...row,
          observed_score: existing?.observed_score ?? row.observed_score,
          observed_source: existing?.observed_source ?? row.observed_source,
          observed_at: existing?.observed_at ?? row.observed_at,
        });
        written += 1;
      }
      if (written) await save();
      return { written };
    },

    async sunEventPredictionsFor(slug: string, eventIso: string) {
      await load();
      return [...sunPredictions.values()]
        .filter((r) => r.slug === slug && r.event_iso === eventIso)
        .sort((a, b) => (a.as_of_hour_utc < b.as_of_hour_utc ? -1 : a.as_of_hour_utc > b.as_of_hour_utc ? 1 : 0))
        .map((r) => ({ ...r }));
    },

    // Sun-event observations (migrations/0015) — mirrors d1Store: upsert the
    // observation, then write the BEST observation of that event (solar first,
    // nearest cam) onto every prediction row within +-15 min, leaving rows a
    // human labelled alone.
    async recordSunEventObservation(row: SunEventObservationRow) {
      await load();
      sunObservations.set(sunObsKey(row), { ...row });
      const best = [...sunObservations.values()]
        .filter((o) => o.slug === row.slug && o.event_kind === row.event_kind && o.event_date_local === row.event_date_local)
        .sort(compareSunObservations)[0];
      const eventMs = Date.parse(row.event_iso);
      let predictionsUpdated = 0;
      for (const [key, pred] of sunPredictions) {
        if (pred.slug !== row.slug || pred.event_kind !== row.event_kind) continue;
        if (!(Math.abs(Date.parse(pred.event_iso) - eventMs) <= SUN_OBS_MATCH_WINDOW_MS)) continue;
        if (pred.observed_source !== null && !pred.observed_source.startsWith("sun-cam:")) continue;
        sunPredictions.set(key, {
          ...pred,
          observed_score: best.observed_score,
          observed_source: sunCamObservedSource(best.cam_id, best.view),
          observed_at: best.created_at,
        });
        predictionsUpdated += 1;
      }
      await save();
      return { predictionsUpdated };
    },

    async sunEventObservationsFor(slug: string, eventKind: "sunrise" | "sunset", eventDateLocal: string) {
      await load();
      return [...sunObservations.values()]
        .filter((o) => o.slug === slug && o.event_kind === eventKind && o.event_date_local === eventDateLocal)
        .sort(compareSunObservations)
        .map((o) => ({ ...o }));
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

    // --- Hourly history READ (Plus "Last N days" feature) -------------------
    // Mirrors d1Store's single-query filter: this slug, snapshot rows only,
    // local_date within [sinceLocalDate, untilLocalDate] inclusive, oldest
    // first.
    async hourlyHistory(slug: string, sinceLocalDate: string, untilLocalDate: string) {
      await load();
      return [...beachHourly.values()]
        .filter(
          (r) =>
            r.slug === slug &&
            r.row_kind === "snapshot" &&
            r.local_date >= sinceLocalDate &&
            r.local_date <= untilLocalDate,
        )
        .sort((a, b) => (a.hour_utc < b.hour_utc ? -1 : a.hour_utc > b.hour_utc ? 1 : 0));
    },

    // Lifetime records — mirrors d1Store's UNION ALL: for each kind, the
    // single row that wins (max for best/hottest_sand/biggest_surf, min for
    // quietest), ties broken by the earliest hour_utc, same rule the SQL's
    // own `ORDER BY value [ASC|DESC], hour_utc ASC LIMIT 1` encodes.
    async historyRecords(slug: string): Promise<HistoryRecordsResult> {
      await load();
      const rowsForSlug = [...beachHourly.values()].filter((r) => r.slug === slug && r.row_kind === "snapshot");

      function pick(
        key: keyof BeachHourlyRow,
        direction: "max" | "min",
        extraFilter?: (r: BeachHourlyRow) => boolean,
      ): { local_date: string; local_hour: number; value: number } | null {
        let winner: BeachHourlyRow | null = null;
        for (const r of rowsForSlug) {
          const v = r[key];
          if (typeof v !== "number" || !Number.isFinite(v)) continue;
          if (extraFilter && !extraFilter(r)) continue;
          if (!winner) {
            winner = r;
            continue;
          }
          const wv = winner[key] as number;
          const better = direction === "max" ? v > wv : v < wv;
          const tie = v === wv;
          if (better || (tie && r.hour_utc < winner.hour_utc)) winner = r;
        }
        return winner ? { local_date: winner.local_date, local_hour: winner.local_hour, value: winner[key] as number } : null;
      }

      const records: HistoryRecordRow[] = [];
      const best = pick("score", "max");
      if (best) records.push({ kind: "best", ...best });
      const sand = pick("sand_temp_f", "max");
      if (sand) records.push({ kind: "hottest_sand", ...sand });
      const surf = pick("surf_ft", "max");
      if (surf) records.push({ kind: "biggest_surf", ...surf });
      const quiet = pick("crowd_pct", "min", (r) => r.local_hour >= 10 && r.local_hour <= 18);
      if (quiet) records.push({ kind: "quietest", ...quiet });

      let archiveStartedAt: string | null = null;
      let surfSince: string | null = null;
      const dates = new Set<string>();
      for (const r of rowsForSlug) {
        dates.add(r.local_date);
        if (archiveStartedAt === null || r.local_date < archiveStartedAt) archiveStartedAt = r.local_date;
        if (typeof r.surf_ft === "number" && (surfSince === null || r.local_date < surfSince)) surfSince = r.local_date;
      }

      return { records, archiveStartedAt, dayCount: dates.size, surfSince };
    },

    // --- Beach Session Live Activity (migrations/0007_live_activities.sql) -
    async upsertLiveActivity(input: UpsertLiveActivityInput) {
      await load();
      const existing = liveActivities.get(input.activityId);
      const row: LiveActivityRow = {
        activityId: input.activityId,
        deviceId: input.deviceId,
        beachSlug: input.beachSlug,
        schemaVersion: input.schemaVersion,
        appBuild: input.appBuild,
        apnsEnvironment: input.apnsEnvironment,
        pushToken: input.pushToken,
        tokenUpdatedAt: Date.now(),
        // startedAt is sticky: only the FIRST upsert for this activityId sets it.
        startedAt: existing ? existing.startedAt : input.startedAt,
        expiresAt: input.expiresAt,
        endedAt: null,
        status: "active",
        lastStateJson: existing?.lastStateJson ?? null,
        lastStateHash: existing?.lastStateHash ?? null,
        pendingStateJson: existing?.pendingStateJson ?? null,
        pendingSince: existing?.pendingSince ?? null,
        nextSendAt: existing?.nextSendAt ?? null,
        lastSentAt: existing?.lastSentAt ?? null,
        lastApnsTimestamp: existing?.lastApnsTimestamp ?? null,
        lastApnsStatus: existing?.lastApnsStatus ?? null,
        tokenRotation: existing?.tokenRotation ?? 0,
        lastSeq: existing?.lastSeq ?? 0,
      };
      liveActivities.set(input.activityId, row);
      await save();
      return row;
    },

    // The register ROUTE's real entry point (Codex review #4) — see
    // store.ts's doc for the ownership/rotation/one-batch contract. Node is
    // single-threaded and nothing below `await`s in between, so the
    // "supersede other active rows, then upsert this one" pair is already
    // atomic with respect to any other call, the same guarantee every other
    // read-modify-write in this file relies on.
    async registerLiveActivity(input: RegisterLiveActivityInput): Promise<RegisterLiveActivityResult> {
      await load();
      const existing = liveActivities.get(input.activityId);
      if (existing && existing.deviceId !== input.deviceId) return "device-mismatch";
      // Codex round-3 #3 (HIGH): a register for an activity that is no
      // longer 'active' (ended, or superseded by a later one) must never
      // silently reactivate it — mirrors d1Store's WHERE ... AND status =
      // 'active' guard.
      if (existing && existing.status !== "active") return "ended";
      if (existing && input.rotation != null && input.rotation <= existing.tokenRotation) {
        return "stale-rotation";
      }
      const now = Date.now();
      for (const [id, row] of liveActivities) {
        if (row.deviceId === input.deviceId && id !== input.activityId && row.status === "active") {
          // Superseded — its token is as done as an explicitly-ended row's
          // (Codex review #10, see store.ts markLiveActivityEnded doc).
          liveActivities.set(id, { ...row, status: "ended", endedAt: now, pushToken: "" });
        }
      }
      const row: LiveActivityRow = {
        activityId: input.activityId,
        deviceId: input.deviceId,
        beachSlug: input.beachSlug,
        schemaVersion: input.schemaVersion,
        appBuild: input.appBuild,
        apnsEnvironment: input.apnsEnvironment,
        pushToken: input.pushToken,
        tokenUpdatedAt: now,
        startedAt: existing ? existing.startedAt : input.startedAt,
        expiresAt: input.expiresAt,
        endedAt: null,
        status: "active",
        lastStateJson: existing?.lastStateJson ?? null,
        lastStateHash: existing?.lastStateHash ?? null,
        pendingStateJson: existing?.pendingStateJson ?? null,
        pendingSince: existing?.pendingSince ?? null,
        nextSendAt: existing?.nextSendAt ?? null,
        lastSentAt: existing?.lastSentAt ?? null,
        lastApnsTimestamp: existing?.lastApnsTimestamp ?? null,
        lastApnsStatus: existing?.lastApnsStatus ?? null,
        tokenRotation: input.rotation ?? existing?.tokenRotation ?? 0,
        lastSeq: existing?.lastSeq ?? 0,
      };
      liveActivities.set(input.activityId, row);
      await save();
      return row;
    },

    async setLiveActivityExpiry(activityId: string, expiresAt: number) {
      await load();
      const row = liveActivities.get(activityId);
      if (!row) return;
      liveActivities.set(activityId, { ...row, expiresAt });
      await save();
    },

    async touchLiveActivityCursor(activityId: string, nextSendAt: number) {
      await load();
      const row = liveActivities.get(activityId);
      if (!row) return;
      liveActivities.set(activityId, { ...row, nextSendAt });
      await save();
    },

    async listActiveLiveActivities(now: number) {
      await load();
      // `now` is accepted for interface parity with a real SQL "WHERE status =
      // 'active'" scan (no time filter is applied here — the caller decides
      // what's due to end); kept as a parameter so both backends read the same.
      void now;
      return [...liveActivities.values()].filter((a) => a.status === "active");
    },

    async listLiveActivitiesForDevice(deviceId: string) {
      await load();
      return [...liveActivities.values()].filter((a) => a.deviceId === deviceId);
    },

    async markLiveActivityEnded(activityId: string, _reason: string, now: number, opts) {
      await load();
      void _reason; // diagnostics only — not a stored column (see store.ts doc)
      const row = liveActivities.get(activityId);
      if (!row || row.status === "ended") return;
      liveActivities.set(activityId, {
        ...row,
        status: "ended",
        endedAt: now,
        pushToken: opts?.clearToken ? "" : row.pushToken,
      });
      await save();
    },

    // Node is single-threaded and nothing below `await`s between the read
    // and the `set` — this increment is already atomic with respect to any
    // other call, same guarantee every other read-modify-write here relies
    // on (round-2 #5). The timestamp is folded into the same synchronous
    // step (Codex round-3 fix) — see store.ts's doc for why seq and
    // timestamp must be allocated together, not one in JS after a network
    // call.
    async allocateLiveActivitySeq(activityId: string, now: number) {
      await load();
      const row = liveActivities.get(activityId);
      if (!row || row.status !== "active") return null;
      const seq = row.lastSeq + 1;
      // +1000ms, not +1ms (Codex round-4 #5, mirrors d1Store.ts): the wire
      // payload transmits whole epoch SECONDS (Math.floor(ms/1000)), so a
      // full second's worth of floor is what actually guarantees two
      // allocations land in strictly increasing transmitted seconds.
      const timestampMs = Math.max((row.lastSentAt ?? 0) + 1000, now);
      liveActivities.set(activityId, { ...row, lastSeq: seq, lastSentAt: timestampMs });
      await save();
      return { seq, timestampMs };
    },

    async recordLiveActivitySend(
      activityId: string,
      send: { timestamp: number; status: number; hash: string; stateJson?: string; seq: number },
    ) {
      await load();
      const row = liveActivities.get(activityId);
      if (!row) return;
      // Compare-and-swap on lastSeq (round-2 #5) — see d1Store's mirror of
      // this for the full reasoning: a stale bookkeeping write must never
      // land after a newer seq has already been allocated for this row.
      if (row.lastSeq !== send.seq) return;
      liveActivities.set(activityId, {
        ...row,
        lastSentAt: send.timestamp,
        lastApnsTimestamp: send.timestamp,
        lastApnsStatus: send.status,
        lastStateHash: send.hash,
        lastStateJson: send.stateJson ?? row.lastStateJson,
        nextSendAt: send.timestamp,
      });
      await save();
    },

    async purgeLiveActivities(cutoffMs: number) {
      await load();
      let purged = 0;
      for (const [id, row] of liveActivities) {
        if (row.status === "ended" && row.endedAt != null && row.endedAt < cutoffMs) {
          liveActivities.delete(id);
          purged += 1;
        }
      }
      if (purged) await save();
      return purged;
    },

    // --- "Coming up" sky-events alert ledger (migrations/0011_coming_up_ ---
    // --- deliveries.sql, docs/SKY_EVENTS_PLAN.md §10) -----------------------
    //
    // Same no-`await`-between-read-and-write guarantee as every other
    // read-modify-write in this store (see file header) — that is what makes
    // the dedupe check + cap counts + reservation write atomic here without a
    // real SQL statement, mirroring d1Store's single CLAIM_COMING_UP query.
    async claimComingUp(deviceId, eventKey, claimToken, nowMs) {
      await load();
      // (a) once-ever dedupe: a durable alert_log row for this exact event
      // survives this ledger being pruned.
      if (alerts.get(alertKey(deviceId, eventKey))) return "already-sent";

      const abandonCutoff = nowMs - COMING_UP_ABANDONED_CLAIM_MS;

      // (b) a DIFFERENT, still-live reservation for this EXACT (device,
      // event) pair — Codex round-4 HIGH — checked before the cap counts,
      // same priority `already-sent` has, since it is likewise about THIS
      // one event, not the device's aggregate cap.
      const key = comingUpKey(deviceId, eventKey);
      const existing = comingUpDeliveries.get(key);
      if (existing) {
        if (existing.sentAt != null) return "already-sent"; // defensive; alert_log should have caught this above
        const abandoned = existing.claimedAt <= abandonCutoff;
        if (!abandoned) return "in-flight";
        // else: genuinely abandoned — falls through to reclaim below.
      }

      const window30 = nowMs - COMING_UP_30D_MS;
      const window24 = nowMs - COMING_UP_24H_MS;
      // "Live" = confirmed sent within the window, OR an unsent reservation
      // that hasn't been abandoned yet (it represents a send in flight right
      // now, regardless of when it was first claimed).
      const isLive = (r: ComingUpDeliveryRow, windowStart: number): boolean =>
        (r.sentAt != null && r.sentAt >= windowStart) || (r.sentAt == null && r.claimedAt > abandonCutoff);
      let count30 = 0;
      let count24 = 0;
      for (const r of comingUpDeliveries.values()) {
        if (r.deviceId !== deviceId) continue;
        if (isLive(r, window30)) count30 += 1;
        if (isLive(r, window24)) count24 += 1;
      }
      if (count30 >= COMING_UP_MAX_PER_30D || count24 >= COMING_UP_MAX_PER_24H) return "capped";

      comingUpDeliveries.set(key, {
        deviceId,
        eventKey,
        claimToken,
        claimedAt: nowMs,
        sentAt: null,
        status: "reserved",
      });
      await save();
      return "claimed";
    },

    async completeComingUp(deviceId, eventKey, claimToken, nowMs) {
      await load();
      const key = comingUpKey(deviceId, eventKey);
      const existing = comingUpDeliveries.get(key);
      // Stale/unknown claimant (lost a race to a newer reclaim, or this
      // reservation was already released/never existed) → silently do
      // nothing, same as d1Store's WHERE-guarded UPDATE affecting 0 rows.
      if (!existing || existing.claimToken !== claimToken) return;
      // Both writes happen with no `await` between them — the same
      // one-batch atomicity d1Store gets from a real D1 `.batch()` call.
      comingUpDeliveries.set(key, { ...existing, sentAt: nowMs, status: "sent" });
      alerts.set(alertKey(deviceId, eventKey), {
        device_id: deviceId,
        alert_key: eventKey,
        sent_at: nowMs,
        meta_json: null,
      });
      await save();
    },

    async releaseComingUp(deviceId, eventKey, claimToken) {
      await load();
      const key = comingUpKey(deviceId, eventKey);
      const existing = comingUpDeliveries.get(key);
      if (!existing || existing.claimToken !== claimToken) return;
      comingUpDeliveries.delete(key);
      await save();
    },

    async pruneComingUp(nowMs) {
      await load();
      let changed = false;
      const cutoffSent = nowMs - COMING_UP_RETENTION_MS;
      const cutoffAbandoned = nowMs - COMING_UP_ABANDONED_CLAIM_MS;
      for (const [key, row] of comingUpDeliveries) {
        const expiredSent = row.sentAt != null && row.sentAt < cutoffSent;
        const abandonedUnsent = row.sentAt == null && row.claimedAt < cutoffAbandoned;
        if (expiredSent || abandonedUnsent) {
          comingUpDeliveries.delete(key);
          changed = true;
        }
      }
      if (changed) await save();
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
