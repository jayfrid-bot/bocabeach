// ---------------------------------------------------------------------------
// Sky-visibility rating — "can you actually see the sky right now?" — shared
// across every "Coming up" card event type (eclipse, full moon/supermoon,
// meteor shower, rocket launch). See docs/SKY_EVENTS_PLAN.md §5.
//
// This is deliberately NOT `sunEventQuality` (lib/sunQuality.ts) reused or
// repurposed: that curve is tuned for sunset/sunrise COLOR — it rewards a
// 30-60% mid/high cloud "canvas" for the low sun to paint onto, and a clear
// sky only scores a middling "plain" there. Here, clear sky is the best
// possible outcome (you can see everything) and MORE cloud of any kind can
// only ever make it worse — no sweet spot, no non-monotonic bump anywhere in
// the curve. This module reuses ONLY `SUN_QUALITY_BANDS`' existing
// Poor/Fair/Good/Great/Amazing labels and colors (so the card's badge looks
// like the same family as the sunrise/sunset card) — the scoring underneath
// is new.
//
// PURE: no network, no `Date.now()`/`new Date()` — every instant this module
// touches is an explicit UTC ISO string handed in by the caller (matches
// SKY_EVENTS_PLAN.md §9's SSR/hydration-safety rule). Deterministic: same
// inputs, same output, safe to cache.
// ---------------------------------------------------------------------------

import type { IsoInstant, IsoInterval, SkyRatingLabel } from "@/lib/skyEventsTypes";
import { SUN_QUALITY_BANDS } from "@/lib/sunQuality";

// --- Public types (frozen shape for Crew F — see the file-level note below) -

/**
 * One hourly forecast row, in the same shape `lib/sources/hourlyForecast.ts`
 * produces (`HourlyMetrics`, UTC ISO `time`). Structurally typed (not
 * imported from lib/types.ts) so a real `HourlyMetrics[]` can be passed
 * straight through with zero mapping, same pattern `sunQuality.ts`'s
 * `HourlyCloudPoint` already uses.
 */
export interface SkyHourlyPoint {
  /** ISO instant (UTC) this row is for — Open-Meteo rows land on the hour;
   *  this row is treated as covering `[time, time + 1h)`. */
  time: IsoInstant;
  cloudCoverPct?: number;
  cloudCoverLowPct?: number;
  cloudCoverMidPct?: number;
  cloudCoverHighPct?: number;
  /** 0-100. */
  precipProbability?: number;
  precipIn?: number;
  /** WMO weather code — same table `lib/sources/spotWeather.ts`'s `wmoText`
   *  and `lib/score.ts`'s rain-code ranges already use (45/48 = fog,
   *  51-67 = drizzle/rain/freezing rain, 80-99 = showers/thunderstorm). */
  weatherCode?: number;
}

/**
 * Only present when the caller has already determined (via astronomy-engine
 * `Illumination` × `Horizon`, SKY_EVENTS_PLAN.md §4/§5) that the Moon is
 * above the horizon at some point during the window. Omitting this field
 * entirely — not passing `aboveHorizon: false` — is also fine; either way,
 * no moonlight penalty is ever applied unless the caller affirmatively says
 * the Moon is up. Never inferred from illumination alone.
 */
export interface MoonDuringWindow {
  aboveHorizon: boolean;
  /** 0-100. Only consulted when `aboveHorizon` is true. */
  illuminationPct: number;
}

export interface SkyVisibilityQualityInput {
  /** The half-open window `[start, end)` to rate — already chosen by the
   *  caller as the event's own relevant observing interval: an eclipse's
   *  intersected visible window, a meteor shower's best local window, the
   *  universal full-moon/supermoon viewing window, or a launch's
   *  `[windowStart, windowEnd)`. `start === end` rates a single instant
   *  (the nearest hourly row covering it) — the shape every other event
   *  type collapses to when it only has one moment to sample. */
  window: IsoInterval;
  /** Every hourly forecast row the caller has available. Only the rows that
   *  actually overlap `window` are used; extra rows outside it are ignored,
   *  so the whole forecast array can be passed as-is. */
  hourly: readonly SkyHourlyPoint[];
  moon?: MoonDuringWindow;
}

/**
 * A superset of `lib/skyEventsTypes.ts`'s frozen `SkyRating` (`{ label,
 * sampledOver }`) — every `SkyEvent.rating` field in that file accepts this
 * directly, since TS structural typing allows a value with extra properties
 * to satisfy a narrower target type. `score`/`color`/`drivers` are additive:
 * useful for the card UI and for tests, never required by the frozen
 * contract.
 */
export interface SkyVisibilityRating {
  /** One of `SUN_QUALITY_BANDS`' existing labels. */
  label: SkyRatingLabel;
  /** 0-100, before nothing — this IS the final score, after every cap. */
  score: number;
  /** Hex accent, straight from `SUN_QUALITY_BANDS` (reused, not reinvented). */
  color: string;
  /** Echoes `input.window` — the interval this rating was actually sampled
   *  over (satisfies `SkyRating.sampledOver`). */
  sampledOver: IsoInterval;
  /** Plain-English one-liners naming whatever capped or dragged the score
   *  (fog, rain, heavy low cloud, a bright moon). Omitted when nothing
   *  notable applied (e.g. a plain clear or plain cloudy read). */
  drivers?: string[];
}

/**
 * Rate how visible the sky itself is over `input.window`, using whichever
 * `input.hourly` rows overlap it.
 *
 * Rules (SKY_EVENTS_PLAN.md §5):
 * - Clear sky scores best (100); more cloud — at any level, and using
 *   whichever of total/low/mid/high the caller has — only ever lowers the
 *   score. No non-monotonic bump anywhere in the curve.
 * - Precipitation, fog/low visibility, or near-total low cloud (>=85%) caps
 *   the result at "Poor" outright, regardless of the rest of the mix.
 * - A moonlight penalty applies ONLY when `input.moon.aboveHorizon` is true
 *   AND `illuminationPct > 70`: it caps the result at "Fair" regardless of
 *   cloud — never applied from illumination alone.
 * - Every hour required to cover `window` must have a usable forecast row
 *   (complete low/mid/high split, or a total-cloud reading) — if any part
 *   of the window has no matching row (including a window that reaches
 *   beyond the forecast horizon, which simply has no rows to match), this
 *   returns `null`. No badge is ever guessed.
 *
 * Conservative aggregate: the WORST-scoring hour among the ones covering
 * `window` sets the base score (caps are then checked across ALL of those
 * hours, not just the worst one — a brief rain shower or fog bank anywhere
 * in the window still caps the whole result). Worst-hour, not a 75th-
 * percentile split, is used deliberately: every caller here already hands
 * in an event-relevant, pre-trimmed window (a launch's own window, an
 * eclipse's own visible interval, a shower's own best local interval) —
 * often just a few hours — where a percentile has too few samples to mean
 * anything, and "launch windows conservative" (this crew's brief) is most
 * directly satisfied by treating the single worst hour in the window as
 * the one that matters, the same rule uniformly for every event type
 * rather than a special case for launches alone.
 *
 * Pure: no network, no clock reads. `window`/`hourly[].time` are the only
 * time inputs, all UTC ISO strings.
 */
export function skyVisibilityQuality(input: SkyVisibilityQualityInput): SkyVisibilityRating | null {
  const { window, hourly, moon } = input;

  const startMs = Date.parse(window.start);
  const endMs = Date.parse(window.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;

  // Defensive sanity cap — no real caller ever hands in a window this long
  // (the longest here, a launch window, is hours; the forecast horizon
  // itself is ~9 days of hourly data). Guards against a pathological input
  // walking an unbounded bucket loop.
  const MAX_WINDOW_HOURS = 24 * 30;
  if ((endMs - startMs) / HOUR_MS > MAX_WINDOW_HOURS) return null;

  const lastCoveredMs = endMs > startMs ? endMs - 1 : startMs;
  const firstBucketMs = Math.floor(startMs / HOUR_MS) * HOUR_MS;
  const lastBucketMs = Math.floor(lastCoveredMs / HOUR_MS) * HOUR_MS;

  const byBucket = new Map<number, SkyHourlyPoint>();
  for (const row of hourly) {
    const t = Date.parse(row.time);
    if (!Number.isFinite(t)) continue;
    byBucket.set(Math.floor(t / HOUR_MS) * HOUR_MS, row);
  }

  const matched: SkyHourlyPoint[] = [];
  for (let b = firstBucketMs; b <= lastBucketMs; b += HOUR_MS) {
    const row = byBucket.get(b);
    if (!row || effectiveCloudOpacityPct(row) === undefined) return null; // missing/unusable → honest-null
    matched.push(row);
  }
  if (matched.length === 0) return null;

  const hourScores = matched.map((row) => lerpCurve(effectiveCloudOpacityPct(row)!, CLOUD_CURVE));
  let score = Math.min(...hourScores); // conservative: worst hour in the window
  let label = bandFor(score);

  const drivers: string[] = [];

  // Moonlight penalty — only when the caller says the Moon is up, and only
  // above the 70% illumination line; caps at "Fair", never lower by itself.
  if (moon?.aboveHorizon && moon.illuminationPct > 70) {
    if (LABEL_RANK[label] > LABEL_RANK.Fair) {
      label = "Fair";
      score = Math.min(score, FAIR_MAX_SCORE);
    }
    drivers.push(`Bright moon (${Math.round(moon.illuminationPct)}% lit) washes out the sky.`);
  }

  // Hard caps — precipitation, fog/low visibility, near-total low cloud —
  // checked across every hour in the window, not just the worst one.
  let hardCapped = false;
  for (const row of matched) {
    if (row.weatherCode === 45 || row.weatherCode === 48) {
      hardCapped = true;
      drivers.push("Fog reduces visibility.");
    }
    if (isPrecipitating(row)) {
      hardCapped = true;
      drivers.push("Rain in the window blocks the view.");
    }
    if ((row.cloudCoverLowPct ?? 0) >= 85) {
      hardCapped = true;
      drivers.push("Heavy low cloud blankets the sky.");
    }
  }
  if (hardCapped) {
    label = "Poor";
    score = Math.min(score, POOR_MAX_SCORE);
  }

  return {
    label,
    score: Math.round(clamp(score, 0, 100)),
    color: SUN_QUALITY_BANDS.find((b) => b.label === label)?.color ?? SUN_QUALITY_BANDS[0].color,
    sampledOver: { start: window.start, end: window.end },
    drivers: drivers.length ? Array.from(new Set(drivers)) : undefined,
  };
}

// --- internals ---------------------------------------------------------------

const HOUR_MS = 3_600_000;

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

/** Piecewise-linear interpolation through ordered [x,y] anchors — same shape
 *  as lib/sunQuality.ts's private `lerpCurve`. Duplicated, not imported, to
 *  keep this module's own curve self-contained and easy to reason about. */
function lerpCurve(x: number, anchors: readonly (readonly [number, number])[]): number {
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
 * Score vs. effective cloud "opacity" %. 0% (clear) scores 100 and every
 * higher opacity scores strictly lower — clear-sky-best, monotonic, no
 * sweet spot. Slightly concave (drops off faster at low opacity than a
 * straight line would) so scattered cloud (10-25%) still meaningfully dents
 * the score — unlike sunset color, stargazing/eclipse/launch viewing wants
 * the WHOLE sky clear, not just a partial gap.
 */
const CLOUD_CURVE: readonly (readonly [number, number])[] = [
  [0, 100],
  [10, 90],
  [25, 74],
  [50, 52],
  [75, 26],
  [100, 6],
];

/**
 * Effective cloud opacity 0-100 for one hourly row: a complete low/mid/high
 * split is combined via a screen blend (`1 - (1-l)(1-m)(1-h)`, same trick
 * `lib/sunQuality.ts`'s `combineMidHigh` uses for mid+high) — each deck
 * blocks the sky independently, so opacity is monotonic in every one of
 * low/mid/high individually, never just their sum. Falls back to
 * `cloudCoverPct` (total) when the level split isn't complete. Returns
 * `undefined` when neither is available — the caller treats that row as
 * missing/unusable, same honest-null stance `sunEventQuality` takes on a
 * partial split (never fabricate a canvas from a level the forecast didn't
 * actually give us).
 */
function effectiveCloudOpacityPct(row: SkyHourlyPoint): number | undefined {
  const { cloudCoverLowPct: low, cloudCoverMidPct: mid, cloudCoverHighPct: high } = row;
  if (low != null && mid != null && high != null) {
    const l = clamp(low, 0, 100) / 100;
    const m = clamp(mid, 0, 100) / 100;
    const h = clamp(high, 0, 100) / 100;
    return Math.round((1 - (1 - l) * (1 - m) * (1 - h)) * 100);
  }
  if (row.cloudCoverPct != null) return clamp(row.cloudCoverPct, 0, 100);
  return undefined;
}

/** Rain/drizzle/showers/thunderstorm signal for one hour: measurable
 *  precipitation, a high precip probability, or a rain-family WMO code —
 *  the same code ranges `lib/score.ts` already treats as rain (51-67
 *  drizzle/rain/freezing rain, 80-99 showers/thunderstorm; 45/48 fog is
 *  checked separately, not folded in here). */
function isPrecipitating(row: SkyHourlyPoint): boolean {
  if ((row.precipIn ?? 0) > 0) return true;
  if ((row.precipProbability ?? 0) >= 50) return true;
  const c = row.weatherCode;
  if (c == null) return false;
  return (c >= 51 && c <= 67) || (c >= 80 && c <= 99);
}

const BAND_CUTOFFS: readonly { min: number; label: SkyRatingLabel }[] = [
  { min: 90, label: "Amazing" },
  { min: 70, label: "Great" },
  { min: 45, label: "Good" },
  { min: 20, label: "Fair" },
  { min: 0, label: "Poor" },
];

function bandFor(score: number): SkyRatingLabel {
  for (const c of BAND_CUTOFFS) if (score >= c.min) return c.label;
  return "Poor";
}

const LABEL_RANK: Record<SkyRatingLabel, number> = { Poor: 0, Fair: 1, Good: 2, Great: 3, Amazing: 4 };

/** Highest score that still falls in the "Fair" band (one below "Good"'s
 *  own floor of 45) — used when the moonlight penalty caps a label down. */
const FAIR_MAX_SCORE = 44;
/** Highest score that still falls in the "Poor" band (one below "Fair"'s
 *  own floor of 20) — used when a hard cap forces "Poor". */
const POOR_MAX_SCORE = 19;
