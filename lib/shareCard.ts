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

export interface ShareCardTile {
  key: string;
  label: string;
  value: string;
}

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
  /** Up to six metric tiles, in priority order, data-permitting. */
  tiles: ShareCardTile[];
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
  const push = (key: string, label: string, value: string | undefined) => {
    if (value) tiles.push({ key, label, value });
  };

  // Fixed priority order: Water temp, Air temp, Water clarity, Sand temp,
  // Waves, UV fill the six slots when their data is in; Wind and Crowd only
  // step in as fallbacks for a slot one of those six left empty.
  push("waterTemp", "Water temp", subByKey.get("waterTemp")?.display);

  const airTempNum = asNumber(subByKey.get("airTemp")?.display);
  push("airTemp", "Air temp", airTempNum != null ? `${Math.round(airTempNum)}°F` : undefined);

  // Only a genuinely live read (a level, not the night/stale "unknown" gate)
  // belongs on the card — no "yesterday" stand-in on a shareable image.
  const clarityData = snapshot?.clarity?.data;
  if (clarityData?.level) {
    push("clarity", "Water clarity", clarityDisplayWord(clarityData.level, clarityData.pct));
  }

  const sandDisplay = subByKey.get("sandTemp")?.display;
  push("sandTemp", "Sand temp", sandDisplay ? stripEstimateHedge(sandDisplay) : undefined);

  push("waves", "Waves", subByKey.get("waves")?.display);

  const uvDisplay = subByKey.get("uv")?.display;
  const uvNum = asNumber(uvDisplay);
  push("uv", "UV index", uvDisplay ? `${uvDisplay} · ${uvBand(uvNum ?? 0)}` : undefined);

  if (tiles.length < 6) {
    push("wind", "Wind", subByKey.get("wind")?.display);
  }

  // Crowd only steps in when a cam actually read the beach TODAY —
  // busyness.data.level is honestly "unknown" overnight/stale (see
  // lib/sources/busyness.ts).
  if (tiles.length < 6) {
    const busynessToday = snapshot?.busyness?.data && snapshot.busyness.data.level !== "unknown";
    if (busynessToday) {
      push("crowds", "Crowd", subByKey.get("crowds")?.display);
    }
  }

  const caps = score?.caps ?? [];
  const slug = loc?.slug ?? "";

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
    tiles: tiles.slice(0, 6),
    capped: caps.length > 0,
    capNote: caps[0],
    pageUrl: `isitbeachday.com/${slug}`,
    shareUrl: `https://isitbeachday.com/${slug}?ref=share`,
  };
}
