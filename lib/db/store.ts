// The one storage interface behind every Plus feature. Two backends implement
// it: D1 in production (`d1Store.ts`, binding `DB`) and an in-memory map for
// tests and `next dev` without bindings (`memoryStore.ts`, which mirrors the old
// KV file fallback by persisting to .plus-store.json).
//
// Routes never import a backend directly — they call `getStore()`.

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
import { d1Store, getD1 } from "@/lib/db/d1Store";
import { memoryStore } from "@/lib/db/memoryStore";

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
  /** Create or patch. Returns the device as it now stands. */
  upsertDevice(id: string, patch: DevicePatch): Promise<DeviceRecord>;
  findByPushToken(token: string): Promise<DeviceRecord | null>;
  deleteDevice(id: string): Promise<void>;
  listDevices(): Promise<DeviceRecord[]>;
  /** Entitled devices whose presence window has not expired at `nowMs`. */
  listArmed(nowMs: number): Promise<ArmedDevice[]>;
  setPresence(deviceId: string, p: PresenceInput): Promise<void>;
  clearPresence(deviceId: string): Promise<void>;
  getSent(deviceId: string): Promise<SentState>;
  setSent(deviceId: string, sent: SentState): Promise<void>;
  lastAlert(deviceId: string, key: string): Promise<AlertMark | null>;
  markAlert(deviceId: string, key: string, at: number, meta?: unknown): Promise<void>;
  /** Import legacy KV push subscriptions. Idempotent: a token that already has
   *  a device row is skipped, so it never resurrects or clobbers live state. */
  importLegacy(subs: NativeSub[]): Promise<{ imported: number; skipped: number }>;
  /** Raw push token for a device — the sender needs it; the API shape hides it. */
  getPushToken(id: string): Promise<string | null>;
  /** Every device that can receive a push, with its token. */
  listPushable(): Promise<PushableDevice[]>;
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
