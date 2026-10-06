// Pure view-model for the shareable social card (app/api/share/[slug]/route.tsx).
//
// Picks the handful of numbers a person standing on the sand would actually
// want to show off, in a fixed priority order, and drops any tile whose data
// isn't in today's snapshot. Never throws — every field reads from an
// optional chain, so an empty/degraded ConditionsResponse still produces a
// valid (mostly empty) model rather than sinking the image route.

import type { ConditionsResponse } from "@/lib/types";
import { GOOD_WINDOW_MIN_SCORE, scoreBand } from "@/lib/scoreBands";
import { beachDayVerdict } from "@/lib/format";
import { uvBand } from "@/lib/uv";
import { clarityDisplayWord } from "@/lib/sources/clarity";
import { listLocations } from "@/config/locations";
import { applyLiveRipCap, deriveMetrics } from "@/lib/score";
import { ripCapFor } from "@/lib/ripRisk/resolve";
import { swimSafety, type SwimSafetyLevel } from "@/lib/safetyLine";
import { fmtTime } from "@/lib/format";
import { CONDITIONS_MAX_STALE_MS } from "@/lib/conditionsFreshness";

export interface ShareCardTile {
  key: string;
  label: string;
  /** Short, one line ("4.8 ft"). The card never lets it wrap. */
  value: string;
  /** Optional second line under the value ("big waves"). */
  note?: string;
}

/** Most tiles the model offers. The story card shows all 12; the square card
 *  shows the first 9. */
export const SHARE_CARD_MAX_TILES = 12;

export interface ShareCardModel {
  slug: string;
  beachName: string;
  region: string;
  /** "Mon Sep 14", local to the beach — when the conditions were measured. */
  dateLabel: string;
  /** "4:08 PM", local to the beach — when the conditions were measured
   *  (snapshot.generatedAt), not when the image was drawn. */
  timeLabel: string;
  /** False on a total data outage: the card shows no number or verdict. */
  available: boolean;
  /** Set when the score rests on too few readings (lib/score.ts caps it). */
  limitedNote?: string;
  /** The conditions are older than the dashboard's own freshness limit. */
  stale: boolean;
  score: number;
  rating: string;
  /** Accent hex for the rating band (see lib/scoreBands.ts). */
  color: string;
  /** One-line headline, e.g. "Yes — good beach day". */
  verdict: string;
  /** Up to SHARE_CARD_MAX_TILES metric tiles, in priority order, data-permitting. */
  tiles: ShareCardTile[];
  /** A detected swim hazard, the same call the app's safety line makes.
   *  `label` is empty when none was detected (the card then shows no strip). */
  safety: { level: SwimSafetyLevel; label: string; reasons: string[] };
  /** "Best time today: 5–7 PM", or tomorrow's once today's window has passed. */
  bestTime?: string;
  /** False when the line says there is no good time today. */
  bestTimeGood?: boolean;
  capped: boolean;
  /** Why the score was capped, when it was. */
  capNote?: string;
  /** The next known moment the card's safety picture changes (a rip alert
   *  starting or ending, an NWS rip forecast period ending), when one is
   *  ahead. The route keeps its cached PNG no longer than this. */
  changesAtMs?: number;
  /** "isitbeachday.com/<slug>" — for on-card display. */
  pageUrl: string;
  /** The tracked link the share sheet hands off (never shown as visible
   *  card text — see pageUrl for that). */
  shareUrl: string;
}

/** Safe number formatter: never throws on NaN/undefined. */
function asNumber(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : undefined;
}

/** Strips the "estimated" hedge words a sub-score display sometimes carries
 *  (e.g. "~101°F est.") — the card states the number plainly, no hedging. */
function stripEstimateHedge(s: string): string {
  return s.replace(/~/g, "").replace(/\s*est\.?/gi, "").trim();
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** "4.8 ft · big waves" → value "4.8 ft", note "big waves". */
function splitDisplay(display: string | undefined): { value?: string; note?: string } {
  if (!display) return {};
  const [value, ...rest] = display.split(" · ");
  const note = rest.join(" · ").trim();
  return { value: stripEstimateHedge(value), note: note ? stripEstimateHedge(note) : undefined };
}

function safeTime(iso: string, tz: string): string | undefined {
  try {
    return fmtTime(iso, tz);
  } catch {
    return undefined;
  }
}

const SAFETY_LABEL: Record<SwimSafetyLevel, string> = {
  safe: "",
  caution: "Swim with caution",
  "stay-out": "Stay out of the water",
};

/** The swim-safety strip shows only a hazard the data actually detected.
 *  `swimSafety` reads "no hazard found" as safe, and a failed source finds
 *  no hazard, so a shared image never claims "safe to swim". */
function safetyFor(
  derived: ReturnType<typeof deriveMetrics> | null,
  snapshot: ConditionsResponse["snapshot"] | undefined,
): ShareCardModel["safety"] {
  if (!derived) return { level: "safe", label: "", reasons: [] };
  const line = swimSafety(derived, snapshot);
  if (line.level === "safe") return { level: "safe", label: "", reasons: [] };
  return { level: line.level, label: SAFETY_LABEL[line.level], reasons: line.reasons.slice(0, 2) };
}

function bestTimeFields(label: { text: string; good: boolean } | undefined) {
  return label ? { bestTime: label.text, bestTimeGood: label.good } : {};
}

/** The best-time line, chosen by beach-local date. Today's window counts only
 *  while it is still ahead AND scores at least GOOD_WINDOW_MIN_SCORE; a bad
 *  day says so instead of naming its least-bad hours. A window already under
 *  way reads "now until 7 PM". `endIso` is the exclusive end of the window's
 *  last hour (lib/score.ts), so "5 PM–7 PM" is exact. */
function bestTimeLabel(
  res: ConditionsResponse | null | undefined,
  nowMs: number,
  tz: string,
  today: string | undefined,
  tomorrow: string | undefined,
): { text: string; good: boolean } | undefined {
  const days = res?.multiDayWindows ?? [];
  const windowFor = (date: string | undefined) => {
    const best = date ? days.find((d) => d.date === date)?.best : undefined;
    return best && Date.parse(best.endIso) > nowMs ? best : undefined;
  };
  const range = (best: { startIso: string; endIso: string }) => {
    const b = safeHourLabel(best.endIso, tz);
    if (!b) return undefined;
    if (Date.parse(best.startIso) <= nowMs) return `now until ${b}`;
    const a = safeHourLabel(best.startIso, tz);
    return a ? (a === b ? a : `${a}–${b}`) : undefined;
  };
  const good = (best: { score: number } | undefined) => !!best && best.score >= GOOD_WINDOW_MIN_SCORE;

  const t = windowFor(today);
  const n = windowFor(tomorrow);
  if (good(t)) {
    const r = range(t!);
    if (r) return { text: `Best time today: ${r}`, good: true };
  }
  const tomorrowRange = good(n) ? range(n!) : undefined;
  if (t) {
    // Today still has hours left, but none of them is good.
    return {
      text: tomorrowRange ? `No good time today · Best tomorrow: ${tomorrowRange}` : "No good beach time today",
      good: false,
    };
  }
  return tomorrowRange ? { text: `Best time tomorrow: ${tomorrowRange}`, good: true } : undefined;
}

/** Earliest known future boundary of the resolved rip status. */
function nextRipChange(rip: NonNullable<ReturnType<typeof deriveMetrics>["ripNow"]> | undefined, nowMs: number): number | undefined {
  if (!rip) return undefined;
  const times = [rip.alert?.end, rip.upcomingAlert?.onset, rip.period?.end]
    .map((iso) => (iso ? Date.parse(iso) : NaN))
    .filter((t) => Number.isFinite(t) && t > nowMs);
  return times.length ? Math.min(...times) : undefined;
}

/** "2026-09-14" in the beach's timezone. */
function localDateKey(ms: number, tz: string): string | undefined {
  try {
    return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: tz }).format(
      new Date(ms),
    );
  } catch {
    return undefined;
  }
}

/** The calendar day after a "YYYY-MM-DD" key (plain date math, no clock). */
function nextDateKey(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** "5 PM" / "5:30 PM". */
function safeHourLabel(iso: string, tz: string): string | undefined {
  const t = safeTime(iso, tz);
  return t?.replace(":00 ", " ");
}

const UNAVAILABLE_COLOR = "#94a3b8";

export function shareCardModel(
  res: ConditionsResponse | null | undefined,
  requestMs: number = Date.now(),
): ShareCardModel {
  const snapshot = res?.snapshot;
  const loc = snapshot?.location;
  const tz = loc?.timezone || "America/New_York";
  // Never resolve conditions earlier than they were measured (clock skew
  // between edge locations), same clamp as the dashboard.
  const generatedMs = Date.parse(snapshot?.generatedAt ?? "");
  const nowMs = Number.isFinite(generatedMs) ? Math.max(requestMs, generatedMs) : requestMs;
  const asOfMs = Number.isFinite(generatedMs) ? generatedMs : nowMs;

  // The cached score was computed on the server's clock at build time. Rip
  // status is re-resolved against now, and the score follows it both ways,
  // exactly as the dashboard does (components/ConditionsDashboard.tsx).
  let derived: ReturnType<typeof deriveMetrics> | null = null;
  try {
    derived = snapshot ? deriveMetrics(snapshot, nowMs) : null;
  } catch {
    derived = null;
  }
  const score =
    res?.score && derived ? applyLiveRipCap(res.score, ripCapFor(derived.ripNow), derived.ripNow) : res?.score;
  // A total outage scores 0 only as an internal fallback (lib/score.ts); the
  // card must say "unavailable", never "Definitely not".
  const available = !!score && score.dataAvailable !== false;
  const scoreValue = available ? (score?.score ?? 0) : 0;
  const band = scoreBand(scoreValue);

  // Pick daily entries by their beach-local date, never by array position: a
  // response built before local midnight is still served after it.
  const today = localDateKey(nowMs, tz);
  const tomorrow = today ? nextDateKey(today) : undefined;
  const todayForecast = today ? snapshot?.forecast?.data?.find((f) => f.date === today) : undefined;

  let dateLabel = "";
  let timeLabel = "";
  try {
    dateLabel = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: tz,
    }).format(new Date(asOfMs));
    timeLabel = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: tz,
    }).format(new Date(asOfMs));
  } catch {
    // An unrecognized timezone (corrupt config) degrades to blank labels
    // rather than throwing the whole card away.
  }

  const subByKey = new Map((score?.subScores ?? []).map((s) => [s.key, s]));

  const tiles: ShareCardTile[] = [];
  const push = (key: string, label: string, value: string | undefined, note?: string) => {
    if (value) tiles.push(note ? { key, label, value, note } : { key, label, value });
  };

  // Fixed priority order. Each display is split at " · " into a short value
  // and a note, so a long reading ("4.8 ft · big waves") never wraps the tile.
  push("waterTemp", "Water temp", subByKey.get("waterTemp")?.display);

  const airTempNum = asNumber(subByKey.get("airTemp")?.display);
  const todayHi = todayForecast?.hi;
  push(
    "airTemp",
    "Air temp",
    airTempNum != null ? `${Math.round(airTempNum)}°F` : undefined,
    typeof todayHi === "number" ? `high ${Math.round(todayHi)}°F` : undefined,
  );

  const waves = splitDisplay(subByKey.get("waves")?.display);
  // "Est. surf" — the ESTIMATED SURF (breaking) height, not the raw buoy/model
  // reading (lib/surfHeight.ts), same wording as the WaveHeightCard.
  push("waves", "Est. surf", waves.value, waves.note);

  const rip = derived?.ripNow;
  if (rip && rip.source !== "unknown" && rip.level !== "unknown") {
    push("rip", "Rip current", capitalize(rip.level), rip.source === "alert" ? "warning in effect" : undefined);
  }

  const windDisplay = subByKey.get("wind")?.display;
  const windMatch = windDisplay?.match(/^(\d+(?:\.\d+)?\s*mph)\s*([A-Z]{1,3})?/);
  if (windMatch) push("wind", "Wind", windMatch[1], windMatch[2] ? `from ${windMatch[2]}` : undefined);
  else push("wind", "Wind", windDisplay);

  const uvDisplay = subByKey.get("uv")?.display;
  const uvNum = asNumber(uvDisplay);
  push("uv", "UV index", uvDisplay ? String(uvDisplay) : undefined, uvDisplay ? uvBand(uvNum ?? 0) : undefined);

  const sandDisplay = subByKey.get("sandTemp")?.display;
  push("sandTemp", "Sand temp", sandDisplay ? stripEstimateHedge(sandDisplay) : undefined);

  const weed = snapshot?.sargassum?.data;
  if (weed?.level && weed.level !== "unknown") {
    const pct = typeof weed.coveragePct === "number" ? `${Math.round(weed.coveragePct)}% covered` : undefined;
    push("seaweed", "Seaweed", capitalize(weed.level), pct);
  }

  // Only a genuinely live read (a level, not the night/stale "unknown" gate)
  // belongs on the card — no "yesterday" stand-in on a shareable image.
  const clarityData = snapshot?.clarity?.data;
  if (clarityData?.level) {
    push("clarity", "Water clarity", clarityDisplayWord(clarityData.level, clarityData.pct));
  }

  // Crowd only when a cam actually read the beach TODAY — busyness.data.level
  // is honestly "unknown" overnight/stale (see lib/sources/busyness.ts).
  const busynessToday = snapshot?.busyness?.data && snapshot.busyness.data.level !== "unknown";
  if (busynessToday) push("crowds", "Crowd", stripEstimateHedge(subByKey.get("crowds")?.display ?? "") || undefined);

  const sun = snapshot?.sun?.data;
  const sunsetAhead = !!sun?.sunset && Date.parse(sun.sunset) > nowMs && localDateKey(Date.parse(sun.sunset), tz) === today;

  // Today's chance of rain is a whole-day figure, so it stops being useful
  // once the day is over: it shows only until sunset.
  const todayRain = todayForecast?.rain;
  if (typeof todayRain === "number" && (sunsetAhead || !sun?.sunset)) {
    push("rain", "Rain", `${Math.round(todayRain)}%`, "chance today");
  }

  if (sunsetAhead && sun?.sunset) {
    push("sun", "Sunset", safeTime(sun.sunset, tz));
  } else {
    const nextRise = [sun?.sunrise, sun?.tomorrowSunrise].find(
      (iso): iso is string => !!iso && Date.parse(iso) > nowMs,
    );
    if (nextRise) {
      const riseDay = localDateKey(Date.parse(nextRise), tz);
      push("sun", "Sunrise", safeTime(nextRise, tz), riseDay === tomorrow ? "tomorrow" : riseDay === today ? "today" : undefined);
    }
  }

  const nextTide = snapshot?.tides?.data?.next?.find((t) => Date.parse(t.time) > nowMs);
  if (nextTide) {
    push("tide", nextTide.type === "high" ? "High tide" : "Low tide", safeTime(nextTide.time, tz));
  }

  const caps = score?.caps ?? [];
  const slug = loc?.slug ?? "";

  // The flagship beach lives at the apex ("/"), so its own "/<slug>" just
  // 301s back — show and share the clean apex link instead. Everyone else
  // gets "/<slug>". No "?ref=share" tag: a plain link reads better in a post.
  const all = listLocations();
  const flagship = all.find((l) => l.tier !== "auto") ?? all[0];
  const path = flagship && loc && loc.slug === flagship.slug ? "" : `/${slug}`;

  return {
    slug,
    beachName: loc?.name ?? "Is It Beach Day?",
    region: loc?.region ?? "",
    dateLabel,
    timeLabel,
    available,
    score: scoreValue,
    rating: available ? (score?.rating ?? "Unavailable") : "Unavailable",
    color: available ? band.color : UNAVAILABLE_COLOR,
    verdict: available ? beachDayVerdict(scoreValue) : "Conditions unavailable",
    limitedNote: available && score?.dataCoverage === "limited" ? "Limited data — some readings unavailable" : undefined,
    stale: Number.isFinite(generatedMs) && requestMs - generatedMs > CONDITIONS_MAX_STALE_MS,
    tiles: tiles.slice(0, SHARE_CARD_MAX_TILES),
    safety: safetyFor(derived, snapshot),
    ...bestTimeFields(bestTimeLabel(res, nowMs, tz, today, tomorrow)),
    changesAtMs: nextRipChange(derived?.ripNow, nowMs),
    capped: caps.length > 0,
    capNote: caps[0],
    pageUrl: `isitbeachday.com${path}`,
    shareUrl: `https://isitbeachday.com${path}`,
  };
}

/** 15 minutes normally, with up to 10 more of stale serving. Shorter, with
 *  no stale serving, when:
 *  - the conditions behind the card are already stale (60 s, so the next
 *    view draws from fresh data instead of pinning old readings);
 *  - a known rip change (alert start or end) falls inside that 25-minute
 *    window: the image then expires at the change, never under 60 s, the
 *    same minute cadence the dashboard re-resolves on. */
export function shareCacheControl(model: Pick<ShareCardModel, "changesAtMs" | "stale">, nowMs: number): string {
  const FULL = 900;
  const STALE_SERVE = 600;
  if (model.stale) return "public, max-age=60, s-maxage=60";
  const untilChange = model.changesAtMs != null ? Math.floor((model.changesAtMs - nowMs) / 1000) : Infinity;
  if (untilChange >= FULL + STALE_SERVE) {
    return `public, max-age=${FULL}, s-maxage=${FULL}, stale-while-revalidate=${STALE_SERVE}`;
  }
  const ttl = Math.min(FULL, Math.max(60, untilChange));
  return `public, max-age=${ttl}, s-maxage=${ttl}`;
}
