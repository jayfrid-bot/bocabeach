// Pure push-notification logic: turn a conditions response into a compact
// summary, and decide which notifications a given subscription is due for right
// now. No I/O here — the /api/push/run route does the fetching and sending and
// feeds these functions, which keeps the decision rules unit-testable.

import type { ConditionsResponse, SubScore, HourlyScore } from "@/lib/types";
import { beachDayVerdict } from "@/lib/format";

/** Local hour (0-23, beach time) at which the daily morning summary fires. */
export const MORNING_HOUR = 8;

/**
 * Safety alerts (lightning / rip / hazards) are PAUSED for now. They should only
 * fire when the user is physically at the beach, which needs presence-gating we
 * haven't built yet — until then, sending them anywhere (e.g. lightning 5 mi from
 * a beach you're nowhere near) is just noise. Only the morning summary ships.
 * Default on so the logic + tests stay exercised; production sets
 * PUSH_SAFETY_ALERTS=off to disable. Flip back on (with the presence gate) later.
 */
const SAFETY_ALERTS_ENABLED = process.env.PUSH_SAFETY_ALERTS !== "off";

/**
 * The minimum a subscription must expose for the decision logic — satisfied by
 * `NativeSub` (iOS APNs + Android FCM), so one rule set drives both platforms.
 */
export interface Notifiable {
  prefs: { morning: boolean; safety: boolean };
  sent?: { morningDate?: string; safetyKey?: string; safetyAt?: string };
}

/** Compact, notification-ready view of a beach's current conditions. */
export interface PushSummary {
  slug: string;
  name: string;
  score: number;
  /** "Excellent" | "Good" | "Fair" | "Poor" — the score's rating band. */
  rating: string;
  /** Legacy short verdict ("Yes!" / "Maybe" …); kept for callers/tests. */
  verdict: string;
  /** Up to 4 standout positives, rendered qualitatively (e.g. "warm water"). */
  pros: string[];
  /** Up to 3 standout negatives (e.g. "muggy", "moderate seaweed"). */
  cons: string[];
  /** Today's best window, e.g. "4–8 PM" — undefined if none ahead. */
  bestWindow?: string;
  /** A daylight stretch worth avoiding (a storm/rain dip), e.g. "2–3 PM". */
  skipWindow?: string;
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
  /hurricane warning|tropical storm warning|storm surge warning|tsunami (warning|advisory)|high surf warning|tornado warning|flash flood warning|special marine warning|extreme wind warning|coastal flood warning/i;

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

// ---- Pros / cons lexicon --------------------------------------------------

/**
 * Qualitative phrase for each sub-score, as a positive (when it scores well) or
 * a negative (when it scores poorly). Numbers are deliberately omitted — the
 * notification should read like a friend's tip, not a data dump.
 */
const PHRASES: Record<string, { pro?: string; con?: string }> = {
  waterTemp: { pro: "warm water", con: "cold water" },
  waves: { pro: "calm surf", con: "rough surf" },
  waterQuality: { pro: "clean", con: "murky water" },
  crowds: { pro: "quiet", con: "crowded" },
  sky: { pro: "sunny", con: "cloudy" },
  airTemp: { pro: "warm", con: "chilly" },
  wind: { pro: "light breeze", con: "windy" },
  sargassum: { pro: "no seaweed", con: "seaweed" }, // con refined by level below
  comfort: { pro: "comfortable", con: "muggy" },
  sandTemp: { pro: "cool sand", con: "hot sand" },
  uv: { pro: "low UV", con: "strong sun" },
};

/**
 * Order positives are chosen + shown in — the most beach-defining first, so when
 * many things are great we lead with water, surf, cleanliness, then quiet.
 */
const PRO_ORDER = [
  "waterTemp", "waves", "waterQuality", "crowds", "sky",
  "airTemp", "wind", "sargassum", "sandTemp", "comfort", "uv",
];

const PRO_MIN = 75; // a sub-score at/above this is a genuine selling point
const CON_MAX = 55; // a sub-score at/below this is a genuine drawback

/** Render one sub-score as a "con" phrase, refining seaweed by its level. */
function conPhrase(s: SubScore): string {
  if (s.key === "sargassum" && s.display) {
    const level = s.display.split("·")[0]?.trim().toLowerCase();
    if (level) return `${level} seaweed`;
  }
  return PHRASES[s.key]?.con ?? s.label.toLowerCase();
}

/** Pick the standout pros (≤4) and cons (≤3) from the sub-scores, qualitatively. */
function prosAndCons(subScores: SubScore[]): { pros: string[]; cons: string[] } {
  const byKey = new Map(subScores.map((s) => [s.key, s]));
  const pros: string[] = [];
  for (const key of PRO_ORDER) {
    if (pros.length >= 4) break;
    const s = byKey.get(key);
    const phrase = PHRASES[key]?.pro;
    if (s && s.score != null && s.score >= PRO_MIN && phrase) pros.push(phrase);
  }
  const cons = subScores
    .filter((s) => s.score != null && s.score <= CON_MAX && (PHRASES[s.key]?.con || s.key === "sargassum"))
    .sort((a, b) => (a.score ?? 0) - (b.score ?? 0)) // worst first
    .slice(0, 3)
    .map(conPhrase);
  return { pros, cons };
}

/** Headline verdict by score band (the notification title). */
function verdictPhrase(score: number): string {
  if (score >= 80) return "Great beach day today";
  if (score >= 65) return "Good beach day today";
  if (score >= 45) return "So-so beach day today";
  return "Rough beach day today";
}

/** Join phrases as "a, b, c & d", first letter capitalized. */
function joinPhrases(items: string[]): string {
  if (items.length === 0) return "";
  const joined =
    items.length === 1
      ? items[0]
      : `${items.slice(0, -1).join(", ")} & ${items[items.length - 1]}`;
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

// ---- Time windows ---------------------------------------------------------

/** Format a start/end ISO pair as "4–8 PM" (or "11 AM–2 PM" across noon). */
function fmtWindow(startIso: string, endIso: string, tz: string): string {
  const part = (iso: string) => {
    const ps = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true,
    }).formatToParts(new Date(iso));
    const get = (t: string) => ps.find((p) => p.type === t)?.value ?? "";
    return { hour: get("hour"), minute: get("minute"), period: get("dayPeriod") };
  };
  const a = part(startIso);
  const b = part(endIso);
  const h = (p: { hour: string; minute: string }) => (p.minute === "00" ? p.hour : `${p.hour}:${p.minute}`);
  return a.period === b.period
    ? `${h(a)}–${h(b)} ${b.period}`
    : `${h(a)} ${a.period}–${h(b)} ${b.period}`;
}

/**
 * The longest contiguous daylight stretch worth avoiding (a storm/rain dip), as
 * "2–3 PM" — but only on an otherwise-decent day (peak ≥ 60) and only for a
 * localized dip (≤ 4 h), so a washed-out day doesn't read "skip all day".
 */
function findSkipWindow(hourly: HourlyScore[], tz: string): string | undefined {
  if (!hourly.length) return undefined;
  const peak = Math.max(...hourly.map((h) => h.score));
  if (peak < 60) return undefined;
  const DIP = 40;
  let best: HourlyScore[] | null = null;
  let cur: HourlyScore[] = [];
  for (const h of hourly) {
    if (h.score < DIP) {
      cur.push(h);
    } else {
      if (cur.length && (!best || cur.length > best.length)) best = cur;
      cur = [];
    }
  }
  if (cur.length && (!best || cur.length > best.length)) best = cur;
  if (!best || best.length === 0 || best.length > 4) return undefined;
  return fmtWindow(best[0].time, best[best.length - 1].time, tz);
}

/**
 * The day's best contiguous beach window from the hourly curve, as "4–8 PM" —
 * the fallback when the forward-looking daily window is gone (e.g. a late-day
 * run). Threshold = within 12 of the peak, so it stays on the genuinely good
 * stretch; needs ≥2 h to count as a "window".
 */
function findBestWindow(hourly: HourlyScore[], tz: string): string | undefined {
  if (!hourly.length) return undefined;
  const peak = Math.max(...hourly.map((h) => h.score));
  if (peak < 45) return undefined;
  const thr = Math.max(45, peak - 12);
  let best: HourlyScore[] | null = null;
  let cur: HourlyScore[] = [];
  for (const h of hourly) {
    if (h.score >= thr) {
      cur.push(h);
    } else {
      if (cur.length && (!best || cur.length > best.length)) best = cur;
      cur = [];
    }
  }
  if (cur.length && (!best || cur.length > best.length)) best = cur;
  if (!best || best.length < 2) return undefined;
  return fmtWindow(best[0].time, best[best.length - 1].time, tz);
}

/** Build a notification-ready summary from a full conditions response. */
export function summarizeForPush(
  res: ConditionsResponse,
  loc: { slug: string; name: string; tz: string },
): PushSummary {
  const score = res.score.score;
  const today = res.multiDayWindows?.[0];
  const bw = today?.best ?? null;
  // res.hourlyScores has the chart's now-anchor baked in (one bucket forced to the
  // headline), which would distort dip/best-stretch detection — prefer the raw
  // unanchored forecast curve for window analysis (falls back when absent).
  const forecast = res.hourlyForecast ?? res.hourlyScores ?? [];
  const bestWindow = bw
    ? fmtWindow(bw.startIso, bw.endIso, loc.tz)
    : findBestWindow(forecast, loc.tz);
  const skipWindow = findSkipWindow(forecast, loc.tz);
  const { pros, cons } = prosAndCons(res.score.subScores ?? []);
  const safety = activeSafety(res);
  return {
    slug: loc.slug,
    name: loc.name,
    score,
    rating: res.score.rating ?? "",
    verdict: beachDayVerdict(score),
    pros,
    cons,
    bestWindow,
    skipWindow,
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
 *  - Morning summary: once per local day, at MORNING_HOUR, if opted in. Rich
 *    body: verdict + score, then ☀️ pros, ☁️ cons, 🕓 best/skip windows.
 *  - Safety alert: when an active safety condition's key differs from the last
 *    one we sent (so it fires on a NEW hazard, not every run while it persists).
 */
export function decideNotifications(
  sub: Notifiable,
  summary: PushSummary,
  hour: number,
  date: string,
  opts?: { force?: "morning"; nowMs?: number },
): { sends: PushDecision[]; nextSent: NonNullable<Notifiable["sent"]> } {
  const sent = sub.sent ?? {};
  const nowMs = opts?.nowMs ?? Date.now();
  const sends: PushDecision[] = [];
  const nextSent: NonNullable<Notifiable["sent"]> = { ...sent };
  const url = `/${summary.slug}`;

  // A forced send (the on-demand "test today's weather") bypasses the 8 AM gate
  // and the once-a-day dedup so it always fires — but still respects the morning
  // opt-out, and deliberately does NOT advance morningDate (real schedule untouched).
  const forceMorning = opts?.force === "morning";
  if (sub.prefs.morning && (forceMorning || (hour === MORNING_HOUR && sent.morningDate !== date))) {
    const pros = summary.pros ?? [];
    const cons = summary.cons ?? [];
    const lines: string[] = [];
    if (pros.length) lines.push(`☀️ ${joinPhrases(pros)}`);
    if (cons.length) lines.push(`☁️ ${joinPhrases(cons)}`);
    if (summary.bestWindow) {
      lines.push(
        `🕓 Best time: ${summary.bestWindow}` +
          (summary.skipWindow ? ` (skip ${summary.skipWindow})` : ""),
      );
    }
    sends.push({
      tag: "morning",
      title: `🏖️ ${verdictPhrase(summary.score)} · ${summary.score}/100`,
      body: lines.join("\n"),
      url,
    });
    if (!forceMorning) nextSent.morningDate = date;
  }

  // Safety alert (paused unless SAFETY_ALERTS_ENABLED): fire on a NEW hazard, and
  // RE-fire a still-active one every SAFETY_REPEAT_MS. The single-shot-on-change
  // rule alone meant a phone offline when the alert first fired (then suppressed by
  // the key dedup) never got a warning on reconnect.
  if (SAFETY_ALERTS_ENABLED) {
    const SAFETY_REPEAT_MS = 30 * 60 * 1000;
    const lastAt = sent.safetyAt ? Date.parse(sent.safetyAt) : NaN;
    const safetyDue =
      !!summary.safetyKey &&
      (sent.safetyKey !== summary.safetyKey ||
        (Number.isFinite(lastAt) && nowMs - lastAt >= SAFETY_REPEAT_MS));
    if (sub.prefs.safety && safetyDue) {
      sends.push({
        tag: "safety",
        title: `⚠️ ${summary.name}`,
        body: summary.safetyText ?? "Beach safety alert.",
        url,
      });
    }
    // Track the current key + when we last alerted, so a cleared-then-returned
    // hazard re-alerts, a persistent one re-reminds every SAFETY_REPEAT_MS (not
    // every run), and a cleared hazard resets the timer.
    nextSent.safetyKey = summary.safetyKey;
    if (!summary.safetyKey) {
      nextSent.safetyAt = undefined;
    } else if (sub.prefs.safety && safetyDue) {
      nextSent.safetyAt = new Date(nowMs).toISOString();
    } else {
      nextSent.safetyAt = sent.safetyAt;
    }
  }

  return { sends, nextSent };
}
