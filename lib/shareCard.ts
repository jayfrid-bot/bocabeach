// Pure view-model for the shareable social card (app/api/share/[slug]/route.tsx).
//
// Picks the handful of numbers a person standing on the sand would actually
// want to show off, in a fixed priority order, and drops any tile whose data
// isn't in today's snapshot. Never throws — every field reads from an
// optional chain, so an empty/degraded ConditionsResponse still produces a
// valid (mostly empty) model rather than sinking the image route.

import type { ConditionsResponse, FlagColor } from "@/lib/types";
import { scoreBand } from "@/lib/scoreBands";
import { beachDayVerdict } from "@/lib/format";
import { uvBand } from "@/lib/uv";

export interface ShareCardTile {
  key: string;
  label: string;
  value: string;
}

export interface ShareCardFlag {
  color: FlagColor;
  label: string;
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
  /** Posted lifeguard flags, worded for a caption (never "unknown"). */
  flags: ShareCardFlag[];
  capped: boolean;
  /** Why the score was capped, when it was. */
  capNote?: string;
  /** "isitbeachday.com/<slug>" — for on-card display. */
  pageUrl: string;
  /** The tracked link the QR code and "see more" line point to. */
  shareUrl: string;
}

const FLAG_LABELS: Record<FlagColor, string> = {
  green: "Green flag",
  yellow: "Yellow flag",
  red: "Red flag",
  "double-red": "Double red — water closed",
  purple: "Purple flag — marine pests",
  unknown: "Flag unknown",
};

/** Safe number formatter: never throws on NaN/undefined. */
function asNumber(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : undefined;
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

  push("waterTemp", "Water temp", subByKey.get("waterTemp")?.display);
  push("sandTemp", "Sand temp", subByKey.get("sandTemp")?.display);
  push("waves", "Waves", subByKey.get("waves")?.display);

  const uvDisplay = subByKey.get("uv")?.display;
  const uvNum = asNumber(uvDisplay);
  push("uv", "UV index", uvDisplay ? `${uvDisplay} · ${uvBand(uvNum ?? 0)}` : undefined);

  push("wind", "Wind", subByKey.get("wind")?.display);

  // Crowd only stands in for the 6th tile when a cam actually read the beach
  // TODAY — busyness.data.level is honestly "unknown" overnight/stale (see
  // lib/sources/busyness.ts), which is exactly the case Air temp should cover.
  const busynessToday = snapshot?.busyness?.data && snapshot.busyness.data.level !== "unknown";
  if (busynessToday) {
    push("crowds", "Crowd", subByKey.get("crowds")?.display);
  } else {
    push("airTemp", "Air temp", subByKey.get("airTemp")?.display);
  }

  const flags: ShareCardFlag[] = (snapshot?.cityOfficial?.data?.flags ?? [])
    .filter((f): f is Exclude<FlagColor, "unknown"> => f !== "unknown")
    .map((f) => ({ color: f, label: FLAG_LABELS[f] }));

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
    flags,
    capped: caps.length > 0,
    capNote: caps[0],
    pageUrl: `isitbeachday.com/${slug}`,
    shareUrl: `https://isitbeachday.com/${slug}?ref=share`,
  };
}
