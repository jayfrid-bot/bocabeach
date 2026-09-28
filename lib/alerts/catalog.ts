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
import type { SkyAlertEventType, SkyRatingLabel } from "@/lib/skyEventsTypes";

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
  // "home" here means the same thing it means for score-excellent/morning:
  // "not gated to being physically at the beach" — NOT "part of the morning
  // digest". Whether a coming-up event is appended to the digest or sent
  // standalone is the push route's own §10 decision (app/api/push/run/
  // route.ts), made once per beach-local 8:00 AM run; this spec only says
  // "at most one of these a day, not at-beach". repeatMs is unused for this
  // key in practice — the real once-per-event cadence is enforced by the
  // durable coming_up_deliveries ledger (lib/db/comingUpClaims.ts), not this
  // catalog's repeat window — but it's set to the default anyway so this
  // entry is never a surprising exception in code that reads CATALOG
  // generically (e.g. AT_BEACH_KEYS' filter).
  "coming-up": { key: "coming-up", tier: "home", priority: 12, repeatMs: DEFAULT_REPEAT_MS, alarm: false },
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
   * On the at-beach tier it is also scoped to the monitored beach
   * (`flag:double-red@boca-raton`, see `scopeKey`, LOC-08).
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

/**
 * The one "coming-up" subject (SKY_EVENTS_PLAN.md §10) — a single closed
 * union keyed on `eventType`, not five separate `AlertSubject` variants, per
 * the plan's "ONE AlertSubject variant, five copy/dedupe branches" rule.
 * Every field the copy needs is precomputed by the caller (the push route,
 * which knows the beach's own IANA timezone) — this module stays
 * formatting-free, exactly like every other subject above; it only
 * interpolates already-worded strings.
 */
export type ComingUpSubject =
  | {
      key: "coming-up";
      eventType: "eclipse";
      /** `eclipse:<peak-iso>` (§10). */
      eventKey: string;
      kindLabel: "Total" | "Partial";
      /** "Sun Mar 8" — beach-local weekday + date. */
      whenLabel: string;
      /** Set only when the eclipse's own peak instant falls inside the
       *  visible interval — picks the "peak 1:58 AM" copy form (§4, §12). */
      peakTimeLabel?: string;
      /** Set only when `peakTimeLabel` is not — the visible interval's own
       *  start-end range, e.g. "1:10-1:42 AM" (§4, §12). */
      visibleRangeLabel?: string;
      ratingLabel?: SkyRatingLabel;
    }
  | {
      key: "coming-up";
      eventType: "tide";
      /** `tide:<station>:<episode-start>` (§10). */
      eventKey: string;
      /** "Thu Oct 15, 11:42 AM" — the episode's first qualifying high. */
      whenLabel: string;
    }
  | {
      key: "coming-up";
      eventType: "meteor";
      /** `meteor:<shower>:<year>` (§10). */
      eventKey: string;
      showerName: string;
      /** "Wed Aug 12" — the shower's peak, beach-local. */
      whenLabel: string;
      ratingLabel?: SkyRatingLabel;
    }
  | {
      key: "coming-up";
      eventType: "supermoon";
      /** `supermoon:<full-moon-iso>` (§10). */
      eventKey: string;
      /** "Fri Oct 3" — the full-moon date, beach-local. */
      whenLabel: string;
      /** Present only at a curated beach with a reviewed shore normal —
       *  e.g. "rises over the water at 7:12 PM" (§4, §12). */
      overWaterLine?: string;
      /** True only for the year's #1-ranked supermoon (§4) — picks the
       *  "the closest full moon of the year" copy clause. */
      isClosestOfYear: boolean;
    }
  | {
      key: "coming-up";
      eventType: "launch";
      /** `launch:<ll2-uuid>` (§10). */
      eventKey: string;
      name: string;
      /** "9:15 PM Wed Oct 8" — the launch's own `net`, beach-local. */
      whenLabel: string;
    };

/** What the engine found. One variant per line of copy. */
export type AlertSubject =
  | { key: "lightning"; nearestMi: number | null; escalated: boolean }
  | { key: "thunder" }
  | { key: "severe"; event: string }
  | { key: "rain-soon"; etaMinutes: number }
  | { key: "rain-clearing" }
  | { key: "wind-gust"; gustMph: number }
  | { key: "flag"; flag: "red" | "double-red" }
  | { key: "rip"; level: "high" | "moderate"; alertId?: string }
  | { key: "water-advisory" }
  | { key: "score-excellent"; score: number; dedupKey: string }
  | ComingUpSubject;

/** Every `ComingUpSubject["eventType"]` value is one of `SkyAlertEventType`
 *  (lib/skyEventsTypes.ts's canonical list) — this assignment only
 *  type-checks when the two stay in sync, so a future edit to either union
 *  that drifts from the other fails `tsc`, not just a runtime test. */
export const COMING_UP_EVENT_TYPES_MATCH_SKY_EVENTS: SkyAlertEventType[] = [] as ComingUpSubject["eventType"][];

export interface AlertContext {
  /** The beach the person is at (or whose day just turned Excellent). */
  beach: string;
  /**
   * The beach's slug — folded into the at-beach collapse id (`safety:<hazard>:<slug>`)
   * so the SAME hazard at two different beaches never shares a collapse window.
   * Not needed for the home tier (morning / score-excellent keep their own stable
   * tags), so it is optional.
   */
  slug?: string;
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
    case "coming-up":
      return comingUpBody(subject);
  }
}

/** The five §10/§12 copy branches for the one "coming-up" subject, switched
 *  on `eventType`. Every date/time clause is already beach-local, formatted
 *  by the caller (the push route) — this function only assembles sentences,
 *  never math or `Intl` calls, matching the rest of this module. */
function comingUpBody(subject: ComingUpSubject): string {
  switch (subject.eventType) {
    case "tide":
      return (
        `High-tide flooding possible ${subject.whenLabel}. The predicted astronomical tide reaches this ` +
        `station's minor flood level. Wind and weather can change the actual water level.`
      );
    case "eclipse": {
      const kind = `${subject.kindLabel} lunar eclipse`;
      const headline = subject.peakTimeLabel
        ? `${kind} ${subject.whenLabel}, peak ${subject.peakTimeLabel}, visible here.`
        : `${kind} ${subject.whenLabel} — visible here from ${subject.visibleRangeLabel}.`;
      return subject.ratingLabel ? `${headline} Sky rating: ${subject.ratingLabel}.` : headline;
    }
    case "meteor": {
      const headline = `${subject.showerName} peak ${subject.whenLabel}, best after midnight.`;
      return subject.ratingLabel ? `${headline} Sky rating: ${subject.ratingLabel}.` : headline;
    }
    case "supermoon": {
      const headline = subject.overWaterLine
        ? `Supermoon ${subject.whenLabel}, ${subject.overWaterLine}`
        : `Supermoon ${subject.whenLabel}`;
      return subject.isClosestOfYear ? `${headline} — the closest full moon of the year.` : `${headline}.`;
    }
    case "launch":
      return `${subject.name} is targeting a ${subject.whenLabel} launch. Status: Go.`;
  }
}

/**
 * Scope an at-beach `alert_log` key to the monitored beach (LOC-08). The
 * repeat window is a statement about ONE beach: a double-red at Boca must not
 * silence the same closure at Deerfield five minutes later just because the
 * phone moved. Rain memory (`rain-soon` / `rain-wet`, written by
 * lib/alerts/run.ts) uses the same scoping so a wet spell at A can never
 * qualify a "clearing" message at a dry B. No slug → the bare key (the home
 * tier keeps its own stable keys).
 */
export function scopeKey(key: string, slug: string | undefined): string {
  return slug ? `${key}@${slug}` : key;
}

/** The bare (unscoped) `alert_log` key for one finding. */
function baseDedupKeyFor(subject: AlertSubject): string {
  switch (subject.key) {
    case "lightning":
      return subject.escalated ? "lightning:2mi" : "lightning";
    case "severe":
      return `severe:${subject.event}`;
    case "flag":
      return `flag:${subject.flag}`;
    case "rip":
      // Dedup by the CAP alert id when we have one (a real NWS alert actually
      // in effect — see lib/alerts/evaluate.ts's snapshotHazards) so an
      // UPDATED alert (new id-scoped interval, same underlying hazard) still
      // gets its own fresh push, while the SAME alert id never repeats within
      // the window. Falls back to the level-only key for the rare caller that
      // doesn't have an id (kept for back-compat).
      return subject.alertId ? `rip:${subject.alertId}` : subject.level === "high" ? "rip" : "rip:moderate";
    case "score-excellent":
      return subject.dedupKey;
    case "coming-up":
      // One of the five §10 dedupe keys (tide:<station>:<episode-start>,
      // eclipse:<peak-iso>, meteor:<shower>:<year>, supermoon:<full-moon-
      // iso>, launch:<ll2-uuid>) — the SAME string
      // lib/db/store.ts's completeComingUp writes to alert_log, so the
      // durable once-ever dedupe and this decision's own dedupKey can never
      // disagree about which event they mean.
      return subject.eventKey;
    default:
      return subject.key;
  }
}

/** The `alert_log` key for one finding — beach-scoped on the at-beach tier. */
function dedupKeyFor(subject: AlertSubject, ctx: AlertContext): string {
  const base = baseDedupKeyFor(subject);
  return CATALOG[subject.key].tier === "at-beach" ? scopeKey(base, ctx.slug) : base;
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
      return { level: subject.level, alertId: subject.alertId };
    case "score-excellent":
      return { score: subject.score };
    case "coming-up":
      return { eventType: subject.eventType, eventKey: subject.eventKey };
    default:
      return undefined;
  }
}

/**
 * The APNs `apns-collapse-id` / FCM-equivalent collapse key. Each hazard gets
 * its own id, scoped to the beach: `safety:<hazardKey>:<slug>`. That way a
 * rain update never replaces a lightning warning (different hazardKey), a
 * repeat update of the SAME hazard at the SAME beach still replaces its
 * predecessor (same id — the point of collapsing at all), and the same
 * hazard at two different beaches never shares a window. Lightning's
 * escalation shares "lightning" as its hazardKey (see dedupKeyFor, which
 * gives it a finer DEDUP key) so the 2-mile notice collapses the plain one.
 * Morning and Excellent keep their own stable ids — see #8. Coming-up gets
 * its own stable "coming-up" id too — it must NEVER share Excellent's,
 * since a standalone coming-up push and a same-day "turned Excellent" push
 * are two unrelated pieces of news; sharing a collapse id would mean
 * whichever APNs delivers last silently displaces the other in the tray.
 * (Score-excellent and coming-up are the only two subjects that reach this
 * function via the "home" tier: the morning digest itself is built by
 * `decideNotifications` in lib/push/notify.ts, not the catalog, and
 * hardcodes its own "morning" tag there — a coming-up line APPENDED to that
 * digest rides along under that SAME "morning" tag, never this function's;
 * this function's own "coming-up" tag is only ever used for a STANDALONE
 * coming-up push, built directly from this module's `buildAlert`.)
 */
function collapseTag(subject: AlertSubject, ctx: AlertContext): string {
  if (subject.key === "score-excellent") return "excellent";
  if (subject.key === "coming-up") return "coming-up";
  const spec = CATALOG[subject.key];
  if (spec.tier === "home") return "excellent"; // unreachable today; safe fallback
  return `safety:${subject.key}:${ctx.slug ?? ""}`;
}

/**
 * How long THIS specific finding's dedup key stays quiet after it fires.
 * Almost always the catalog's static `repeatMs` — except a rip finding tied
 * to a real CAP alert id (dedupKey already `rip:<id>`, scoped to that exact
 * incident — see baseDedupKeyFor), which must push ONCE per id, not every
 * DEFAULT_REPEAT_MS (30 min) for as long as the statement stays in effect —
 * a Rip Current Statement can run 12-24h+, and re-pushing it every 30 min
 * for that whole window is spam, not safety. A NEW id (the CAP `references`
 * chain breaks and a genuinely different incident is issued) naturally gets
 * its OWN dedup key and pushes fresh — see evaluate.ts's onset gating.
 */
function repeatMsFor(subject: AlertSubject, spec: AlertSpec): number {
  if (subject.key === "rip" && subject.alertId) return Number.MAX_SAFE_INTEGER;
  return spec.repeatMs;
}

/** Turn one finding into a ready-to-send decision. */
export function buildAlert(subject: AlertSubject, ctx: AlertContext): AlertDecision {
  const spec = CATALOG[subject.key];
  const alarm = spec.alarm && !ctx.informational;
  return {
    alertKey: subject.key,
    dedupKey: dedupKeyFor(subject, ctx),
    priority: spec.priority,
    repeatMs: repeatMsFor(subject, spec),
    title: alarm ? `⚠️ ${ctx.beach}` : ctx.beach,
    tag: collapseTag(subject, ctx),
    body: bodyFor(subject, ctx),
    // A lightning escalation replaces the plain lightning alert in the same run,
    // so a storm arriving already inside 2 mi sends ONE push, not two.
    // Scoped to the same beach: an escalation at A never marks A's key from B.
    ...(subject.key === "lightning" && subject.escalated
      ? { supersedes: [scopeKey("lightning", ctx.slug)] }
      : {}),
    meta: metaFor(subject),
  };
}
