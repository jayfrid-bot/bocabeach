// ---------------------------------------------------------------------------
// Seasonal heads-up — an ALWAYS-ON, plain-language reference for the three
// SE-Florida ocean hazards a beachgoer might want to know the season of:
// Portuguese man-o'-war, sea lice (seabather's eruption), and sharks.
//
// This is the calm, always-visible counterpart to the exception-only advisories
// in lib/marineStinger.ts + lib/sharkContext.ts. Those two only speak when a
// LIVE signal is elevated, so a normal day showed nothing at all. This module
// instead answers the simpler question people actually ask — "is this the
// season for X?" — every day, for beaches where the science applies.
//
// DESIGN RULES:
//   - status/tone come from the MONTH WINDOW first (out-of-season -> quiet;
//     in-season -> in-season; peak sub-window -> peak).
//   - a LIVE elevation from the two advisory modules can lift a row to "watch"
//     (man-o'-war, shark) or swap in a fuller in-season line (sea lice).
//   - every row is INFORMATIONAL: no numeric risk, no probability, no "danger".
//     Sharks especially stay rarity-framed and un-alarming.
//   - the month/latitude windows are NOT redefined here — every predicate is
//     imported from marineStinger.ts / sharkContext.ts, the single source of
//     truth for each window.
// ---------------------------------------------------------------------------

import type { MarineStingerAdvisory } from "@/lib/marineStinger";
import { isManOWarSeason, isSeaLiceSeason, isSeaLicePeak } from "@/lib/marineStinger";
import type { SharkContext, SharkFactor } from "@/lib/sharkContext";
import {
  inSeUsAtlanticBand,
  inBlacktipBand,
  isMulletRunPeak,
  isMulletRunShoulder,
  isBlacktipWindow,
  isBlacktipPeak,
} from "@/lib/sharkContext";

export type HazardKey = "manowar" | "sealice" | "shark";

/** Month-window status, optionally elevated by a live signal. "quiet" =
 *  out of season; "in-season"/"peak" = the calendar window; "watch" = a live
 *  read (elevated man-o'-war, or live shark micro-factors) is worth a glance. */
export type HazardStatus = "quiet" | "in-season" | "peak" | "watch";

/** Two visual tones only: "calm" (slate) for out-of-season, "amber" for
 *  in-season / peak / watch. Never a red/danger tone — this is context, not a
 *  warning. */
export type HazardTone = "calm" | "amber";

export interface SeasonalHazardRow {
  key: HazardKey;
  /** Emoji icon, matching the exception-only advisories. */
  icon: string;
  /** Short display name, e.g. "Man-o'-war". */
  name: string;
  status: HazardStatus;
  /** <=14 chars, for the status pill. */
  statusLabel: string;
  /** One short, plain, beachgoer-voice sentence (<=90 chars). Never a number. */
  line: string;
  tone: HazardTone;
}

export interface SeasonalHazardsInput {
  /** Beach-LOCAL calendar month (1-12). */
  month: number;
  /** Beach latitude, degrees — gates whether the shark row applies at all. */
  latDeg: number;
  /** Live man-o'-war + sea-lice advisory snapshot (lib/marineStinger.ts), or
   *  null when it couldn't be computed. Only ELEVATES a row; the base status
   *  still comes from the month. */
  marineStinger: MarineStingerAdvisory | null;
  /** Live shark context (lib/sharkContext.ts), or null on a quiet day. Live
   *  micro-factors (murky water, dawn/dusk, near an inlet) lift the shark row
   *  to "watch". */
  sharkContext: SharkContext | null;
}

const STATUS_LABEL: Record<HazardStatus, string> = {
  quiet: "Out of season",
  "in-season": "In season",
  peak: "Peak season",
  watch: "Watch",
};

/** Amber for anything in-season or live; calm slate only when fully quiet. */
function toneFor(status: HazardStatus): HazardTone {
  return status === "quiet" ? "calm" : "amber";
}

// --- Man-o'-war --------------------------------------------------------------

function manOWarRow(month: number, ms: MarineStingerAdvisory | null): SeasonalHazardRow {
  const liveLevel = ms?.manOWar?.level;
  const elevated = liveLevel === "elevated" || liveLevel === "high";

  let status: HazardStatus;
  let line: string;
  if (elevated) {
    status = "watch";
    line = "Reported nearby after onshore winds — watch for the purple flag.";
  } else if (isManOWarSeason(month)) {
    status = "in-season";
    line = "Winter is their season here — more likely after a cold front with onshore wind.";
  } else {
    status = "quiet";
    line = "Rare this time of year — they blow in on winter cold fronts.";
  }

  return {
    key: "manowar",
    icon: "🪼",
    name: "Man-o'-war",
    status,
    statusLabel: STATUS_LABEL[status],
    line,
    tone: toneFor(status),
  };
}

// --- Sea lice ----------------------------------------------------------------

function seaLiceRow(month: number, ms: MarineStingerAdvisory | null): SeasonalHazardRow {
  const liveLevel = ms?.seaLice?.level;
  // "possible"/"elevated" during the season means warm water is favoring the
  // larvae now — swap in the fuller line, but keep the calendar status.
  const fuller = liveLevel === "possible" || liveLevel === "elevated";

  let status: HazardStatus;
  let line: string;
  if (!isSeaLiceSeason(month)) {
    status = "quiet";
    line = "Not their season — very unlikely right now.";
  } else if (isSeaLicePeak(month)) {
    status = "peak";
    line = fuller
      ? "Peak season (May–Jun) and water's warm — rinse off and rinse your suit."
      : "Peak season (May–Jun) — the larvae that cause swimmer's itch. Rinse off.";
  } else {
    status = "in-season";
    line = fuller
      ? "In season (Mar–Aug) and water's warm — rinse off and rinse your suit after."
      : "In season here (Mar–Aug) — the odd itchy patch under swimwear. Rinse off.";
  }

  return {
    key: "sealice",
    icon: "🦠",
    name: "Sea lice",
    status,
    statusLabel: STATUS_LABEL[status],
    line,
    tone: toneFor(status),
  };
}

// --- Sharks ------------------------------------------------------------------

/** A short live-conditions line for the "watch" state, keyed off which
 *  micro-factors the shark-context module flagged. Never alarm. */
function sharkWatchLine(factors: SharkFactor[]): string {
  const murky = factors.includes("murky water");
  const lowLight = factors.includes("dawn/dusk");
  if (murky && lowLight) {
    return "Murkier water and low-light hours now — usual dawn/dusk caution.";
  }
  if (murky) {
    return "Murkier water than usual right now — usual water-smart caution.";
  }
  if (lowLight) {
    return "Low-light dawn/dusk hours — sharks and prey more active; usual caution.";
  }
  // near inlet only
  return "Right by an inlet — a natural funnel for baitfish; usual caution.";
}

/** Calendar-only season classification for sharks. Mullet run applies across
 *  the whole SE-US Atlantic band; the winter blacktip aggregation only inside
 *  its narrow latitude band. Deliberately calendar-first (no water-temp gate) —
 *  the live sharkContext handles the corroborated "watch" case. */
function sharkSeasonStatus(
  month: number,
  latDeg: number,
): { status: Exclude<HazardStatus, "watch">; line: string } {
  if (isMulletRunPeak(month)) {
    return {
      status: "peak",
      line: "Fall mullet run — baitfish and predators move close to shore; usual care.",
    };
  }
  if (isMulletRunShoulder(month)) {
    return {
      status: "in-season",
      line: "Mullet-run season — baitfish pull sharks closer to shore; usual care.",
    };
  }
  if (inBlacktipBand(latDeg) && isBlacktipWindow(month)) {
    return isBlacktipPeak(month)
      ? { status: "peak", line: "Blacktip season — they gather near shore in winter; usual care." }
      : { status: "in-season", line: "Winter blacktip season — more sharks near shore; usual care." };
  }
  return { status: "quiet", line: "Nothing seasonal now — normal water-smart caution." };
}

/** The shark row, or null when the beach's latitude is outside the SE-US
 *  Atlantic band entirely — then the seasonal shark science genuinely doesn't
 *  apply, so no row is shown at all. */
function sharkRow(month: number, latDeg: number, shark: SharkContext | null): SeasonalHazardRow | null {
  if (!inSeUsAtlanticBand(latDeg)) return null;

  let status: HazardStatus;
  let line: string;
  // Live micro-factors (not just the season the panel already names) lift the
  // row to "watch".
  if (shark && shark.factors.length > 0) {
    status = "watch";
    line = sharkWatchLine(shark.factors);
  } else {
    ({ status, line } = sharkSeasonStatus(month, latDeg));
  }

  return {
    key: "shark",
    icon: "🦈",
    name: "Sharks",
    status,
    statusLabel: STATUS_LABEL[status],
    line,
    tone: toneFor(status),
  };
}

// --- Public API --------------------------------------------------------------

/**
 * The ordered [man-o'-war, sea lice, shark] rows for the always-on seasonal
 * heads-up panel. Exactly three rows for an in-band SE-Florida beach; the shark
 * row is dropped for an Atlantic beach north/south of the SE-US band, where the
 * seasonal shark science doesn't apply (man-o'-war and sea lice still do).
 *
 * SCOPE: the CALLER decides which beaches get this panel at all (SE-US-Atlantic-
 * oriented only — see lib/conditions.ts / ConditionsDashboard). This function
 * itself only classifies month + latitude; it never checks coastline.
 */
export function seasonalHazards(input: SeasonalHazardsInput): SeasonalHazardRow[] {
  const { month, latDeg, marineStinger, sharkContext } = input;
  const rows: SeasonalHazardRow[] = [
    manOWarRow(month, marineStinger),
    seaLiceRow(month, marineStinger),
  ];
  const shark = sharkRow(month, latDeg, sharkContext);
  if (shark) rows.push(shark);
  return rows;
}
