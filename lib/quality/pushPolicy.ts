// When may a quality alert buzz the owner's phone? Pure rules, no I/O
// (docs/QUALITY_PLAN.md, "Catch"). An alert that fails any rule is still
// stored and shows in the review list; it just does not push.
//
//   - Only for watched beaches: those with vision cams (config/vision-cams.json)
//     plus boca-raton.
//   - Never between 9 PM and 7 AM in America/New_York (the owner's day).
//   - Not again for the same beach and signal within 3 hours of the last push.
//   - At most 3 pushes per owner day (midnight to midnight, America/New_York).
//
// The checks run in that order, and the first one that fails is the reason.

import visionCams from "@/config/vision-cams.json";
import { localHourParts } from "@/lib/history/archive";
import { startOfLocalDayMs } from "@/lib/quality/localDay";

export const OWNER_TZ = "America/New_York";
export const MAX_PUSHES_PER_DAY = 3;
export const QUIET_START_HOUR = 21; // 9 PM
export const QUIET_END_HOUR = 7; // 7 AM
export const DEDUPE_WINDOW_MS = 3 * 3_600_000;

/** Beaches whose alerts may push: every vision-cam beach, plus Boca Raton. */
export function watchedSlugs(): string[] {
  return [...new Set(["boca-raton", ...Object.keys(visionCams)])];
}

export function isWatched(slug: string): boolean {
  return watchedSlugs().includes(slug);
}

/** True from 9 PM up to (not including) 7 AM owner time. */
export function inQuietHours(nowMs: number): boolean {
  const { hour } = localHourParts(OWNER_TZ, nowMs);
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

/** The instant (ms) the owner's current calendar day began. */
export function ownerDayStartMs(nowMs: number): number {
  return startOfLocalDayMs(OWNER_TZ, nowMs);
}

export type PushReason = "ok" | "unwatched" | "quiet-hours" | "duplicate" | "daily-cap";

export interface PushDecision {
  push: boolean;
  reason: PushReason;
}

export interface PushFacts {
  nowMs: number;
  slug: string;
  /** Pushes already sent today (owner day), across all beaches. */
  pushedToday: number;
  /** ms epoch of the last push for this beach and signal, if any. */
  lastPushedSameKeyMs: number | null;
  /** Override for tests; defaults to the real watch list. */
  watched?: (slug: string) => boolean;
}

/** May this alert push? Pure. */
export function decidePush(f: PushFacts): PushDecision {
  if (!(f.watched ?? isWatched)(f.slug)) return { push: false, reason: "unwatched" };
  if (inQuietHours(f.nowMs)) return { push: false, reason: "quiet-hours" };
  if (f.lastPushedSameKeyMs != null && f.nowMs - f.lastPushedSameKeyMs < DEDUPE_WINDOW_MS) {
    return { push: false, reason: "duplicate" };
  }
  if (f.pushedToday >= MAX_PUSHES_PER_DAY) return { push: false, reason: "daily-cap" };
  return { push: true, reason: "ok" };
}
