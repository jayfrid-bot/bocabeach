// Pure view-model for the shareable social card (app/api/share/[slug]/route.tsx).
//
// Picks the handful of numbers a person standing on the sand would actually
// want to show off, in a fixed priority order, and drops any tile whose data
// isn't in today's snapshot. Never throws — every field reads from an
// optional chain, so an empty/degraded ConditionsResponse still produces a
// valid (mostly empty) model rather than sinking the image route.

import type { ConditionsResponse } from "@/lib/types";
import { scoreBand } from "@/lib/scoreBands";
import { beachDayVerdict } from "@/lib/format";
import { uvBand } from "@/lib/uv";
import { clarityDisplayWord } from "@/lib/sources/clarity";
import { listLocations } from "@/config/locations";
import { deriveMetrics } from "@/lib/score";
import { swimSafety, type SwimSafetyLevel } from "@/lib/safetyLine";
import { fmtTime } from "@/lib/format";

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
  /** "Mon Sep 14", local to the beach. */
  dateLabel: string;
  /** "4:08 PM", local to the beach. */
  timeLabel: string;
  score: number;
  rating: string;
  /** Accent hex for the rating band (see lib/scoreBands.ts). */
  color: string;
  /** One-line headline, e.g. "Yes — good beach day". */
  verdict: string;
  /** Up to SHARE_CARD_MAX_TILES metric tiles, in priority order, data-permitting. */
  tiles: ShareCardTile[];
  /** Can you get in the water — the same call the app's safety line makes. */
  safety: { level: SwimSafetyLevel; label: string; reasons: string[] };
  /** "Best time today: 5–7 PM", or tomorrow's once today's window has passed. */
  bestTime?: string;
  capped: boolean;
  /** Why the score was capped, when it was. */
  capNote?: string;
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
  safe: "Safe to swim",
  caution: "Swim with caution",
  "stay-out": "Stay out of the water",
};

function safetyFor(
  derived: ReturnType<typeof deriveMetrics> | null,
  snapshot: ConditionsResponse["snapshot"] | undefined,
): ShareCardModel["safety"] {
  if (!derived) return { level: "safe", label: "", reasons: [] };
  const line = swimSafety(derived, snapshot);
  return { level: line.level, label: SAFETY_LABEL[line.level], reasons: line.reasons.slice(0, 2) };
}

/** Today's best window while it is still ahead, else tomorrow's. A window
 *  already under way reads "until 12 PM" rather than starting at an odd
 *  minute like "10:59 AM". */
function bestTimeLabel(res: ConditionsResponse | null | undefined, nowMs: number, tz: string): string | undefined {
  const days = res?.multiDayWindows ?? [];
  const pick = (i: number, word: string) => {
    const best = days[i]?.best;
    if (!best || Date.parse(best.endIso) <= nowMs) return undefined;
    const b = safeHourLabel(best.endIso, tz);
    if (!b) return undefined;
    if (Date.parse(best.startIso) <= nowMs) return `Best time ${word}: now until ${b}`;
    const a = safeHourLabel(best.startIso, tz);
    if (!a) return undefined;
    return `Best time ${word}: ${a === b ? a : `${a}–${b}`}`;
  };
  return pick(0, "today") ?? pick(1, "tomorrow");
}

/** "5 PM" / "5:30 PM". */
function safeHourLabel(iso: string, tz: string): string | undefined {
  const t = safeTime(iso, tz);
  return t?.replace(":00 ", " ");
}

export function shareCardModel(
  res: ConditionsResponse | null | undefined,
  nowMs: number = Date.now(),
): ShareCardModel {
  const snapshot = res?.snapshot;
  const score = res?.score;
  const loc = snapshot?.location;
  const tz = loc?.timezone || "America/New_York";
  const scoreValue = score?.score ?? 0;
  const band = scoreBand(scoreValue);

  let dateLabel = "";
  let timeLabel = "";
  try {
    dateLabel = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: tz,
    }).format(new Date(nowMs));
    timeLabel = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: tz,
    }).format(new Date(nowMs));
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
  const todayHi = snapshot?.forecast?.data?.[0]?.hi;
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

  let derived: ReturnType<typeof deriveMetrics> | null = null;
  try {
    derived = snapshot ? deriveMetrics(snapshot, nowMs) : null;
  } catch {
    derived = null;
  }
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

  const todayRain = snapshot?.forecast?.data?.[0]?.rain;
  if (typeof todayRain === "number") push("rain", "Rain", `${Math.round(todayRain)}%`, "chance today");

  const sun = snapshot?.sun?.data;
  if (sun?.sunset && Date.parse(sun.sunset) > nowMs) push("sun", "Sunset", safeTime(sun.sunset, tz));
  else if (sun?.tomorrowSunrise) push("sun", "Sunrise", safeTime(sun.tomorrowSunrise, tz), "tomorrow");

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
    score: scoreValue,
    rating: score?.rating ?? "Unavailable",
    color: band.color,
    verdict: beachDayVerdict(scoreValue),
    tiles: tiles.slice(0, SHARE_CARD_MAX_TILES),
    safety: safetyFor(derived, snapshot),
    bestTime: bestTimeLabel(res, nowMs, tz),
    capped: caps.length > 0,
    capNote: caps[0],
    pageUrl: `isitbeachday.com${path}`,
    shareUrl: `https://isitbeachday.com${path}`,
  };
}
