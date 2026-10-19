// What the Apple Watch app shows, computed here with the website's own logic so
// the wrist never says something the page does not. The watch decodes this and
// nothing else (GET /api/watch/<slug>); it has no safety rules of its own.
//
// Safety lines come from lib/safetyBanner.ts, the same module the website's
// SafetyBanner renders, so the watch shows the same hazards in the same order
// and tones; this file only shortens and truncates them.
//   score + live rip cap ... lib/score.ts (applyLiveRipCap) + lib/ripRisk (ripCapFor)
//   hazards, flags, rip, alerts (active AND upcoming) ... lib/safetyBanner.ts
//   rain ... lib/rainNowcast.ts (measured rain at the beach, or on its way)
//   best time ... lib/scoreBands.ts goodWindow (Decent or better only)
//   sun forecast ... lib/sunForecastWindow.ts (WHEN the next sunrise/sunset color
//                    forecast opens; the view never carries the color score itself)
// Missing data is null or an absent line, never a guess.

import { applyLiveRipCap, deriveMetrics } from "@/lib/score";
import { ripCapFor } from "@/lib/ripRisk";
import { rainNowcast } from "@/lib/rainNowcast";
import { buildSafetyBanner, type BannerItem } from "@/lib/safetyBanner";
import { safetyTone, type SafetyTone } from "@/lib/safetyTone";
import { goodWindow, scoreBand } from "@/lib/scoreBands";
import { PRECIP_RADAR_STALE_MINUTES } from "@/lib/sources/precipRadar";
import { nextSunForecastField, type SunForecastField } from "@/lib/sunForecastWindow";
import type { ConditionsResponse, FlagColor } from "@/lib/types";

export type WatchTone = SafetyTone;
export type WatchLineKind = "hazard" | "safety" | "water" | "best" | "more";

export interface WatchLine {
  kind: WatchLineKind;
  /** Short enough for one or two lines on a small watch. */
  text: string;
  tone: WatchTone;
}

export interface WatchView {
  /** Bump only when a field changes meaning. */
  v: 1;
  slug: string;
  name: string;
  /** 0-100, or null when there was no usable data. */
  score: number | null;
  /** "Excellent" | "Good" | "Decent" | "Marginal" | "Poor"; null with no score. */
  rating: string | null;
  /** Lowercase rating word: the key for the band's color (lib/scoreBands.ts). */
  band: string | null;
  /** The score was built from too little live data. */
  limitedData: boolean;
  /** In display order: up to 3 safety lines (the website's order), "+N more" when
   *  more were cut, then water and best time. */
  lines: WatchLine[];
  waterTempF: number | null;
  /** The next sunrise or sunset and when its color forecast opens (60 minutes
   *  before the event). While `state` is "pending", `text` is the one line to
   *  show, e.g. "Sunset color forecast ready at 5:52 PM". There is never a color score in
   *  this field, pending or not: the number lives only in the app. Null when
   *  the beach has no usable sun times. */
  sunForecast: SunForecastField | null;
  /** When the server built the conditions snapshot. */
  generatedAt: string | null;
  /** When this view was computed. */
  capturedAt: string;
  /** The earliest moment something this view says can change: an alert starting
   *  or ending, the next rip model hour, the best window's end, the sun forecast
   *  window opening, or 15 minutes
   *  after generatedAt. After it, the watch must not call this view current. */
  validUntil: string;
}

const TONE_RANK: Record<WatchTone, number> = { calm: 0, caution: 1, danger: 2 };
export const MAX_SAFETY_LINES = 3;
/** Safety lines (at most MAX_SAFETY_LINES), "+N more", water temperature, best time. */
export const MAX_WATCH_LINES = MAX_SAFETY_LINES + 3;
/** A water temperature outside (MIN, MAX) exclusive is treated as no reading; inside, it is rounded, so a view can hold MIN..MAX inclusive. */
export const WATER_TEMP_MIN_F = -10;
export const WATER_TEMP_MAX_F = 150;

/** The water temperature a view shows: rounded, or null for a missing or implausible reading. */
export function waterTempForView(f: unknown): number | null {
  return typeof f === "number" && Number.isFinite(f) && f > WATER_TEMP_MIN_F && f < WATER_TEMP_MAX_F ? Math.round(f) : null;
}
/** The longest a computed view may be called current after its snapshot was built. */
export const MAX_VALID_MS = 15 * 60_000;

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const maxTone = (a: WatchTone, b: WatchTone): WatchTone => (TONE_RANK[b] > TONE_RANK[a] ? b : a);

// ---- safety lines -----------------------------------------------------------

/** "Yellow + purple flags", "Double red flag". Order: worst first. */
function flagsText(flags: readonly FlagColor[]): string | null {
  const order: FlagColor[] = ["double-red", "red", "yellow", "green", "purple"];
  const present = order.filter((f) => flags.includes(f));
  if (!present.length) return null;
  const words = present.map((f) => (f === "double-red" ? "double red" : f));
  const first = `${words[0][0].toUpperCase()}${words[0].slice(1)}`;
  return present.length === 1 ? `${first} flag` : `${first} + ${words.slice(1).join(" + ")} flags`;
}

/** The watch drops nothing for length: a long line is cut with an ellipsis. */
const MAX_LINE = 78;
function fitLine(text: string): string {
  return text.length <= MAX_LINE ? text : `${text.slice(0, MAX_LINE - 1).trimEnd()}\u2026`;
}

function safetyLines(res: ConditionsResponse, nowMs: number): WatchLine[] {
  const snap = res.snapshot;
  const radar = snap.precipRadar;
  const age = radar?.data?.frameAgeMinutes;
  // Rain only from a radar frame that is still fresh, worded by lib/rainNowcast.ts.
  const rain = finite(age) && age <= PRECIP_RADAR_STALE_MINUTES ? rainNowcast(radar) : null;
  const banner = buildSafetyBanner({
    city: snap.cityOfficial,
    water: snap.waterQuality,
    lightning: snap.lightning,
    nws: snap.nws,
    ripNwps: snap.ripNwps,
    timezone: snap.location.timezone,
    nowMs,
    rain,
  });

  const flagTone = safetyTone({ flags: banner.flags });
  const flagLabel = flagsText(banner.flags);
  // A low rip reading earns no banner block, but it is useful reassurance next to a flag.
  const ripLow =
    !banner.hasRipToShow && banner.ripNow.level === "low" && banner.ripNow.source !== "unknown"
      ? "Rip current low"
      : null;

  const lines: WatchLine[] = [];
  let flagAdded = false;
  for (const item of banner.items as BannerItem[]) {
    if (item.id.startsWith("flag-")) {
      // All flags become ONE line, at the rank of the first (worst) flag item.
      if (flagAdded || !flagLabel) continue;
      flagAdded = true;
      lines.push({
        kind: "safety",
        text: ripLow ? `${flagLabel} · ${ripLow}` : flagLabel,
        tone: flagTone,
      });
      continue;
    }
    lines.push({
      kind: item.id === "rip" ? "safety" : "hazard",
      text: fitLine(item.short),
      tone: item.itemTone,
    });
  }
  if (!flagAdded && ripLow) lines.push({ kind: "safety", text: ripLow, tone: "calm" });

  if (lines.length <= MAX_SAFETY_LINES) return lines;
  const hidden = lines.slice(MAX_SAFETY_LINES);
  return [
    ...lines.slice(0, MAX_SAFETY_LINES),
    { kind: "more", text: `+${hidden.length} more`, tone: hidden.reduce<WatchTone>((t, l) => maxTone(t, l.tone), "calm") },
  ];
}

/** "4–6 PM", or "11 AM–1 PM" when the halves of the day differ. In the beach's own time zone. */
export function windowText(startIso: string, endIso: string, timeZone: string): string | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true });
  const parts = (ms: number) => {
    const p = fmt.formatToParts(new Date(ms));
    const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
    return { hour: get("hour"), minute: get("minute"), half: get("dayPeriod").toUpperCase() };
  };
  const clock = (p: ReturnType<typeof parts>, withHalf: boolean) =>
    `${p.hour}${p.minute === "00" ? "" : `:${p.minute}`}${withHalf ? ` ${p.half}` : ""}`;
  const a = parts(start);
  const b = parts(end);
  return `${clock(a, a.half !== b.half)}–${clock(b, true)}`;
}

function bestLine(res: ConditionsResponse, nowMs: number): WatchLine | null {
  const today = res.multiDayWindows?.[0];
  const best = today?.best;
  if (!best) return null;
  const end = Date.parse(best.endIso);
  // Today's window is built from time still ahead; one that has ended is stale.
  if (!Number.isFinite(end) || end <= nowMs) return null;
  if (!goodWindow(best)) return { kind: "best", text: "No good window today", tone: "calm" };
  const text = windowText(best.startIso, best.endIso, res.snapshot.location.timezone);
  return text ? { kind: "best", text: `Best ${text}`, tone: "calm" } : null;
}

// ---- freshness --------------------------------------------------------------

/** The route's Cache-Control: s-maxage = min(60, seconds the view stays valid);
 *  nothing left (or not a number) means no-store. Never stale-while-revalidate. */
export function cacheControlFor(secondsValid: number): string {
  const whole = Math.floor(secondsValid);
  if (!Number.isFinite(whole) || whole <= 0) return "no-store";
  return `public, s-maxage=${Math.min(60, whole)}`;
}

/** The earliest future moment any clock-dependent part of this view can change. */
export function computeValidUntil(res: ConditionsResponse, nowMs: number): number {
  const snap = res.snapshot;
  const generated = Date.parse(snap.generatedAt);
  const candidates: number[] = [(Number.isFinite(generated) ? generated : nowMs) + MAX_VALID_MS];
  const add = (iso: string | null | undefined) => {
    const t = iso ? Date.parse(iso) : NaN;
    if (Number.isFinite(t) && t > nowMs) candidates.push(t);
  };
  // Alerts starting or ending (rip and everything else).
  for (const a of snap.nws?.data?.alerts ?? []) {
    add(a.onset);
    add(a.effective);
    add(a.ends);
    add(a.expires);
  }
  // The surf-zone forecast's own period boundaries.
  for (const p of snap.nws?.data?.srfPeriods ?? []) {
    add(p.start);
    add(p.end);
  }
  // The NOAA rip model steps hourly.
  if (snap.ripNwps?.data) candidates.push(Math.floor(nowMs / 3_600_000) * 3_600_000 + 3_600_000);
  // Today's best window ending.
  add(res.multiDayWindows?.[0]?.best?.endIso);
  // The sun color forecast window opening (pending -> available).
  const sunForecast = nextSunForecastField(snap.sun?.data, nowMs, snap.location.timezone);
  if (sunForecast?.state === "pending") add(sunForecast.availableAt);
  return Math.min(...candidates);
}

// ---- the view ---------------------------------------------------------------

export function buildWatchView(res: ConditionsResponse, nowMs: number = Date.now()): WatchView {
  const snap = res.snapshot;
  // Never earlier than the snapshot's own clock (same rule as the dashboard).
  const generatedMs = Date.parse(snap.generatedAt);
  const now = Number.isFinite(generatedMs) ? Math.max(nowMs, generatedMs) : nowMs;

  const d = deriveMetrics(snap, now);
  const scored = applyLiveRipCap(res.score, ripCapFor(d.ripNow), d.ripNow);
  const hasScore = scored.dataAvailable !== false && finite(scored.score);
  const score = hasScore ? Math.max(0, Math.min(100, Math.round(scored.score))) : null;
  const band = score == null ? null : scoreBand(score);

  const lines: WatchLine[] = [...safetyLines(res, now)];
  const waterTempF = waterTempForView(d.waterTempF);
  if (waterTempF != null) lines.push({ kind: "water", text: `Water ${waterTempF}\u00B0F`, tone: "calm" });
  const best = bestLine(res, now);
  if (best) lines.push(best);

  return {
    v: 1,
    slug: snap.location.slug,
    name: snap.location.name,
    score,
    rating: band?.rating ?? null,
    band: band ? band.rating.toLowerCase() : null,
    limitedData: scored.dataCoverage === "limited",
    lines,
    waterTempF,
    sunForecast: nextSunForecastField(snap.sun?.data, now, snap.location.timezone),
    generatedAt: snap.generatedAt ?? null,
    capturedAt: new Date(now).toISOString(),
    validUntil: new Date(computeValidUntil(res, now)).toISOString(),
  };
}
