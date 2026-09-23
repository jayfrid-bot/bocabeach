// The at-beach rules. PURE: everything it needs is handed to it, so every rule
// in here is a table test, not a network call.
//
// What it decides, and from what:
//  - lightning   — the person's OWN fix (summarizeStrikes against their lat/lon)
//  - thunder     — the beach snapshot's storm signals
//  - severe / water advisory / rip / flag — the beach snapshot, each judged on
//    its own (LOC-01): the in-app banner's `activeSafety()` picks ONE headline,
//    and an alert engine must not inherit that blind spot. Wording still comes
//    from the shared catalog, so push and the app never word a hazard two ways.
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
import { isSevereAlert } from "@/lib/push/notify";
import type { AlertKey, AlertPrefs, ScoreProfile } from "@/lib/db/types";
import type { ConditionsResponse, FlagColor, LightningData } from "@/lib/types";
import { buildAlert, type AlertDecision, type AlertSubject } from "@/lib/alerts/catalog";
import type { RainRead } from "@/lib/alerts/rain";
import { assessLightning, type HazardAnchor, type HazardAssessment } from "@/lib/hazards/assess";
import { cellKey } from "@/lib/location/cell";

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
  presence: {
    slug: string;
    lat: number | null;
    lon: number | null;
    /**
     * Where `lat`/`lon` came from — the person's own fresh, accurate, nearby
     * fix, or the beach centroid it fell back to (#6). Pure bookkeeping: the
     * rules below read `lat`/`lon` the same way either way.
     */
    fixSource?: "device" | "beach";
  };
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

/** Where lightning is measured from: the person's own fix, or the beach
 *  centroid when `fixOf` (run.ts) fell back to it (#6). */
function anchorOf(presence: AtBeachInput["presence"]): HazardAnchor {
  const { lat, lon, slug, fixSource } = presence;
  if (fixSource === "beach" || lat == null || lon == null) return { kind: "beach", slug };
  return { kind: "point", lat, lon, cell: cellKey(lat, lon) };
}

/**
 * Lightning, measured from where the person is standing. The geometry (nearest
 * strike vs the fix) still comes from `summarizeStrikes` upstream; the
 * fire/no-fire call is delegated to `assessLightning` (lib/hazards/assess.ts)
 * so the push and the score cap can never disagree about the same strike.
 */
/** The ONE lightning assessment this evaluation makes (Codex review #9) —
 *  `evaluateAtBeach` returns it so `lib/alerts/run.ts` can feed the SAME
 *  object into the Live Activity's content-state projection instead of
 *  calling `assessLightning` a second time for the same fix/anchor/moment. */
function lightningAssessment(strikes: LightningData | null, anchor: HazardAnchor, nowMs: number): HazardAssessment {
  // The age of the MOST RECENT strike within 5 mi — the only signal
  // assessLightning uses to decide active/latched (lib/hazards/assess.ts).
  // nearestMi/nearestMinutesAgo above can point at a DIFFERENT strike (the
  // closest one isn't always the most recent close one), so this must come
  // from the source's own closeStrikeMinutesAgo, never be derived from mi.
  return assessLightning({
    status: strikes ? "ok" : "error",
    nearestMi: strikes?.nearestMi,
    nearestMinutesAgo: strikes?.nearestMinutesAgo,
    closeStrikeMinutesAgo: strikes?.closeStrikeMinutesAgo,
    windowMinutes: strikes?.windowMinutes,
    nowMs,
    anchor,
  });
}

function lightningSubjects(
  assessment: HazardAssessment,
  strikes: LightningData | null,
): AlertSubject[] {
  const mi = strikes?.nearestMi;
  if (!assessment.active || mi == null || !Number.isFinite(mi)) return [];
  const out: AlertSubject[] = [{ key: "lightning", nearestMi: mi, escalated: false }];
  if (mi <= LIGHTNING_ESCALATE_MI) {
    out.unshift({ key: "lightning", nearestMi: mi, escalated: true });
  }
  return out;
}

/**
 * Every hazard the beach snapshot is showing, each as its own subject (LOC-01).
 *
 * This is deliberately NOT `activeSafety()`: that ladder picks ONE headline
 * for the in-app banner, and an alert engine that reads only the headline
 * misses the rest. A Tornado Warning next to a lightning strike, a double-red
 * closure under a high-rip note, a closure the person still wants after
 * turning water-advisory pushes off — each has to be decided on its own, and
 * preferences applied to the SET, not to the winner. Lightning is left out on
 * purpose: the fix-based read in `lightningSubjects` replaces only the
 * centroid lightning rung, nothing else.
 *
 * Wording still comes from the shared catalog, so push and the banner never
 * describe one hazard two ways.
 */
function snapshotHazards(res: ConditionsResponse, nowMs: number): AlertSubject[] {
  const s = res.snapshot;
  const out: AlertSubject[] = [];
  const alerts = s?.nws?.data?.alerts ?? [];

  // Severe warnings: one subject per distinct event, so a Flash Flood Warning
  // and a Tornado Warning both arrive (each has its own dedup key already).
  const seen = new Set<string>();
  let severeIsStorm = false;
  for (const a of alerts) {
    if (!isSevereAlert(a) || seen.has(a.event)) continue;
    seen.add(a.event);
    if (/thunderstorm/i.test(a.event)) severeIsStorm = true;
    out.push({ key: "severe", event: a.event });
  }
  const hazardStatement = alerts.find((a) => /beach hazard/i.test(a.event));
  if (hazardStatement && !seen.has(hazardStatement.event)) {
    out.push({ key: "severe", event: hazardStatement.event });
  }

  // A thunderstorm on the beach's own signals — unless a severe THUNDERSTORM
  // warning already said so, one line louder.
  if (!severeIsStorm && thunderNearby(res, nowMs)) out.push({ key: "thunder" });

  if (s?.cityOfficial?.data?.noSwimAdvisory || s?.waterQuality?.data?.advisory) {
    out.push({ key: "water-advisory" });
  }

  const rip = s?.nws?.data?.ripCurrentRisk;
  if (rip === "high") out.push({ key: "rip", level: "high" });
  else if (rip === "moderate") out.push({ key: "rip", level: "moderate" });

  const flag = postedFlag(res);
  if (flag) out.push({ key: "flag", flag });

  return out;
}

/** Rain arriving, or rain done. Never both. */
function rainSubject(input: AtBeachInput): AlertSubject | null {
  const rain = input.rain;
  if (!rain) return null;
  // A rain-soon ETA is bookkeeping about what's coming — only the literal
  // observation (not a latched hold) should erase it, exactly as rain.ts
  // already keeps `etaMinutes` for a latched-but-currently-dry read.
  if (!rain.rainingNow && rain.etaMinutes != null && rain.etaMinutes <= RAIN_SOON_MIN) {
    return { key: "rain-soon", etaMinutes: rain.etaMinutes };
  }
  // The hazard call — including a latched hold with nothing falling this
  // instant — is what should hold back "clearing": telling someone it's
  // clearing while the assessment still treats it as active would contradict
  // the same hazard the score cap and other pushes are honoring right now.
  const hazardActive = rain.hazardActive ?? rain.rainingNow;
  if (hazardActive || !rain.clearingSoon) return null;
  // "Clearing" only means something to someone who was told it was coming, or
  // who got rained on. Otherwise it is a notification about nothing.
  const { soonAt = null, wetAt = null } = input.recentRain ?? {};
  const recent = [soonAt, wetAt].some(
    (t) => t != null && input.now - t <= RAIN_MEMORY_MS && input.now >= t,
  );
  return recent ? { key: "rain-clearing" } : null;
}

/** `evaluateAtBeach`'s result: the alert decisions, plus the one lightning
 *  assessment it computed (Codex review #9) — the caller (lib/alerts/run.ts)
 *  feeds `lightning` straight into the Live Activity's content-state
 *  projection instead of re-deriving it. */
export interface EvaluateAtBeachResult {
  decisions: AlertDecision[];
  lightning: HazardAssessment;
}

/**
 * Decide every alert an armed device is due, most urgent first. Preferences are
 * applied here, so a decision that comes out of this function is one the person
 * asked for; the caller only has to handle the repeat window.
 */
export function evaluateAtBeach(input: AtBeachInput): EvaluateAtBeachResult {
  const subjects: AlertSubject[] = [];
  const lightning = lightningAssessment(input.strikes, anchorOf(input.presence), input.now);
  subjects.push(...lightningSubjects(lightning, input.strikes));

  if (input.conditions) {
    subjects.push(...snapshotHazards(input.conditions, input.now));

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
    out.push(
      buildAlert(subject, { beach: input.beachName, slug: input.presence.slug, informational: soft }),
    );
  }
  // Tie-break on the bare key (the beach scope is the same for every decision
  // in one call) so the plain lightning notice still sorts before its
  // escalation, exactly as it did before keys were scoped.
  const bare = (k: string): string => k.replace(/@[^@]*$/, "");
  const decisions = out.sort(
    (a, b) => a.priority - b.priority || bare(a.dedupKey).localeCompare(bare(b.dedupKey)),
  );
  return { decisions, lightning };
}
