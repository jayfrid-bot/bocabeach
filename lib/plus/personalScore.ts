// Re-score the day for one person, on their phone.
//
// The server already sends the whole snapshot and every hourly bucket, so the
// personal score is not a second fetch — it is the SAME engine run again with
// different weights. This file mirrors, step for step, what the server does in
// `getConditionsForLocation` (lib/conditions.ts): score the headline, score the
// hourly curve, anchor the current hour to the headline, then make sure today's
// advertised peak never reads below that anchored now-point. Any drift between
// the two would show up as a chart whose "now" dot disagrees with the big
// number, which is exactly the bug the server-side anchor exists to prevent.
//
// Pure. `nowMs` is always passed in — the engine's hidden `Date.now()` is a
// hydration trap.

import {
  anchorCurrentHourScore,
  computeHourlyScores,
  computeMultiDayWindows,
  computeScore,
} from "@/lib/score";
import type {
  ConditionsResponse,
  DayWindow,
  HourlyScore,
  ScoreResult,
  ScoringOptions,
} from "@/lib/types";

const HOUR_MS = 3_600_000;

export interface PersonalScore {
  /** The headline number, capped by this profile's cap policy. */
  score: ScoreResult;
  /** Today's daylight curve with the current hour anchored to `score`. */
  hourlyScores: HourlyScore[];
  /** The same curve WITHOUT the anchor — for window analysis. */
  hourlyForecast: HourlyScore[];
  /** Best window + peak per upcoming day, today first. */
  multiDayWindows: DayWindow[];
}

/** The hourly bucket that contains `nowMs`, or undefined. */
function nowBucket(hourly: HourlyScore[], nowMs: number): HourlyScore | undefined {
  return hourly.find((h) => {
    const t = new Date(h.time).getTime();
    return t <= nowMs && nowMs < t + HOUR_MS;
  });
}

/**
 * Score `res.snapshot` with `opts`. Returns exactly the four fields the server
 * computes, so a component can swap between `res` and this without caring which
 * one it holds.
 */
export function computePersonalScore(
  res: ConditionsResponse,
  opts: ScoringOptions,
  nowMs: number,
): PersonalScore {
  const snapshot = res.snapshot;
  const score = computeScore(snapshot, opts);
  const hourlyForecast = computeHourlyScores(snapshot, nowMs, opts);
  const hourlyScores = anchorCurrentHourScore(hourlyForecast, score, nowMs, opts);
  const multiDayWindows = computeMultiDayWindows(snapshot, nowMs, 7, opts);

  // Keep the "Today" peak badge >= the chart's anchored now-dot: the live
  // headline IS part of today, so the day's advertised peak must never read
  // below the now-point (they come off different curves). Same reconciliation
  // the server does — see lib/conditions.ts.
  const today = multiDayWindows[0];
  const nowDot = nowBucket(hourlyScores, nowMs);
  if (today && today.dow === "Today" && nowDot && today.peakScore != null && today.peakScore < nowDot.score) {
    multiDayWindows[0] = { ...today, peakScore: nowDot.score };
  }

  return { score, hourlyScores, hourlyForecast, multiDayWindows };
}
