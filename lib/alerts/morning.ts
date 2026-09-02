// The home-beach alerts: the morning digest, in the person's own number, and
// "your beach day just turned Excellent".
//
// Owner decision: every alert is Plus. A free device gets no digest and no
// Excellent alert, and its dedup state is left untouched, so the day it
// subscribes it starts clean.
//
// The digest itself is still built by `summarizeForPush` + `decideNotifications`
// (lib/push/notify.ts). All this module adds is the person: their ScoringOptions,
// memoized per beach per profile so a hundred devices sharing a profile re-score
// a beach once.

import { resolveScoring } from "@/lib/profile/resolve";
import { DEFAULT_SCORING } from "@/lib/score";
import { summarizeForPush, type PushSummary } from "@/lib/push/notify";
import { buildAlert, type AlertDecision } from "@/lib/alerts/catalog";
import type { DeviceRecord } from "@/lib/db/types";
import type { ConditionsResponse, ScoringOptions } from "@/lib/types";

/** The score at which a day is worth interrupting someone for. */
export const EXCELLENT_SCORE = 90;

/** One run's personal summaries, keyed by beach + profile. */
export type SummaryCache = Map<string, PushSummary>;

export function newSummaryCache(): SummaryCache {
  return new Map();
}

/** This device's scoring options, or the free defaults when it has no profile. */
export function scoringFor(device: DeviceRecord): ScoringOptions {
  try {
    return resolveScoring(device.profile);
  } catch {
    return DEFAULT_SCORING;
  }
}

/**
 * The summary this device should be told about — theirs when they have a
 * profile, everyone's when they do not. Memoized per (beach, profile) for the
 * run, since re-scoring a snapshot is pure and identical for identical profiles.
 */
export function personalSummary(
  res: ConditionsResponse,
  loc: { slug: string; name: string; tz: string },
  device: DeviceRecord,
  nowMs: number,
  cache: SummaryCache,
): PushSummary {
  const scoring = scoringFor(device);
  const personal = scoring !== DEFAULT_SCORING;
  const key = `${loc.slug}|${personal ? JSON.stringify(device.profile) : "everyone"}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = summarizeForPush(res, loc, personal ? { scoring, nowMs } : undefined);
    cache.set(key, hit);
  }
  return hit;
}

/** Is the sun up at the home beach right now? */
export function isDaylight(res: ConditionsResponse, nowMs: number): boolean {
  const sun = res.snapshot?.sun?.data;
  const sunrise = sun?.sunrise ? Date.parse(sun.sunrise) : NaN;
  const sunset = sun?.sunset ? Date.parse(sun.sunset) : NaN;
  if (!Number.isFinite(sunrise) || !Number.isFinite(sunset)) return false;
  return nowMs >= sunrise && nowMs <= sunset;
}

export interface ExcellentInput {
  device: DeviceRecord;
  summary: PushSummary;
  res: ConditionsResponse;
  nowMs: number;
  /** The beach's local calendar date, YYYY-MM-DD — the once-a-day dedup key. */
  date: string;
}

/**
 * "Your beach day just turned Excellent." Fires at most once per local day, in
 * daylight, when THIS person's score for their home beach reaches 90. The daily
 * key goes in `alert_log`, so the caller's repeat window does the rest.
 */
export function excellentDecision(input: ExcellentInput): AlertDecision | null {
  if (input.device.prefs["score-excellent"] === false) return null;
  if (input.summary.score < EXCELLENT_SCORE) return null;
  if (!isDaylight(input.res, input.nowMs)) return null;
  return buildAlert(
    { key: "score-excellent", score: input.summary.score, dedupKey: `score-excellent:${input.date}` },
    { beach: input.summary.name },
  );
}
