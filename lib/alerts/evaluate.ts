// The at-beach rules. PURE: everything it needs is handed to it, so every rule
// in here is a table test, not a network call.
//
// What it decides, and from what:
//  - lightning   — the person's OWN fix (summarizeStrikes against their lat/lon)
//  - thunder     — the beach snapshot's storm signals
//  - severe / water advisory / rip / flag — `activeSafety()`, the same ladder the
//    in-app safety banner uses, so push and the app can never word a hazard two
//    different ways or disagree about which one leads
//  - wind gust   — the beach's buoy gust
//  - rain        — the person's own cell (radar pixel or 15-minute forecast)
//
// Profile filter: a red flag and a high rip are what a surfer came for, so they
// arrive as news ("Conditions changed: …"), not as an alarm. That mirrors the
// surf cap policy, where those two do not cap a surfer's score either. Every
// other hazard reaches everybody the same way — safety information is never
// personal.

import { currentHourOf } from "@/lib/score";
import { resolveScoring } from "@/lib/profile/resolve";
import { activeSafety } from "@/lib/push/notify";
import type { AlertKey, AlertPrefs, ScoreProfile } from "@/lib/db/types";
import type { ConditionsResponse, FlagColor, LightningData } from "@/lib/types";
import { buildAlert, type AlertDecision, type AlertSubject } from "@/lib/alerts/catalog";
import type { RainRead } from "@/lib/alerts/rain";

/** Lightning this close counts as "at the beach". */
export const LIGHTNING_ALERT_MI = 5;
/** …and this close is the escalation. */
export const LIGHTNING_ESCALATE_MI = 2;
/** A strike older than this is history, not a warning. */
export const LIGHTNING_FRESH_MIN = 30;
/** Gusts above this get a heads-up (umbrellas, tents, small kids). */
export const GUST_ALERT_MPH = 25;
/** Rain arriving inside this window is worth interrupting someone for. */
export const RAIN_SOON_MIN = 30;
/** How long a rain alert is remembered when deciding "it is clearing". */
export const RAIN_MEMORY_MS = 3 * 60 * 60 * 1000;

export interface AtBeachInput {
  now: number;
  device: { prefs: AlertPrefs; profile: ScoreProfile | null };
  presence: { slug: string; lat: number | null; lon: number | null };
  /** The beach's display name — every line of copy names it. */
  beachName: string;
  /** `summarizeStrikes(feed, fixLat, fixLon, now)`, or null with no feed. */
  strikes: LightningData | null;
  rain: RainRead | null;
  conditions: ConditionsResponse | null;
  /**
   * When this device last heard about rain: `soonAt` from a rain-soon alert,
   * `wetAt` from a run that found it raining on them. Either one is what makes
   * "rain clearing" mean something instead of arriving out of nowhere.
   */
  recentRain?: { soonAt: number | null; wetAt: number | null };
}

/** Does this person's profile read a red flag as an invitation? */
function surfs(profile: ScoreProfile | null): boolean {
  try {
    return resolveScoring(profile).capPolicy === "surf";
  } catch {
    return false;
  }
}

/** A thunderstorm on the beach's own signals — the rung `activeSafety()` lacks. */
function thunderNearby(res: ConditionsResponse, nowMs: number): boolean {
  const s = res.snapshot;
  const alerts = s?.nws?.data?.alerts ?? [];
  if (alerts.some((a) => /thunderstorm/i.test(a.event))) return true;
  const hour = currentHourOf(s?.hourly?.data ?? [], nowMs);
  const code = hour?.weatherCode;
  // Same corroboration rule the score uses (lib/score.ts rainSeverity): a lone
  // code 95 under a 2% chance of rain is a model artifact, not a storm.
  if (code != null && code >= 95 && code <= 99) {
    const prob = hour?.precipProbability;
    if (prob == null || prob >= 25) return true;
  }
  return /thunder/i.test(s?.weather?.data?.shortForecast ?? "");
}

/** The strongest posted flag, when one is flying. */
function postedFlag(res: ConditionsResponse): "red" | "double-red" | null {
  const flags: FlagColor[] = res.snapshot?.cityOfficial?.data?.flags ?? [];
  if (flags.includes("double-red")) return "double-red";
  if (flags.includes("red")) return "red";
  return null;
}

/** Lightning, measured from where the person is standing. */
function lightningSubjects(strikes: LightningData | null): AlertSubject[] {
  const mi = strikes?.nearestMi;
  const ago = strikes?.nearestMinutesAgo;
  if (mi == null || !Number.isFinite(mi) || mi > LIGHTNING_ALERT_MI) return [];
  if (ago != null && ago > LIGHTNING_FRESH_MIN) return [];
  const out: AlertSubject[] = [{ key: "lightning", nearestMi: mi, escalated: false }];
  if (mi <= LIGHTNING_ESCALATE_MI) {
    out.unshift({ key: "lightning", nearestMi: mi, escalated: true });
  }
  return out;
}

/**
 * The one hazard the beach snapshot is showing, translated into a catalog key.
 * Lightning is dropped here: the fix-based read above is strictly better than
 * the beach-centroid one this ladder carries.
 */
function snapshotHazard(res: ConditionsResponse, nowMs: number): AlertSubject | null {
  const safety = activeSafety(res);
  const key = safety?.key ?? "";
  if (key.startsWith("lightning")) return null;
  if (key.startsWith("severe:")) return { key: "severe", event: key.slice("severe:".length) };
  if (key === "hazard") {
    const event =
      res.snapshot?.nws?.data?.alerts?.find((a) => /beach hazard/i.test(a.event))?.event ??
      "Beach Hazards Statement";
    return { key: "severe", event };
  }
  if (key === "water") return { key: "water-advisory" };
  if (key === "rip") return { key: "rip", level: "high" };
  if (key === "rip-moderate") return { key: "rip", level: "moderate" };
  if (key.startsWith("flag:")) {
    const flag = postedFlag(res) ?? "red";
    return { key: "flag", flag };
  }
  // No ladder hazard, but a storm may still be rolling in.
  return thunderNearby(res, nowMs) ? { key: "thunder" } : null;
}

/** Rain arriving, or rain done. Never both. */
function rainSubject(input: AtBeachInput): AlertSubject | null {
  const rain = input.rain;
  if (!rain) return null;
  if (!rain.rainingNow && rain.etaMinutes != null && rain.etaMinutes <= RAIN_SOON_MIN) {
    return { key: "rain-soon", etaMinutes: rain.etaMinutes };
  }
  if (rain.rainingNow || !rain.clearingSoon) return null;
  // "Clearing" only means something to someone who was told it was coming, or
  // who got rained on. Otherwise it is a notification about nothing.
  const { soonAt = null, wetAt = null } = input.recentRain ?? {};
  const recent = [soonAt, wetAt].some(
    (t) => t != null && input.now - t <= RAIN_MEMORY_MS && input.now >= t,
  );
  return recent ? { key: "rain-clearing" } : null;
}

/**
 * Decide every alert an armed device is due, most urgent first. Preferences are
 * applied here, so a decision that comes out of this function is one the person
 * asked for; the caller only has to handle the repeat window.
 */
export function evaluateAtBeach(input: AtBeachInput): AlertDecision[] {
  const subjects: AlertSubject[] = [];
  subjects.push(...lightningSubjects(input.strikes));

  if (input.conditions) {
    const hazard = snapshotHazard(input.conditions, input.now);
    if (hazard) subjects.push(hazard);

    // A severe THUNDERSTORM warning already said "thunderstorm" — do not say it
    // twice, one line quieter.
    const severeIsStorm =
      hazard?.key === "severe" && /thunderstorm/i.test(hazard.event);
    if (hazard && hazard.key !== "thunder" && !severeIsStorm && thunderNearby(input.conditions, input.now)) {
      subjects.push({ key: "thunder" });
    }

    const gust = input.conditions.snapshot?.buoy?.data?.windGustMph;
    if (gust != null && gust > GUST_ALERT_MPH) {
      subjects.push({ key: "wind-gust", gustMph: gust });
    }
  }

  const rain = rainSubject(input);
  if (rain) subjects.push(rain);

  const informationalKeys: AlertKey[] = surfs(input.device.profile) ? ["flag", "rip"] : [];
  const out: AlertDecision[] = [];
  for (const subject of subjects) {
    if (input.device.prefs[subject.key] === false) continue;
    // Double red closes the beach for everyone, surfers included — that one
    // stays an alarm whatever the profile says.
    const soft =
      informationalKeys.includes(subject.key) &&
      !(subject.key === "flag" && subject.flag === "double-red");
    out.push(buildAlert(subject, { beach: input.beachName, informational: soft }));
  }
  return out.sort((a, b) => a.priority - b.priority || a.dedupKey.localeCompare(b.dedupKey));
}
