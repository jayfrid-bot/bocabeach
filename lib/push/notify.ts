// Pure push-notification logic: turn a conditions response into a compact
// summary, and decide which notifications a given subscription is due for right
// now. No I/O here — the /api/push/run route does the fetching and sending and
// feeds these functions, which keeps the decision rules unit-testable.

import type { ConditionsResponse } from "@/lib/types";
import { beachDayVerdict, fmtTime } from "@/lib/format";

/** Local hour (0-23, beach time) at which the daily morning summary fires. */
export const MORNING_HOUR = 7;

/**
 * The minimum a subscription must expose for the decision logic — satisfied by
 * `NativeSub` (iOS APNs + Android FCM), so one rule set drives both platforms.
 */
export interface Notifiable {
  prefs: { morning: boolean; safety: boolean };
  sent?: { morningDate?: string; safetyKey?: string };
}

/** Compact, notification-ready view of a beach's current conditions. */
export interface PushSummary {
  slug: string;
  name: string;
  score: number;
  verdict: string;
  /** Today's best window, e.g. "10 AM–2 PM" — undefined if none ahead. */
  bestWindow?: string;
  /**
   * Stable key for the single most-urgent active safety condition (or undefined
   * when none). Stable so the sender only re-alerts when the condition CHANGES;
   * `safetyText` is the human message.
   */
  safetyKey?: string;
  safetyText?: string;
}

// The genuinely dangerous, beach-closing NWS warnings (mirrors score.ts).
const SEVERE_ALERT =
  /hurricane warning|tropical storm warning|storm surge warning|tsunami|high surf warning|tornado warning|flash flood warning|special marine warning|extreme wind warning|coastal flood warning/i;

/**
 * Extract the single highest-priority active safety condition from a snapshot,
 * as a stable { key, text }. Priority: lightning → severe warning → water
 * advisory → beach hazards → high rip → red flag → moderate rip. Mirrors what
 * SafetyBanner surfaces in-app (incl. moderate rip), so push never stays silent
 * on a hazard the app is showing. Returns null when clear.
 */
function activeSafety(res: ConditionsResponse): { key: string; text: string } | null {
  const s = res.snapshot;

  const lt = s.lightning;
  if (
    lt?.status === "ok" &&
    (lt.data?.lastMinutesAgo == null || lt.data.lastMinutesAgo <= 30) &&
    (lt.data?.nearestMi ?? Infinity) <= 5
  ) {
    // Match the in-app SafetyBanner wording exactly (incl. "seek shelter").
    return { key: "lightning", text: "Lightning within 5 miles — get out of the water and seek shelter." };
  }

  const alerts = s.nws.data?.alerts ?? [];
  const severe = alerts.find(
    (a) => SEVERE_ALERT.test(a.event) || /^(Severe|Extreme)$/i.test(a.severity),
  );
  if (severe) return { key: `severe:${severe.event}`, text: `${severe.event} in effect.` };

  if (s.cityOfficial.data?.noSwimAdvisory || s.waterQuality.data?.advisory) {
    return { key: "water", text: "Water-quality advisory — swimming not recommended." };
  }

  const hazard = alerts.find((a) => /beach hazard/i.test(a.event));
  if (hazard) return { key: "hazard", text: "NWS Beach Hazards Statement in effect." };

  if (s.nws.data?.ripCurrentRisk === "high") {
    return { key: "rip", text: "High rip-current risk today." };
  }

  const flags = s.cityOfficial.data?.flags ?? [];
  if (flags.some((f) => f === "red" || f === "double-red")) {
    return { key: "flag:red", text: "Red flag flying — dangerous surf, stay out of the water." };
  }

  // Moderate rip current: the app shows it (amber), so alert on it too — lowest
  // priority. Dedup means it fires once per occurrence, not repeatedly.
  if (s.nws.data?.ripCurrentRisk === "moderate") {
    return { key: "rip-moderate", text: "Moderate rip-current risk today — swim near a lifeguard." };
  }

  return null;
}

/** Build a notification-ready summary from a full conditions response. */
export function summarizeForPush(
  res: ConditionsResponse,
  loc: { slug: string; name: string; tz: string },
): PushSummary {
  const score = res.score.score;
  const today = res.multiDayWindows?.[0];
  const bw = today?.best ?? null;
  const bestWindow = bw
    ? `${fmtTime(bw.startIso, loc.tz)}–${fmtTime(bw.endIso, loc.tz)}`
    : undefined;
  const safety = activeSafety(res);
  return {
    slug: loc.slug,
    name: loc.name,
    score,
    verdict: beachDayVerdict(score),
    bestWindow,
    safetyKey: safety?.key,
    safetyText: safety?.text,
  };
}

/** A single notification to deliver (matches the service worker's payload shape). */
export interface PushDecision {
  tag: string;
  title: string;
  body: string;
  url: string;
}

/**
 * Decide which notifications `sub` is due for, given the current `summary`, the
 * beach-local `hour` and ISO `date`. Returns the messages to send plus the new
 * dedup state to persist. Rules:
 *  - Morning summary: once per local day, at MORNING_HOUR, if opted in.
 *  - Safety alert: when an active safety condition's key differs from the last
 *    one we sent (so it fires on a NEW hazard, not every run while it persists).
 */
export function decideNotifications(
  sub: Notifiable,
  summary: PushSummary,
  hour: number,
  date: string,
): { sends: PushDecision[]; nextSent: NonNullable<Notifiable["sent"]> } {
  const sent = sub.sent ?? {};
  const sends: PushDecision[] = [];
  const nextSent: NonNullable<Notifiable["sent"]> = { ...sent };
  const url = `/${summary.slug}`;

  if (sub.prefs.morning && hour === MORNING_HOUR && sent.morningDate !== date) {
    sends.push({
      tag: "morning",
      title: `${summary.name} — Beach Day ${summary.score}`,
      body:
        `${summary.verdict} today.` +
        (summary.bestWindow ? ` Best window ${summary.bestWindow}.` : ""),
      url,
    });
    nextSent.morningDate = date;
  }

  if (sub.prefs.safety && summary.safetyKey && sent.safetyKey !== summary.safetyKey) {
    sends.push({
      tag: "safety",
      title: `⚠️ ${summary.name}`,
      body: summary.safetyText ?? "Beach safety alert.",
      url,
    });
  }
  // Track the current safety key either way, so a cleared-then-returned hazard
  // re-alerts and a persistent one doesn't repeat.
  nextSent.safetyKey = summary.safetyKey;

  return { sends, nextSent };
}
