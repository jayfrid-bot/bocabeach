// The save-retry queue's pure merge rules — what beachMode.ts is to Beach
// Mode, this is to a failed profile/home/prefs save: small, storage-agnostic
// functions so "does a later edit really replace an earlier unsent one" is
// testable directly, without a fake localStorage or a rendered component.
//
// lib/plus/storage.ts wires these to `bd:pending-writes`; lib/plus/client.ts
// decides WHEN to flush (foreground, online, mount) and calls the storage
// wrappers.

import type { AlertPrefs, PendingWrites } from "@/lib/plus/types";
import type { ScoreProfile } from "@/lib/profile/types";

export type { PendingWrites };

/** Fold a new profile edit into the queue. A profile saves as one whole
 *  object, so the newest edit is the only one worth sending — it replaces
 *  whatever was pending, it does not merge with it. */
export function mergeProfile(pending: PendingWrites, profile: ScoreProfile): PendingWrites {
  return { ...pending, profile };
}

/** Same rule for a home-beach change: the latest pick wins outright. */
export function mergeHomeSlug(pending: PendingWrites, slug: string): PendingWrites {
  return { ...pending, homeSlug: slug };
}

/** Fold a prefs patch into the queue per KEY, not per whole object — toggling
 *  Lightning then Rip while offline queues both, rather than the second
 *  toggle discarding the first (last write wins, but only for the keys it
 *  actually touched). */
export function mergePrefs(pending: PendingWrites, patch: Partial<AlertPrefs>): PendingWrites {
  return { ...pending, prefs: { ...(pending.prefs ?? {}), ...patch } };
}

/** Drop one kind of write from the queue entirely — used once it is
 *  confirmed saved, or once the server has rejected it outright (a 4xx,
 *  where retrying would only repeat the same rejected request). */
export function clearField(pending: PendingWrites, field: keyof PendingWrites): PendingWrites {
  const next = { ...pending };
  delete next[field];
  return next;
}

/** Drop specific prefs keys from the queue — used when only SOME of a
 *  multi-key pending prefs patch just landed (or was rejected), so the rest
 *  stay queued instead of the whole prefs field being cleared at once. */
export function clearPrefsKeys(pending: PendingWrites, keys: readonly string[]): PendingWrites {
  if (!pending.prefs) return pending;
  const next: Partial<AlertPrefs> = { ...pending.prefs };
  for (const k of keys) delete next[k as keyof AlertPrefs];
  const out = { ...pending };
  if (Object.keys(next).length) out.prefs = next;
  else delete out.prefs;
  return out;
}

export function isEmpty(pending: PendingWrites): boolean {
  return !pending.profile && !pending.homeSlug && !(pending.prefs && Object.keys(pending.prefs).length);
}

/** A save worth retrying: the network never answered, or the server itself
 *  had a bad moment (5xx). A 4xx is the server's final word on that request —
 *  queuing it again would only ask the same rejected question forever. */
export function isRetryableSaveError(res: { ok: boolean; error: string | null; status: number }): boolean {
  if (res.ok) return false;
  return res.error === "network" || res.status >= 500;
}
