// A short score outlook for one beach: the next 1-3 calendar days (today is day 1).
// It reads the multi-day windows the website's "best beach times for the next few days"
// strip uses (ConditionsResponse.multiDayWindows, built by lib/score.ts), so the outlook,
// the page and the app never disagree. Future days are forecast only: no live flags, rip
// or alerts, and fewer factors than today (the breakdown says which caps held the score).
// Missing data is a missing day, never a guess.

import { findBeach } from "@/lib/agent/beaches";
import { ATTRIBUTION, DISCLAIMER, MAX_OUTLOOK_DAYS, OUTLOOK_NOTE, SAFETY_NOTE } from "@/lib/agent/constants";
import { goodWindow, scoreBand } from "@/lib/scoreBands";
import { loadPublicConditions } from "@/lib/watchLoad";
import { computeValidUntil, windowText } from "@/lib/watchView";
import type { ConditionsResponse, DayWindow } from "@/lib/types";

export interface OutlookWindow {
  startIso: string;
  endIso: string;
  /** Local time at the beach, e.g. "10 AM–1 PM". */
  text: string;
  /** Score of the window's best hour. */
  score: number;
  rating: string;
  /** True when the window reaches Decent (65) or better, the same bar the app uses to say "go". */
  good: boolean;
}

export interface OutlookDay {
  /** YYYY-MM-DD in the beach's local time. */
  date: string;
  /** Full weekday name, e.g. "Saturday". */
  weekday: string;
  /** "Today", "Tomorrow", or the weekday. */
  label: string;
  /** True only for today when no daylight beach time is left (peakScore, bestWindow, sky are then null). */
  noTimeLeft: boolean;
  /** Expected peak Beach Day score for the day, 0-100, or null when no hours scored (or no time left today). */
  peakScore: number | null;
  rating: string | null;
  /** Best stretch of daylight. Null when no window is left or none scored. */
  bestWindow: OutlookWindow | null;
  /** Short sky word, e.g. "Mostly Sunny". Null when unknown. */
  sky: string | null;
  /** Safety notes for the peak hour (the safety caps the score model applied). Empty means none. */
  notes: string[];
  /** One plain sentence. */
  summary: string;
}

export interface BeachOutlook {
  /** Bump only when a field changes meaning. */
  v: 1;
  slug: string;
  name: string;
  region: string;
  state: string | null;
  url: string;
  /** IANA zone the dates and window times are in. */
  timezone: string;
  requestedDays: number;
  days: OutlookDay[];
  /** One plain paragraph for reading out, ending with the forecast note. */
  summary: string;
  forecastNote: string;
  /** Set when fewer days than asked for are available. */
  note?: string;
  generatedAt: string | null;
  updatedAt: string;
  capturedAt: string;
  validUntil: string;
  safetyNote: string;
  disclaimer: string;
  attribution: typeof ATTRIBUTION;
}

const SKY_BY_EMOJI: Record<string, string> = {
  "☀️": "Sunny",
  "🌤️": "Mostly Sunny",
  "⛅": "Partly Cloudy",
  "☁️": "Cloudy",
  "🌫️": "Fog",
  "🌦️": "Showers",
  "🌧️": "Rain",
  "⛈️": "Thunderstorms",
  "🌨️": "Snow",
};

function skyWord(w: DayWindow): string | null {
  const display = w.peakBreakdown?.subScores.find((s) => s.key === "sky")?.display;
  const word = display?.split("·")[0].trim();
  if (word && !/^\d+%\s*cloud$/i.test(word)) return word;
  return SKY_BY_EMOJI[w.emoji] ?? null;
}

const dateKey = (ms: number, timeZone: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));

/** YYYY-MM-DD plus whole days (calendar arithmetic, no time zone involved). */
function addDays(key: string, n: number): string {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const weekdayOf = (key: string): string =>
  new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(new Date(`${key}T12:00:00Z`));

function buildDay(w: DayWindow, label: string, weekday: string, tz: string, nowMs: number, isToday: boolean): OutlookDay {
  const head = label === weekday ? label : `${label} (${weekday})`;

  // Today with no daylight time left: either there is no window at all (every daylight hour is
  // past) or the window has ended. The day's peak then comes from hours that are gone, so it is
  // not an expectation; show no score, sky or safety notes from those hours.
  const best = w.best;
  const bestEnd = best ? Date.parse(best.endIso) : NaN;
  if (isToday && (!best || !Number.isFinite(bestEnd) || bestEnd <= nowMs)) {
    return {
      date: w.date, weekday, label,
      noTimeLeft: true,
      peakScore: null, rating: null, bestWindow: null, sky: null, notes: [],
      summary: `${head}: no beach time left today.`,
    };
  }

  const peakScore = typeof w.peakScore === "number" && Number.isFinite(w.peakScore) ? Math.max(0, Math.min(100, Math.round(w.peakScore))) : null;
  const rating = peakScore == null ? null : scoreBand(peakScore).rating;

  let bestWindow: OutlookWindow | null = null;
  if (best) {
    const text = windowText(best.startIso, best.endIso, tz);
    if (text) {
      const score = Math.round(best.score);
      bestWindow = { startIso: best.startIso, endIso: best.endIso, text, score, rating: scoreBand(score).rating, good: goodWindow({ score }) !== null };
    }
  }

  const sky = skyWord(w);
  const notes = [...(w.peakBreakdown?.caps ?? [])];

  const parts: string[] = [];
  parts.push(peakScore == null ? `${head}: no usable score.` : `${head}: expected peak ${peakScore}/100 (${rating}).`);
  if (bestWindow) {
    parts.push(bestWindow.good ? `Best ${bestWindow.text}.` : `No good window; the best stretch (${bestWindow.text}) only reaches ${bestWindow.score}, ${bestWindow.rating}.`);
  }
  if (sky) parts.push(`Sky: ${sky}.`);
  if (notes.length) parts.push(`Safety notes: ${notes.map((n) => n.replace(/[.\s]+$/, "")).join("; ")}.`);

  return { date: w.date, weekday, label, noTimeLeft: false, peakScore, rating, bestWindow, sky, notes, summary: parts.join(" ") };
}

/** Build the outlook from a conditions response. `days` counts calendar days from today (1-3). */
export function buildOutlook(res: ConditionsResponse, days: number, nowMs: number = Date.now()): BeachOutlook | null {
  const snap = res.snapshot;
  const beach = findBeach(snap.location.slug);
  if (!beach) return null;
  const generatedMs = Date.parse(snap.generatedAt);
  const now = Number.isFinite(generatedMs) ? Math.max(nowMs, generatedMs) : nowMs;
  const tz = snap.location.timezone;
  const asked = Math.max(1, Math.min(MAX_OUTLOOK_DAYS, Math.floor(days)));

  const todayKey = dateKey(now, tz);
  const lastKey = addDays(todayKey, asked - 1);
  const tomorrowKey = addDays(todayKey, 1);
  const outDays: OutlookDay[] = [];
  for (const w of res.multiDayWindows ?? []) {
    if (!w || typeof w.date !== "string" || w.date < todayKey || w.date > lastKey) continue;
    const weekday = weekdayOf(w.date);
    const label = w.date === todayKey ? "Today" : w.date === tomorrowKey ? "Tomorrow" : weekday;
    outDays.push(buildDay(w, label, weekday, tz, now, w.date === todayKey));
  }
  outDays.sort((a, b) => (a.date < b.date ? -1 : 1));

  const note =
    outDays.length === 0
      ? "No forecast days are available for this beach right now. Try again later."
      : outDays.length < asked
        ? `Only ${outDays.length} of the ${asked} days asked for ${outDays.length === 1 ? "has" : "have"} forecast data right now.`
        : undefined;

  const summary = [
    outDays.length ? `${snap.location.name} outlook. ${outDays.map((d) => d.summary).join(" ")}` : `${snap.location.name}: ${note}`,
    outDays.length && note ? note : "",
    OUTLOOK_NOTE,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    v: 1,
    slug: snap.location.slug,
    name: snap.location.name,
    region: beach.region,
    state: beach.state,
    url: beach.url,
    timezone: tz,
    requestedDays: asked,
    days: outDays,
    summary,
    forecastNote: OUTLOOK_NOTE,
    ...(note ? { note } : {}),
    generatedAt: snap.generatedAt ?? null,
    updatedAt: snap.generatedAt ?? new Date(now).toISOString(),
    capturedAt: new Date(now).toISOString(),
    validUntil: new Date(computeValidUntil(res, now)).toISOString(),
    safetyNote: SAFETY_NOTE,
    disclaimer: DISCLAIMER,
    attribution: ATTRIBUTION,
  };
}

export type OutlookLoad =
  | { status: "ok"; outlook: BeachOutlook }
  | { status: "not_found" }
  | { status: "incomplete" }
  /** Already past validUntil when it was about to be served. Never served. */
  | { status: "expired" };

/**
 * One beach's outlook. Reads the shared 120-s conditions cache or builds that ONE beach (never
 * more: the request names a single slug). Never returns an outlook past its validUntil.
 */
export async function loadBeachOutlook(slug: string, days: number): Promise<OutlookLoad> {
  const loaded = await loadPublicConditions(slug);
  if (loaded.status !== "ok") return loaded;
  const outlook = buildOutlook(loaded.conditions, days);
  if (!outlook) return { status: "not_found" };
  return Date.parse(outlook.validUntil) > Date.now() ? { status: "ok", outlook } : { status: "expired" };
}
