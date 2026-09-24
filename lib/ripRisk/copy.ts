// Front-of-card / safety-banner rip current copy — plain, non-contradicting,
// eighth-grade wording. Pure function: no percentages, no model names, no
// "disagrees", no source jargon. All the raw detail (probabilities, model
// run time, thresholds, the SRF word) stays on the flip-back / nerd info,
// never here. See lib/ripRisk/resolve.ts for how `ripNow` itself is decided
// — this module only turns that decision into words a swimmer can read fast.

import { fmtTime } from "@/lib/format";
import { levelForModelProb } from "@/lib/ripRisk/resolve";
import type { RipNow } from "@/lib/ripRisk/types";
import type { RipModelHourInput } from "@/lib/ripRisk/timeline";

export type RipCopyLevel = "Low" | "Moderate" | "High";

export interface RipCopy {
  headline: RipCopyLevel;
  line1: string;
  line2?: string;
  bannerText: string;
}

type Band = "low" | "moderate" | "high";
const LEVEL_LABEL: Record<Band, RipCopyLevel> = { low: "Low", moderate: "Moderate", high: "High" };
const RANK: Record<Band, number> = { low: 0, moderate: 1, high: 2 };

/** "12 PM Fri" (or just "12 PM" for a time later today) — beach-local. */
function fmtClock(iso: string, nowMs: number, tz: string): string {
  const time = fmtTime(iso, tz).replace(/:00(?=\s)/, "");
  const dayKey = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(ms));
  if (dayKey(Date.parse(iso)) === dayKey(nowMs)) return time;
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz }).format(new Date(iso));
  return `${time} ${weekday}`;
}

/**
 * `ripNow` -> the card headline + up to two short sentences + the banner's
 * one-line summary. Picks the first state that applies:
 *   1. A rip current warning actually in effect right now.
 *   2. The resolved level reading higher than the model's OWN raw reading
 *      (the forecast-floor case — the model says calmer, but the day's
 *      official forecast word won't let the reading drop that far).
 *   3. Otherwise, the shape of the hourly model series: rising, easing, or
 *      steady, read forward from `nowMs`.
 * `timeline` is optional — a beach with only the SRF word (no NOAA model
 * coverage) still gets a plain "steady" line, never a crash.
 */
export function ripCopy(
  ripNow: RipNow | undefined,
  timeline: RipModelHourInput[] | null | undefined,
  nowMs: number,
  tz: string,
): RipCopy {
  const level: Band = ripNow && ripNow.level !== "unknown" ? (ripNow.level as Band) : "low";
  const headline = LEVEL_LABEL[level];

  if (ripNow?.source === "alert" && ripNow.alert) {
    const until = fmtClock(ripNow.alert.end, nowMs, tz);
    return {
      headline,
      line1: `Rip current warning in effect until ${until}.`,
      line2: "Swim near a lifeguard, or stay out.",
      bannerText: `Rip current warning in effect until ${until}`,
    };
  }

  const line2 = ripNow?.upcomingAlert
    ? `Rip current warning starts ${fmtClock(ripNow.upcomingAlert.onset, nowMs, tz)}.`
    : undefined;
  const bannerSuffix = ripNow?.upcomingAlert
    ? ` · Warning starts ${fmtClock(ripNow.upcomingAlert.onset, nowMs, tz)}`
    : "";
  const bannerText = `Rip current risk: ${headline}${bannerSuffix}`;

  // Forecast floor: the model's own raw reading is calmer than the level
  // actually shown — the official day-word is keeping the reading up.
  if (ripNow?.model && RANK[level] > RANK[levelForModelProb(ripNow.model.prob)]) {
    return {
      headline,
      line1: "The water is calmer now, but rough surf is on the way.",
      line2,
      bannerText,
    };
  }

  const hours = (timeline ?? []).filter((h) => Number.isFinite(Date.parse(h.t)));
  let line1 = `Should stay ${headline} through tonight.`;
  if (hours.length >= 2) {
    let nowIdx = 0;
    for (let i = 0; i < hours.length; i++) {
      if (Date.parse(hours[i].t) <= nowMs) nowIdx = i;
      else break;
    }
    let peakIdx = -1;
    let peakLevel: Band = level;
    let troughIdx = -1;
    let troughLevel: Band = level;
    for (let i = nowIdx + 1; i < hours.length; i++) {
      const lvl = levelForModelProb(hours[i].prob);
      if (RANK[lvl] > RANK[peakLevel]) {
        peakLevel = lvl;
        peakIdx = i;
      }
      if (RANK[lvl] < RANK[troughLevel]) {
        troughLevel = lvl;
        troughIdx = i;
      }
    }
    if (peakIdx >= 0 && RANK[peakLevel] > RANK[level]) {
      line1 = `Rises to ${LEVEL_LABEL[peakLevel]} by ${fmtClock(hours[peakIdx].t, nowMs, tz)}.`;
    } else if (troughIdx >= 0 && RANK[troughLevel] < RANK[level]) {
      line1 = `Easing to ${LEVEL_LABEL[troughLevel]} by ${fmtClock(hours[troughIdx].t, nowMs, tz)}.`;
    }
  }

  return { headline, line1, line2, bannerText };
}
