// The alert catalog: every alert the engine can send, what it says, how urgent
// it is, and how soon it may repeat. Pure — no I/O, no store, no clock.
//
// Two tiers:
//  - "at-beach": only while the device is armed (it is standing on the sand).
//    Distances and rain come from the person's own fix, not the beach centroid.
//  - "home": the daily notifications about their home beach.
//
// The wording is the source of truth for what a person reads. Keep it plain,
// keep it short, and lead with the action ("get out of the water", "take cover").

import type { AlertKey } from "@/lib/db/types";

/** Which run sends this alert. */
export type AlertTier = "at-beach" | "home";

/** How long a dedup key stays quiet after it fires. */
export const DEFAULT_REPEAT_MS = 30 * 60 * 1000;

export interface AlertSpec {
  key: AlertKey;
  tier: AlertTier;
  /** Lower fires first. Mirrors the hazard ladder in `activeSafety()`. */
  priority: number;
  repeatMs: number;
  /** An alarm gets the ⚠️ title; everything else reads as news. */
  alarm: boolean;
}

/**
 * Priority order, most urgent first: lightning, severe weather, thunderstorm,
 * water advisory, rip, flag, then the non-hazards. The first five follow the
 * ladder `activeSafety()` already uses, so push and the in-app safety banner
 * can never disagree about which hazard leads.
 */
export const CATALOG: Record<AlertKey, AlertSpec> = {
  lightning: { key: "lightning", tier: "at-beach", priority: 0, repeatMs: DEFAULT_REPEAT_MS, alarm: true },
  severe: { key: "severe", tier: "at-beach", priority: 2, repeatMs: DEFAULT_REPEAT_MS, alarm: true },
  thunder: { key: "thunder", tier: "at-beach", priority: 3, repeatMs: DEFAULT_REPEAT_MS, alarm: true },
  "water-advisory": { key: "water-advisory", tier: "at-beach", priority: 4, repeatMs: DEFAULT_REPEAT_MS, alarm: true },
  rip: { key: "rip", tier: "at-beach", priority: 5, repeatMs: DEFAULT_REPEAT_MS, alarm: true },
  flag: { key: "flag", tier: "at-beach", priority: 6, repeatMs: DEFAULT_REPEAT_MS, alarm: true },
  "wind-gust": { key: "wind-gust", tier: "at-beach", priority: 7, repeatMs: DEFAULT_REPEAT_MS, alarm: false },
  "rain-soon": { key: "rain-soon", tier: "at-beach", priority: 8, repeatMs: DEFAULT_REPEAT_MS, alarm: false },
  "rain-clearing": { key: "rain-clearing", tier: "at-beach", priority: 9, repeatMs: DEFAULT_REPEAT_MS, alarm: false },
  "score-excellent": { key: "score-excellent", tier: "home", priority: 10, repeatMs: DEFAULT_REPEAT_MS, alarm: false },
  morning: { key: "morning", tier: "home", priority: 11, repeatMs: DEFAULT_REPEAT_MS, alarm: false },
};

/** The alerts an armed device can receive, most urgent first. */
export const AT_BEACH_KEYS: readonly AlertKey[] = (Object.values(CATALOG) as AlertSpec[])
  .filter((s) => s.tier === "at-beach")
  .sort((a, b) => a.priority - b.priority)
  .map((s) => s.key);

/** One decided alert, ready to become a push. */
export interface AlertDecision {
  /** The catalog + preference key. */
  alertKey: AlertKey;
  /**
   * The `alert_log` key. Finer than `alertKey` where a change of degree must
   * beat the repeat window — `lightning:2mi`, `flag:double-red`, `rip:moderate`,
   * `severe:<event>` — so an escalation is never swallowed by its own base key.
   */
  dedupKey: string;
  priority: number;
  repeatMs: number;
  title: string;
  body: string;
  /** Push tag — drives the APNs store-and-forward window. */
  tag: string;
  /** Dedup keys this decision replaces when both fire in the same run. */
  supersedes?: string[];
  meta?: Record<string, unknown>;
}

/** What the engine found. One variant per line of copy. */
export type AlertSubject =
  | { key: "lightning"; nearestMi: number | null; escalated: boolean }
  | { key: "thunder" }
  | { key: "severe"; event: string }
  | { key: "rain-soon"; etaMinutes: number }
  | { key: "rain-clearing" }
  | { key: "wind-gust"; gustMph: number }
  | { key: "flag"; flag: "red" | "double-red" }
  | { key: "rip"; level: "high" | "moderate" }
  | { key: "water-advisory" }
  | { key: "score-excellent"; score: number; dedupKey: string };

export interface AlertContext {
  /** The beach the person is at (or whose day just turned Excellent). */
  beach: string;
  /**
   * Report the hazard, don't sound the alarm. Set for the flag + rip alerts on
   * a surfing profile: a red flag is what they came for, so it is news about the
   * conditions, not a warning to get out (see the surf cap policy).
   */
  informational?: boolean;
}

/** "3.2" — one decimal, the way a person reads a distance. */
function miles(mi: number): string {
  return (Math.round(mi * 10) / 10).toFixed(1);
}

/** The body copy for one finding. */
function bodyFor(subject: AlertSubject, ctx: AlertContext): string {
  const beach = ctx.beach;
  switch (subject.key) {
    case "lightning":
      if (subject.escalated) return "⚡ Lightning within 2 miles — take cover now.";
      return subject.nearestMi != null
        ? `⚡ Lightning ${miles(subject.nearestMi)} mi away — get out of the water and take cover.`
        : "⚡ Lightning within 5 miles — get out of the water and take cover.";
    case "thunder":
      return `⛈️ Thunderstorm approaching ${beach}.`;
    case "severe":
      return `${subject.event} in effect at ${beach}.`;
    case "rain-soon":
      return `🌧️ Rain in about ${Math.max(1, Math.round(subject.etaMinutes))} minutes where you are.`;
    case "rain-clearing":
      return "☀️ Rain clearing — the beach should dry out soon.";
    case "wind-gust":
      return `💨 Gusts over 25 mph at ${beach}.`;
    case "flag":
      if (subject.flag === "double-red") {
        return `🚩 Double red flag at ${beach} — beach closed to swimming.`;
      }
      return ctx.informational
        ? `🚩 Conditions changed: red flag flying at ${beach}.`
        : `🚩 Red flag flying at ${beach} — dangerous surf, stay out.`;
    case "rip": {
      const level = subject.level === "high" ? "High" : "Moderate";
      return ctx.informational
        ? `Conditions changed: ${level.toLowerCase()} rip-current risk at ${beach}.`
        : `${level} rip-current risk at ${beach} — swim near a lifeguard.`;
    }
    case "water-advisory":
      return `Water-quality advisory at ${beach} — swimming not recommended.`;
    case "score-excellent":
      return `🏖️ Your beach day just turned Excellent at ${beach} — ${subject.score}/100.`;
  }
}

/** The `alert_log` key for one finding. */
function dedupKeyFor(subject: AlertSubject): string {
  switch (subject.key) {
    case "lightning":
      return subject.escalated ? "lightning:2mi" : "lightning";
    case "severe":
      return `severe:${subject.event}`;
    case "flag":
      return `flag:${subject.flag}`;
    case "rip":
      return subject.level === "high" ? "rip" : "rip:moderate";
    case "score-excellent":
      return subject.dedupKey;
    default:
      return subject.key;
  }
}

/** Extra facts worth keeping in `alert_log.meta_json` for later debugging. */
function metaFor(subject: AlertSubject): Record<string, unknown> | undefined {
  switch (subject.key) {
    case "lightning":
      return { nearestMi: subject.nearestMi, escalated: subject.escalated };
    case "rain-soon":
      return { etaMinutes: subject.etaMinutes };
    case "wind-gust":
      return { gustMph: subject.gustMph };
    case "severe":
      return { event: subject.event };
    case "flag":
      return { flag: subject.flag };
    case "rip":
      return { level: subject.level };
    case "score-excellent":
      return { score: subject.score };
    default:
      return undefined;
  }
}

/** Turn one finding into a ready-to-send decision. */
export function buildAlert(subject: AlertSubject, ctx: AlertContext): AlertDecision {
  const spec = CATALOG[subject.key];
  const alarm = spec.alarm && !ctx.informational;
  return {
    alertKey: subject.key,
    dedupKey: dedupKeyFor(subject),
    priority: spec.priority,
    repeatMs: spec.repeatMs,
    title: alarm ? `⚠️ ${ctx.beach}` : ctx.beach,
    tag: spec.tier === "home" ? "excellent" : "safety",
    body: bodyFor(subject, ctx),
    // A lightning escalation replaces the plain lightning alert in the same run,
    // so a storm arriving already inside 2 mi sends ONE push, not two.
    ...(subject.key === "lightning" && subject.escalated ? { supersedes: ["lightning"] } : {}),
    meta: metaFor(subject),
  };
}
