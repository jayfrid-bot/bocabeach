// ---------------------------------------------------------------------------
// Marine stinger advisory: Portuguese man-o'-war (Physalia physalis) stranding
// risk + seabather's eruption ("sea lice", Linuche unguiculata larvae) season.
// Two INDEPENDENT, scientifically distinct phenomena — never blended into one
// score:
//
//   MAN-O'-WAR strands via SUSTAINED ONSHORE WIND with a ~1-day lag. Physalia
//   is unusual among cnidarians in that it carries a gas-filled float ("sail")
//   held above the surface, so it is driven directly by wind stress (not just
//   currents) — it sails downwind at roughly 45° across the true wind. That is
//   the mechanism behind onshoreComponent() below: only the wind component
//   blowing straight onshore can push a sailing float up the beach.
//
//   Wind is NECESSARY, NOT SUFFICIENT: the animals have to already be
//   offshore for wind to matter. Published wind-only stranding studies land
//   only ~16-24% next-day hit rates — so a wind-only read is capped and
//   labeled low-confidence here, never presented as a forecast. A live,
//   nearby, recent iNaturalist sighting is the honesty upgrade: it turns
//   "wind says possible" into "confirmed nearby", and a checked-and-empty
//   sightings feed turns it into "checked, nothing recent" — genuinely
//   informative in the OTHER direction. See lib/sources/stingerSightings.ts.
//
//   Man-o'-war season in SE Florida is ~Nov-Apr (winter cold fronts drive the
//   sustained easterlies) — outside that window the SAME wind gets a much
//   softer read (see `OFF_SEASON_FACTOR`).
//
//   SEA LICE is the opposite-season phenomenon (SE-FL: Mar-Aug, peaking
//   May-Jun), driven by warm water and Caribbean current advection of thimble
//   jellyfish larvae — NOT locally wind-forecastable. It is a purely
//   climatological sub-advisory and is computed completely independently of
//   the man-o'-war wind analysis.
//
// Design rules enforced throughout this file:
//   - No moon phase (irrelevant to either mechanism).
//   - No fake precision — scores are 0-100 informational bands, never
//     presented as a "% probability".
//   - No multi-day claims — man-o'-war has a ~1-day horizon; sea lice is a
//     seasonal likelihood, not a forecast for any specific day.
//   - Every numeric threshold below has a rationale comment tied to the
//     mechanism it represents.
// ---------------------------------------------------------------------------

import type { StingerSightings } from "@/lib/sources/stingerSightings";
import { clamp, msToMph, round } from "@/lib/util";

// --- Man-o'-war ---------------------------------------------------------

export type ManOWarLevel = "low" | "possible" | "elevated" | "high";
/**
 * "observed"  — a recent (<=7 days), nearby (<=100 km) iNaturalist sighting
 *               corroborates the wind read.
 * "wind-only" — the sightings feed is unavailable (network/API down); this is
 *               an estimate from wind alone, honestly labeled as such.
 * "low"       — the sightings feed WAS checked and found nothing recent
 *               nearby — an actively lower-confidence state, not merely
 *               "unknown" (see the zero-sightings branch below).
 */
export type ManOWarConfidence = "observed" | "wind-only" | "low";

export interface ManOWarRisk {
  level: ManOWarLevel;
  /** 0-100 informational band, NOT a probability — never render it as "X%". */
  score: number;
  confidence: ManOWarConfidence;
  /** Honest, hedged, ~1-day-horizon note for display. */
  note: string;
}

export interface HourlyWindSample {
  /** ISO timestamp (UTC). */
  time: string;
  windSpeedMph?: number;
  /** Meteorological "from" direction, degrees (0=N, 90=E, ...) — same
   *  convention as HourlyMetrics.windDirDeg in lib/types.ts. */
  windDirDeg?: number;
}

export interface ManOWarInput {
  /** Trailing hourly wind samples, ideally covering the last ~36h (order
   *  doesn't matter, sorted internally by age). Samples further than 36h in
   *  the past or in the future are ignored. Needs at least ~24h of WALL-CLOCK
   *  coverage among the in-window samples, or this returns `null` — a few
   *  scattered hourly points don't establish "sustained". */
  hourlyWind: HourlyWindSample[];
  /**
   * The compass bearing wind blows FROM when blowing straight onshore at this
   * beach (i.e. the reciprocal of the seaward-facing direction). REQUIRED —
   * deliberately no default — because this entire mechanism is specific to a
   * beach's real shoreline orientation. For a due-east-facing SE-Florida
   * Atlantic beach this is 90°. Callers must only supply this for a real,
   * man-o'-war-prone Atlantic-facing beach; see the module-level integration
   * note in the accompanying build report.
   */
  coastNormalDeg: number;
  /** Local calendar month at the beach (1-12), driving the Nov-Apr season
   *  weighting. Must be the beach's LOCAL month, not the server's. */
  month: number;
  /** Live iNaturalist cross-check (lib/sources/stingerSightings.ts), or
   *  `null` if that feed is down/unreachable. Distinct from a successful
   *  fetch that found nothing (`{ count: 0, ... }`) — see ManOWarConfidence. */
  sightings: StingerSightings | null;
  /** Injectable "now" for deterministic tests; defaults to real time. */
  now?: Date;
}

/** How many trailing hours of wind we'll look at at most. */
const WIND_WINDOW_HOURS = 36;
/** Minimum wall-clock span of trailing coverage required before we'll call
 *  anything "sustained" — a handful of hours can't establish a multi-hour
 *  onshore push, and the low end of the "~24-36h" spec range is the floor. */
const MIN_COVERAGE_HOURS = 24;
/** Samples within this many hours of "now" count extra — the mechanism cares
 *  most about whether the push is CURRENTLY happening, not what it was doing
 *  36h ago. */
const RECENT_HOURS = 12;
/** Recent hours are weighted 1.5x a non-recent hour in the trailing mean —
 *  enough to tilt the average toward "right now" without letting one gusty
 *  hour dominate a genuinely calm day. */
const RECENT_WEIGHT = 1.5;

/**
 * The onshore-component peer-reviewed anchor: elevated Physalia stranding
 * occurrence when sustained onshore wind is >= ~8 m/s (~15-18 kt). Converted
 * properly via msToMph rather than a rounded-by-hand constant.
 */
const HIGH_ANCHOR_MPH = msToMph(8); // ~17.9 mph

/**
 * Piecewise-linear map from sustained onshore wind (mph) to a 0-100 "wind
 * pressure" base score. Anchors:
 *  - 0 mph (no onshore push) -> 0
 *  - 8 mph -> 20: a light but real onshore component starts to matter
 *  - 14 mph -> 45: builds toward the peer-reviewed anchor
 *  - HIGH_ANCHOR_MPH (~17.9 mph / 8 m/s) -> 70: the literature's elevated-
 *    occurrence threshold
 *  - 25 mph -> 90, 35 mph -> 100: strong sustained onshore gales, saturating
 *    (wind this strong rarely gets meaningfully "more onshore-forcing" per
 *    additional mph for THIS mechanism — the float is already being driven
 *    hard). This is a "wind pressure" score, not a probability.
 */
const WIND_ANCHORS: [number, number][] = [
  [0, 0],
  [8, 20],
  [14, 45],
  [HIGH_ANCHOR_MPH, 70],
  [25, 90],
  [35, 100],
];

/** Same small dependency-free piecewise-linear interpolator convention as
 *  lib/stormActivity.ts's private `lerpCurve` — duplicated rather than
 *  imported so this module stays an isolated, independently-testable unit. */
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

/**
 * Onshore wind component for one hour: full speed when the wind blows exactly
 * along the onshore bearing, falling off with the angle, zero (never
 * negative) once the wind has any offshore component. Physalia's float is
 * wind-driven, so only this component pushes it toward the beach.
 */
function onshoreComponentMph(speedMph: number, windFromDeg: number, coastNormalDeg: number): number {
  const rad = ((windFromDeg - coastNormalDeg) * Math.PI) / 180;
  return speedMph * Math.max(0, Math.cos(rad));
}

/**
 * Recency-weighted mean onshore component over the trailing window, or `null`
 * when there isn't enough wall-clock coverage to honestly call anything
 * "sustained" (see MIN_COVERAGE_HOURS).
 */
function sustainedOnshoreMph(
  hourlyWind: HourlyWindSample[],
  coastNormalDeg: number,
  nowMs: number,
): { meanOnshoreMph: number; coverageHours: number } | null {
  const inWindow = hourlyWind
    .map((h) => ({ h, ageH: (nowMs - Date.parse(h.time)) / 3_600_000 }))
    .filter(
      ({ h, ageH }) =>
        Number.isFinite(ageH) &&
        ageH >= 0 &&
        ageH <= WIND_WINDOW_HOURS &&
        typeof h.windSpeedMph === "number" &&
        Number.isFinite(h.windSpeedMph) &&
        typeof h.windDirDeg === "number" &&
        Number.isFinite(h.windDirDeg),
    );

  if (!inWindow.length) return null;

  const coverageHours = Math.max(...inWindow.map(({ ageH }) => ageH));
  if (coverageHours < MIN_COVERAGE_HOURS) return null;

  let weightSum = 0;
  let valueSum = 0;
  for (const { h, ageH } of inWindow) {
    const onshore = onshoreComponentMph(h.windSpeedMph as number, h.windDirDeg as number, coastNormalDeg);
    const weight = ageH <= RECENT_HOURS ? RECENT_WEIGHT : 1;
    weightSum += weight;
    valueSum += weight * onshore;
  }
  return { meanOnshoreMph: valueSum / weightSum, coverageHours };
}

/** Nov-Apr: SE-Florida's winter cold-front / trade-wind easterly season, the
 *  window the man-o'-war stranding literature is drawn from. */
function isPeakManOWarSeason(month: number): boolean {
  return month === 11 || month === 12 || month <= 4;
}

/** May-Oct: the same onshore wind is far less likely to be pushing an
 *  offshore population ashore, since the winter wind-driven blooms aren't
 *  typically established. Tapered, not zeroed — a strong easterly can still
 *  happen off-season (e.g. a summer tropical system's outer bands). */
const OFF_SEASON_FACTOR = 0.4;

/** A confirmed recent + nearby sighting resolves exactly the "were they even
 *  offshore" uncertainty that caps wind-only estimates at 16-24% — a
 *  substantial, additive confidence boost, not a multiplier (so it still
 *  matters even when the wind score itself is low). */
const SIGHTING_BOOST = 30;
/** Checked and found nothing recent nearby: genuinely lowers likelihood, but
 *  the animals move and a clear report a day old doesn't guarantee a clear
 *  beach tomorrow, so this damps rather than zeroes the wind-only score. */
const ZERO_SIGHTING_DAMPING = 0.5;

/** How many days back a sighting still counts as "recent" for the gate. */
const SIGHTING_RECENCY_DAYS = 7;
/** How far away a sighting still counts as "nearby" for the gate. */
const SIGHTING_RADIUS_KM = 100;

function daysSince(iso: string, nowMs: number): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (nowMs - t) / 86_400_000 : Infinity;
}

/** Whether the sightings feed corroborates a live, nearby man-o'-war presence. */
function qualifyingSighting(sightings: StingerSightings | null, nowMs: number): boolean {
  if (!sightings || !sightings.mostRecentIso) return false;
  if (daysSince(sightings.mostRecentIso, nowMs) > SIGHTING_RECENCY_DAYS) return false;
  if (sightings.nearestKm != null && sightings.nearestKm > SIGHTING_RADIUS_KM) return false;
  return true;
}

const LEVEL_ORDER: ManOWarLevel[] = ["low", "possible", "elevated", "high"];

function levelForScore(score: number): ManOWarLevel {
  if (score >= 80) return "high";
  if (score >= 50) return "elevated";
  if (score >= 20) return "possible";
  return "low";
}

/** Clamp a level to at most `maxLevel` on the low->high ordering. */
function capLevel(level: ManOWarLevel, maxLevel: ManOWarLevel): ManOWarLevel {
  return LEVEL_ORDER.indexOf(level) > LEVEL_ORDER.indexOf(maxLevel) ? maxLevel : level;
}

function manOWarNote(opts: {
  level: ManOWarLevel;
  inSeason: boolean;
  qualifying: boolean;
  checkedZero: boolean;
}): string {
  const { level, inSeason, qualifying, checkedZero } = opts;
  const seasonHedge = inSeason
    ? ""
    : " — outside the typical Nov–Apr season, so treat this as a softer, lower-odds call";

  if (level === "low" && !qualifying) {
    return `Winds aren't strongly onshore right now — low chance of man-o'-war washing ashore in the next day${seasonHedge}.`;
  }
  if (qualifying) {
    const strength = level === "high" ? "a good chance" : "some chance";
    return (
      `Man-o'-war reported nearby within the past week, and onshore winds have been sustained — ` +
      `${strength} more wash ashore in the next day${seasonHedge}.`
    );
  }
  if (checkedZero) {
    return (
      `No man-o'-war reported nearby recently even though winds have been onshore — a lower-confidence ` +
      `call, since wind alone only predicts a real stranding roughly 1 time in 5${seasonHedge}.`
    );
  }
  return (
    `Onshore winds have been sustained, which can push man-o'-war ashore in the next day — advisory only ` +
    `(live sighting confirmation is unavailable right now, and wind alone is a weak predictor on its own)` +
    `${seasonHedge}.`
  );
}

/**
 * Portuguese man-o'-war stranding risk for the next ~day, from sustained
 * onshore wind, season, and a live sightings cross-check. Returns `null` when
 * there isn't enough trailing wind history to honestly judge "sustained"
 * (see MIN_COVERAGE_HOURS) — never a guess dressed up as a low reading.
 */
export function manOWarRisk(input: ManOWarInput): ManOWarRisk | null {
  const nowMs = (input.now ?? new Date()).getTime();
  const wind = sustainedOnshoreMph(input.hourlyWind, input.coastNormalDeg, nowMs);
  if (!wind) return null;

  const inSeason = isPeakManOWarSeason(input.month);
  const seasonFactor = inSeason ? 1 : OFF_SEASON_FACTOR;
  const baseScore = lerpCurve(wind.meanOnshoreMph, WIND_ANCHORS);
  const scaledScore = baseScore * seasonFactor;

  const qualifying = qualifyingSighting(input.sightings, nowMs);
  const checkedZero = input.sightings != null && !qualifying;

  let confidence: ManOWarConfidence;
  let score: number;
  let capAt: ManOWarLevel;

  if (qualifying) {
    confidence = "observed";
    score = clamp(scaledScore + SIGHTING_BOOST, 0, 100);
    capAt = "high"; // sighting-confirmed can reach the top band
  } else if (checkedZero) {
    confidence = "low";
    score = clamp(scaledScore * ZERO_SIGHTING_DAMPING, 0, 100);
    capAt = "possible"; // checked and clear -> never claim elevated/high
  } else {
    confidence = "wind-only";
    score = clamp(scaledScore, 0, 100);
    // Wind alone is necessary-not-sufficient (~16-24% next-day hit rate in
    // the literature) — never let a wind-only read claim the top band.
    capAt = "elevated";
  }

  const level = capLevel(levelForScore(score), capAt);

  return {
    level,
    score: round(score),
    confidence,
    note: manOWarNote({ level, inSeason, qualifying, checkedZero }),
  };
}

// --- Sea lice (seabather's eruption) -------------------------------------

export type SeaLiceLevel = "low" | "possible" | "elevated";

export interface SeaLiceRisk {
  level: SeaLiceLevel;
  note: string;
}

export interface SeaLiceInput {
  /** Local calendar month at the beach (1-12). */
  month: number;
  /** Current water temperature (°F), if known. */
  waterTempF?: number;
}

/** SE-Florida seabather's eruption window: March through August. Outside this
 *  range the thimble jellyfish (Linuche unguiculata) larval bloom that causes
 *  it isn't plausible here, so the honest answer is `null`, not "low". */
const SEA_LICE_START_MONTH = 3;
const SEA_LICE_END_MONTH = 8;
/** The literature's peak months for SE-Florida seabather's eruption. */
const SEA_LICE_PEAK_MONTHS = new Set([5, 6]);
/** Warmer water tracks the Caribbean-current advection pattern that carries
 *  the larvae north — not a hard causal threshold, just a corroborating
 *  climatological signal. */
const SEA_LICE_WARM_WATER_F = 78;

/**
 * Seabather's eruption seasonal likelihood — PURELY climatological (season +
 * water temperature), never wind-forecast, since the driver is warm-water
 * Caribbean current advection of larvae, not local wind. Returns `null`
 * outside the Mar-Aug window; inside it, "elevated" requires being in the
 * May-Jun peak AND corroborating warm water — either alone lands on
 * "possible", and neither present still leaves a nonzero seasonal "low"
 * baseline. Always a likelihood, never a forecast for a specific day.
 */
export function seaLiceRisk({ month, waterTempF }: SeaLiceInput): SeaLiceRisk | null {
  if (month < SEA_LICE_START_MONTH || month > SEA_LICE_END_MONTH) return null;

  const peak = SEA_LICE_PEAK_MONTHS.has(month);
  const warm = waterTempF != null && waterTempF >= SEA_LICE_WARM_WATER_F;
  const signals = (peak ? 1 : 0) + (warm ? 1 : 0);
  const level: SeaLiceLevel = signals >= 2 ? "elevated" : signals === 1 ? "possible" : "low";

  const seasonNote = peak
    ? "peak May-June seabather's-eruption season"
    : "seabather's-eruption season (Mar-Aug)";
  const warmNote = warm ? " and the water's warm enough to favor the larvae" : "";
  const note =
    `In ${seasonNote}${warmNote} — a seasonal likelihood from warm-water Caribbean current advection ` +
    `of thimble jellyfish larvae ("sea lice"), not a day-specific forecast. Rash-like sting under swimwear; ` +
    `rinsing off and washing the suit helps.`;

  return { level, note };
}

// --- Combined advisory ----------------------------------------------------

export interface MarineStingerInput {
  hourlyWind: HourlyWindSample[];
  /** REQUIRED, no default — see ManOWarInput.coastNormalDeg. */
  coastNormalDeg: number;
  /** Local calendar month at the beach (1-12). */
  month: number;
  sightings: StingerSightings | null;
  /** Current water temperature (°F), for the sea-lice sub-advisory. */
  waterTempF?: number;
  now?: Date;
}

export interface MarineStingerAdvisory {
  manOWar: ManOWarRisk | null;
  seaLice: SeaLiceRisk | null;
}

/**
 * Combine the two independent sub-advisories. Each degrades to `null`
 * separately (see manOWarRisk / seaLiceRisk); this only returns `null`
 * overall when BOTH have nothing to say, so a caller can render the whole
 * card as an exception-only advisory (nothing shown on a quiet, in-range day).
 */
export function marineStinger(input: MarineStingerInput): MarineStingerAdvisory | null {
  const manOWar = manOWarRisk({
    hourlyWind: input.hourlyWind,
    coastNormalDeg: input.coastNormalDeg,
    month: input.month,
    sightings: input.sightings,
    now: input.now,
  });
  const seaLice = seaLiceRisk({ month: input.month, waterTempF: input.waterTempF });

  if (!manOWar && !seaLice) return null;
  return { manOWar, seaLice };
}
