// ---------------------------------------------------------------------------
// Hourly rip-current risk curve: turns the National Weather Service's ONE
// daily word (low / moderate / high, from the Surf Zone Forecast — see
// lib/sources/nws.ts's parseRipRisk -> NwsData.ripCurrentRisk) into an honest
// hour-by-hour shape across today's daylight.
//
// ANCHOR RULE (the whole design in one sentence): the official NWS word sets
// a numeric BAND (floor + ceiling) for the day; this module only ever picks a
// NUMBER inside that band, modulated by wave energy, tide phase, and (minor)
// onshore wind chop. It NEVER contradicts the official word — every hour's
// `band` field always equals the day's `officialLevel`, so a "moderate" day
// can read anywhere from a quiet 30 to a tense 65, but it can never claim to
// be a "high" day and it can never claim to be calmer than a genuine "low"
// day would be (see BAND_RANGE below).
//
// HONESTY RULES:
//  - No official word (`"unknown"`, e.g. the SRF product didn't match this
//    zone, or the feed is down) -> `null`. Never invent a curve with no
//    anchor to modulate.
//  - No wave forecast AND no tide events -> a flat curve at the band's
//    midpoint, with a `peakNote` that says so plainly. Still real numbers
//    (the anchor is real), just honestly un-shaped rather than silently
//    guessing a peak time we have no basis for.
//  - This module is PURELY INFORMATIONAL. It does not feed the Beach Day
//    score — lib/score.ts's existing rip-current CAP (High -> 85, Moderate
//    -> 92) remains the only place rip risk touches the score, untouched by
//    this file. See RipRiskCard's flip-back copy for the same disclaimer
//    surfaced to users: this is an estimate layered on the official NWS
//    level, and lifeguard flags are the real-time authority.
// ---------------------------------------------------------------------------

import type { RipRisk, TideEvent } from "@/lib/types";
import { clamp, round } from "@/lib/util";

const HOUR_MS = 3_600_000;

// --- Public shapes -----------------------------------------------------

/** Rip risk never reads "unknown" once it has cleared the honest-null gate. */
export type BandedRipRisk = Exclude<RipRisk, "unknown">;

/** One hourly wave sample (marine forecast) — height and dominant/swell period. */
export interface RipRiskWaveSample {
  /** ISO timestamp (UTC). */
  time: string;
  waveHeightFt?: number;
  /** Dominant or swell wave period, seconds. Longer period = more energy at
   *  the same height (a slow, powerful groundswell pulls harder than wind
   *  chop of the same size) — see waveFactorAt. */
  wavePeriodS?: number;
}

/** One hourly wind sample — only used for the minor onshore-chop nudge. */
export interface RipRiskWindSample {
  /** ISO timestamp (UTC). */
  time: string;
  windSpeedMph?: number;
  /** Direction the wind blows FROM, degrees (0=N, 90=E, ...). */
  windDirDeg?: number;
}

export interface RipRiskCurveInput {
  /** Today's official NWS Surf Zone Forecast rip-current word. The curve
   *  anchors to this and never contradicts it. `"unknown"` (missing/unmatched
   *  SRF) returns `null` — see the module banner comment. */
  officialLevel: RipRisk;
  /** Today's sunrise (ISO UTC) — the daylight window's start. */
  sunriseIso: string;
  /** Today's sunset (ISO UTC) — the daylight window's end. */
  sunsetIso: string;
  /** Hourly wave height + period forecast. Optional; entirely absent (along
   *  with `tideEvents`) is one of the two "flatten to the band midpoint"
   *  triggers — see the module banner comment. */
  waves?: RipRiskWaveSample[];
  /** Upcoming tide hi/lo events — the same shape as TideData.next from
   *  lib/sources/tides.ts. Optional; entirely absent (along with `waves`) is
   *  the other "flatten to the band midpoint" trigger. */
  tideEvents?: TideEvent[];
  /** Optional hourly wind — a MINOR onshore-chop nudge only. Needs
   *  `coastNormalDeg` to mean anything; ignored without it. */
  wind?: RipRiskWindSample[];
  /** Compass bearing wind blows FROM when blowing straight onshore at this
   *  beach — same convention as lib/marineStinger.ts's `coastNormalDeg`. */
  coastNormalDeg?: number;
  /** IANA timezone for the peakNote's clock text, e.g. "America/New_York". */
  tz: string;
}

export interface RipRiskHour {
  /** ISO timestamp (UTC), top of the hour. */
  t: string;
  /** 0-100, always inside `officialLevel`'s band (see BAND_RANGE). */
  score: number;
  /** Always equals the day's `officialLevel` — modulation moves the NUMBER,
   *  never the WORD. */
  band: BandedRipRisk;
}

export interface RipRiskCurve {
  /** Today's daylight hours (sunrise's bucket through sunset's), oldest first.
   *  EMPTY when `unshaped` — there were no usable wave/tide inputs to place an
   *  hourly curve, so no numbers are invented (see `unshaped`). */
  hours: RipRiskHour[];
  /** Always present, never silent. Either names the riskiest window (e.g.
   *  "riskiest 2-4 PM around low tide") or, when there's no wave/tide detail
   *  to shape the day with, says plainly that hourly detail is unavailable. */
  peakNote: string;
  /** The official NWS band word for today — always present, even when
   *  `unshaped` (no hourly curve). Equals every `hours[i].band` when shaped. */
  level: BandedRipRisk;
  /** True when NO usable wave sample (height AND period) and NO tide events were
   *  available to shape the day: the card shows the official word + "hourly
   *  detail unavailable" and NO numeric curve, rather than fabricating a flat
   *  band-midpoint number that reads as false precision. */
  unshaped: boolean;
}

// --- Band map (the anchor rule) -----------------------------------------

/** Official-word -> numeric floor/ceiling for the day. Explicit map per spec:
 *  the official word sets where the curve LIVES; modulation only moves the
 *  number within it. moderate and high share the same 35-pt width on purpose
 *  — for any given modulation fraction f, high(f) = moderate(f) + 30 always,
 *  so a moderate day can never numerically read as a high day. */
export const BAND_RANGE: Record<BandedRipRisk, { min: number; max: number }> = {
  low: { min: 5, max: 35 },
  moderate: { min: 30, max: 65 },
  high: { min: 60, max: 95 },
};

// --- Modulation weights + neutral fallback ------------------------------

/** Wave energy (height x period) is the dominant modulator; tide phase is
 *  substantial; onshore wind chop is explicitly a MINOR nudge. Sums to 1. */
const WAVE_WEIGHT = 0.55;
const TIDE_WEIGHT = 0.35;
const WIND_WEIGHT = 0.1;

/** When a factor's underlying data isn't available for a given hour, assume
 *  a neutral/typical middling contribution rather than dragging the curve to
 *  either extreme — "we don't know" should never read as "definitely calm"
 *  or "definitely dangerous". */
const NEUTRAL = 0.5;

/** A sample only counts for an hour if it falls within this many minutes of
 *  it — matching hourly-cadence forecasts land at 0, but this tolerates a
 *  slightly offset feed without silently going neutral. */
const MATCH_WINDOW_MIN = 90;

// --- Wave energy ---------------------------------------------------------

/**
 * Wave energy (height ft x period s) -> 0-1 modulation factor. Anchors are a
 * plain-English proxy, not a physical flux model: 0 energy still gets a small
 * floor (calm water is never literally zero rip risk), and a big long-period
 * groundswell (e.g. 4 ft @ 14 s = 56) saturates near the top.
 */
const WAVE_ENERGY_ANCHORS: [number, number][] = [
  [0, 0.15],
  [6, 0.35],
  [14, 0.6],
  [24, 0.85],
  [40, 1],
];

/** Small dependency-free piecewise-linear interpolator, same convention as
 *  lib/marineStinger.ts's `lerpCurve` — duplicated on purpose so this module
 *  stays an isolated, independently-testable unit. */
function lerpCurve(x: number, anchors: [number, number][]): number {
  if (x <= anchors[0][0]) return anchors[0][1];
  const last = anchors[anchors.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < anchors.length; i++) {
    const [x1, y1] = anchors[i];
    if (x <= x1) {
      const [x0, y0] = anchors[i - 1];
      return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return last[1];
}

/** Nearest sample to `tMs` within MATCH_WINDOW_MIN that passes `valid`, or
 *  `null` when the array is empty/undefined or nothing qualifies nearby. */
function nearestWithin<T extends { time: string }>(
  tMs: number,
  arr: T[] | undefined,
  valid: (item: T) => boolean,
): T | null {
  if (!arr || !arr.length) return null;
  let best: T | null = null;
  let bestDist = Infinity;
  for (const item of arr) {
    if (!valid(item)) continue;
    const itemMs = Date.parse(item.time);
    if (!Number.isFinite(itemMs)) continue;
    const dist = Math.abs(itemMs - tMs);
    if (dist <= MATCH_WINDOW_MIN * 60_000 && dist < bestDist) {
      bestDist = dist;
      best = item;
    }
  }
  return best;
}

function waveFactorAt(tMs: number, waves: RipRiskWaveSample[] | undefined): number {
  const match = nearestWithin(
    tMs,
    waves,
    (w) => w.waveHeightFt != null && w.wavePeriodS != null,
  );
  if (!match) return NEUTRAL;
  const energy = Math.max(0, match.waveHeightFt as number) * Math.max(0, match.wavePeriodS as number);
  return lerpCurve(energy, WAVE_ENERGY_ANCHORS);
}

// --- Tide phase ------------------------------------------------------------

/** Half-width of the "around low tide" bump, in minutes (spec: "the 2h
 *  around low tide"). */
const LOW_TIDE_BUMP_MIN = 120;

/** SE-Florida's typical tidal range (ft), used to normalize how "strong" an
 *  outgoing (high -> low) leg is — a bigger swing than typical means faster
 *  water movement, hence more outgoing-flow risk. */
const TYPICAL_TIDE_RANGE_FT = 2.5;

interface SortedTideEvent {
  type: "high" | "low";
  t: number;
  heightFt: number;
}

function toSortedTideEvents(tideEvents: TideEvent[] | undefined): SortedTideEvent[] {
  if (!tideEvents || !tideEvents.length) return [];
  return tideEvents
    .map((e) => ({ type: e.type, t: Date.parse(e.time), heightFt: e.heightFt }))
    .filter((e) => Number.isFinite(e.t))
    .sort((a, b) => a.t - b.t);
}

/** How close `tMs` is to any LOW tide event, 0 (>= LOW_TIDE_BUMP_MIN away) to
 *  1 (exactly at a low). */
function lowTideProximity(tMs: number, sorted: SortedTideEvent[]): number {
  let best = 0;
  for (const e of sorted) {
    if (e.type !== "low") continue;
    const distMin = Math.abs(tMs - e.t) / 60_000;
    if (distMin <= LOW_TIDE_BUMP_MIN) best = Math.max(best, 1 - distMin / LOW_TIDE_BUMP_MIN);
  }
  return best;
}

/**
 * Strength of an outgoing (falling, high -> low) tide at `tMs`, 0-1. Real
 * tidal flow is fastest at MID-tide (roughly a cosine's steepest point, not
 * at the turning points), so this peaks at the midpoint of a falling leg and
 * is scaled by how much bigger that leg's range is than a typical SE-FL swing.
 */
function outgoingFlowFactor(tMs: number, sorted: SortedTideEvent[]): number {
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (a.type === "high" && b.type === "low" && tMs >= a.t && tMs <= b.t && b.t > a.t) {
      const f = (tMs - a.t) / (b.t - a.t);
      const shape = Math.sin(Math.PI * f); // 0 at each turning point, 1 at mid-leg
      const rangeFt = Math.abs(a.heightFt - b.heightFt);
      const strength = clamp(rangeFt / TYPICAL_TIDE_RANGE_FT, 0, 1);
      return shape * strength;
    }
  }
  return 0;
}

/** The ±2h-around-low window is the headline mechanism (and what peakNote
 *  names); a strong mid-ebb outgoing flow is real but secondary, so it's
 *  damped below what a genuine low-tide window can reach — otherwise a big
 *  tidal swing could out-bump the low itself and the peak would land at an
 *  odd mid-ebb hour instead of "around low tide". */
const OUTGOING_FLOW_DAMPING = 0.7;

function tideFactorAt(tMs: number, sorted: SortedTideEvent[]): number {
  if (!sorted.length) return NEUTRAL;
  const bump = Math.max(
    lowTideProximity(tMs, sorted),
    OUTGOING_FLOW_DAMPING * outgoingFlowFactor(tMs, sorted),
  );
  // Tide only ever RAISES risk above neutral here (there's no "extra safe"
  // tide phase in this model, just "not currently near a low/falling fast").
  return clamp(NEUTRAL + bump * (1 - NEUTRAL), 0, 1);
}

// --- Onshore wind chop (minor) ---------------------------------------------

/** Onshore mph at which the chop nudge saturates to its max (1.0). */
const WIND_SATURATE_MPH = 20;

function windFactorAt(
  tMs: number,
  wind: RipRiskWindSample[] | undefined,
  coastNormalDeg: number | undefined,
): number {
  if (coastNormalDeg == null) return NEUTRAL;
  const match = nearestWithin(tMs, wind, (w) => w.windSpeedMph != null && w.windDirDeg != null);
  if (!match) return NEUTRAL;
  const rad = ((match.windDirDeg as number) - coastNormalDeg) * (Math.PI / 180);
  const onshoreMph = (match.windSpeedMph as number) * Math.max(0, Math.cos(rad));
  return clamp(onshoreMph / WIND_SATURATE_MPH, 0, 1);
}

// --- Daylight hour buckets -------------------------------------------------

/** Same bucket rule as lib/score.ts's computeHourlyScores: the top-of-hour
 *  bucket containing sunrise, through the last bucket at/before sunset. */
function daylightHourBuckets(sunriseMs: number, sunsetMs: number): string[] {
  const start = Math.floor(sunriseMs / HOUR_MS) * HOUR_MS;
  const out: string[] = [];
  for (let t = start; t <= sunsetMs; t += HOUR_MS) out.push(new Date(t).toISOString());
  return out;
}

// --- peakNote formatting ----------------------------------------------------

function hourParts(ms: number, tz: string): { hour: string; period: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: true,
    timeZone: tz,
  }).formatToParts(new Date(ms));
  const hour = parts.find((p) => p.type === "hour")?.value ?? "";
  const period = (parts.find((p) => p.type === "dayPeriod")?.value ?? "").toUpperCase();
  return { hour, period };
}

/** "2-4 PM" when both ends share a period, "11 AM-1 PM" when they don't. */
function rangeLabel(startMs: number, endMs: number, tz: string): string {
  const a = hourParts(startMs, tz);
  const b = hourParts(endMs, tz);
  if (a.period === b.period) return `${a.hour}-${b.hour} ${b.period}`;
  return `${a.hour} ${a.period}-${b.hour} ${b.period}`;
}

/** The per-hour modulation breakdown, captured so the peak hour can be
 *  attributed to the factor that ACTUALLY drove it (not merely "waves exist"). */
interface HourFactors {
  wv: number;
  td: number;
  wd: number;
  /** A real, usable wave sample (BOTH height and period) matched this hour —
   *  only then may the peak be worded "as today's swell peaks". */
  usableWave: boolean;
}

function peakReason(peakMs: number, sortedTide: SortedTideEvent[], parts: HourFactors): string {
  const nearLow = sortedTide.some(
    (e) => e.type === "low" && Math.abs(peakMs - e.t) <= LOW_TIDE_BUMP_MIN * 60_000,
  );
  if (nearLow) return "around low tide";

  // Which factor actually LIFTED this hour above the rest? Compare each factor's
  // weighted contribution ABOVE neutral; the largest positive one is the driver.
  // Waves count ONLY when a usable sample (height AND period) drove the hour — a
  // bare non-empty array must never be reported as "as today's swell peaks"
  // (the wave factor falls back to neutral without a usable sample).
  const waveDelta = parts.usableWave ? WAVE_WEIGHT * (parts.wv - NEUTRAL) : 0;
  const tideDelta = TIDE_WEIGHT * (parts.td - NEUTRAL);
  const windDelta = WIND_WEIGHT * (parts.wd - NEUTRAL);

  const max = Math.max(waveDelta, tideDelta, windDelta);
  if (max <= 0) return "under today's official rip risk"; // nothing meaningfully elevated
  if (max === tideDelta) return "as the tide runs out";
  if (max === waveDelta) return "as today's swell peaks";
  return "with the onshore wind chop up";
}

function degradedNote(level: BandedRipRisk): string {
  return (
    `Wave and tide detail aren't available right now — this is a flatter estimate anchored ` +
    `to the National Weather Service's official ${level} rip-current risk for today.`
  );
}

// --- Main --------------------------------------------------------------

/**
 * Build today's hourly rip-current risk curve. Pure: no fetching, no clock
 * reads — everything comes from `input`. See the module banner comment for
 * the anchor rule and honesty rules; `null` only ever means "no official
 * word to anchor to" or "no daylight hours to show" — never "computation
 * failed silently".
 */
export function ripRiskCurve(input: RipRiskCurveInput): RipRiskCurve | null {
  const { officialLevel, sunriseIso, sunsetIso, waves, tideEvents, wind, coastNormalDeg, tz } = input;

  // Honest-null: never invent a curve with no anchor.
  if (officialLevel === "unknown") return null;
  const level: BandedRipRisk = officialLevel;

  const sunriseMs = Date.parse(sunriseIso);
  const sunsetMs = Date.parse(sunsetIso);
  if (!Number.isFinite(sunriseMs) || !Number.isFinite(sunsetMs) || sunsetMs <= sunriseMs) return null;

  const hourIsos = daylightHourBuckets(sunriseMs, sunsetMs);
  if (!hourIsos.length) return null;

  const range = BAND_RANGE[level];
  // A USABLE wave sample needs BOTH height and period — a non-empty array of
  // height-only (or period-only) samples can't shape anything, so it doesn't
  // count as a shaping input (and never drives the peak wording — see peakReason).
  const hasUsableWaves =
    !!waves && waves.some((w) => w.waveHeightFt != null && w.wavePeriodS != null);
  const hasTide = !!tideEvents && tideEvents.length > 0;
  const sortedTide = toSortedTideEvents(tideEvents);

  // Fully degraded: no usable wave sample AND no tide events to shape the day
  // with. Return an UNSHAPED result — the official NWS word with NO numeric
  // curve — rather than inventing a flat band-midpoint number (which read as
  // false precision "42/100 right now" off a single daily word). An onshore-
  // wind-only signal (a MINOR factor by design) isn't enough to shape a curve.
  if (!hasUsableWaves && !hasTide) {
    return {
      hours: [],
      peakNote: degradedNote(level),
      level,
      unshaped: true,
    };
  }

  let peakIdx = 0;
  let peakScore = -Infinity;
  const parts: HourFactors[] = [];
  const hours: RipRiskHour[] = hourIsos.map((iso, i) => {
    const tMs = Date.parse(iso);
    const usableWave =
      nearestWithin(tMs, waves, (w) => w.waveHeightFt != null && w.wavePeriodS != null) != null;
    const wv = waveFactorAt(tMs, waves);
    const td = tideFactorAt(tMs, sortedTide);
    const wd = windFactorAt(tMs, wind, coastNormalDeg);
    parts.push({ wv, td, wd, usableWave });
    const factor = clamp(WAVE_WEIGHT * wv + TIDE_WEIGHT * td + WIND_WEIGHT * wd, 0, 1);
    const score = round(range.min + factor * (range.max - range.min));
    if (score > peakScore) {
      peakScore = score;
      peakIdx = i;
    }
    return { t: iso, score, band: level };
  });

  const peakMs = Date.parse(hourIsos[peakIdx]);
  const windowEndMs = Math.min(peakMs + 2 * HOUR_MS, sunsetMs > peakMs ? sunsetMs : peakMs + 2 * HOUR_MS);
  const reason = peakReason(peakMs, sortedTide, parts[peakIdx]);
  const peakNote = `riskiest ${rangeLabel(peakMs, windowEndMs, tz)} ${reason}`;

  return { hours, peakNote, level, unshaped: false };
}
