import type {
  LightningData,
  PrecipRadarData,
  StormActivityBand,
  StormActivityData,
  Wrapped,
} from "@/lib/types";
import { clamp } from "@/lib/util";

/** Inputs the Storm Activity metric needs, pulled by the caller from the
 *  snapshot: the lightning source as-is, plus the CURRENT hour's weather. */
export interface StormActivityInput {
  lightning: Wrapped<LightningData>;
  /** Current hour's precipitation (inches/hr), from `snap.hourly.data`. */
  precipIn?: number;
  /** Current hour's WMO weather code. */
  weatherCode?: number;
  /** Current hour's precipitation probability (0-100). */
  precipProbability?: number;
  /** Radar-OBSERVED rain (NOAA MRMS), when available. Optional: every existing
   *  caller/test that omits it gets exactly today's forecast-based behavior. */
  precipRadar?: Wrapped<PrecipRadarData> | null;
}

const STRIKE_WEIGHT = 0.45;
const PROXIMITY_WEIGHT = 0.35;
const RAIN_WEIGHT = 0.2;

// Piecewise-linear anchors: [x, y]. See lib/score.ts's private `lerpCurve` for
// the same shape of curve — duplicated here (not imported) so this module stays
// a small, dependency-free, pure unit under test rather than coupling a
// safety-adjacent metric to the composite Beach Day score module.
const STRIKE_ANCHORS: [number, number][] = [
  [0, 0],
  [1, 40],
  [3, 70],
  [8, 90],
  [20, 100],
];
const PROXIMITY_ANCHORS: [number, number][] = [
  [0, 100],
  [1, 95],
  [5, 80],
  [10, 55],
  [15, 30],
  [20, 10],
  [25, 0],
];
const RAIN_ANCHORS: [number, number][] = [
  [0, 0],
  [0.02, 20],
  [0.1, 50],
  [0.25, 75],
  [0.5, 100],
];

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
 * Whether the lightning feed is healthy enough to trust for the strike-density
 * and proximity components. Requires the fetch itself to have succeeded
 * ("ok" — not "stale"/"error"/"best-effort") AND the GLM snapshot to be no more
 * than 30 min old. We use a flat 30-min threshold here rather than the fetcher's
 * own looser `windowMinutes + 30` staleness rule (lib/sources/lightning.ts),
 * because this is a safety-adjacent number — better to go silent than to trust
 * a snapshot that's meaningfully behind real time.
 */
function lightningKnown(w: Wrapped<LightningData>): boolean {
  if (w.status !== "ok" || !w.data) return false;
  const age = w.data.dataAgeMinutes;
  return age == null || age <= 30;
}

/** Same freshness rule as lib/score.ts's `lightningWithin5mi`: the fetch must
 *  have succeeded, the most recent strike in the scan area must be <=30 min old
 *  (or there simply were none), and the CLOSEST strike must be within 5 mi. */
function freshStrikeWithin5mi(w: Wrapped<LightningData>): boolean {
  return (
    w.status === "ok" &&
    (w.data?.lastMinutesAgo == null || w.data.lastMinutesAgo <= 30) &&
    (w.data?.nearestMi ?? Infinity) <= 5
  );
}

function strikeScoreOf(data: LightningData): number {
  return lerpCurve(data.stormEnergy ?? 0, STRIKE_ANCHORS);
}

/** Only counts when the nearest strike itself is fresh (<=20 min old); a
 *  close-but-old strike doesn't indicate current proximity risk. */
function proximityScoreOf(data: LightningData): number {
  if (data.nearestMi == null || data.nearestMinutesAgo == null || data.nearestMinutesAgo > 20) {
    return 0;
  }
  return lerpCurve(data.nearestMi, PROXIMITY_ANCHORS);
}

/**
 * Rain component from the current hour's precip. Floored at 70 when the
 * weather code corroborates an active thunderstorm (95-99) AND the model's own
 * precip probability backs it (>=25%) — the same corroboration convention
 * `rainSeverity()` in lib/score.ts uses to stop a lone bogus storm code from
 * driving the number. Unlike `rainSeverity`, an unknown probability does NOT
 * count as corroborated here (fail-closed, not fail-open) since this floor can
 * single-handedly keep the whole metric visible when lightning is unknown.
 */
function rainScoreOf(
  precipIn: number | undefined,
  weatherCode: number | undefined,
  precipProbability: number | undefined,
  /** Radar-OBSERVED rain score, when a fresh radar read is available. It
   *  REPLACES the forecast-derived base (an observation of where the rain
   *  physically is beats a model's guess that it might be there — the same
   *  principle as satellite cloud overriding forecast cloud in score.ts). Null
   *  or omitted falls straight back to the forecast behavior, which is exactly
   *  what every pre-radar caller gets. */
  observed?: number | null,
): number | null {
  const base = observed ?? (precipIn != null ? lerpCurve(precipIn, RAIN_ANCHORS) : null);
  // The thunderstorm-code floor still applies on top of EITHER base: it encodes
  // "a corroborated active thunderstorm is at least this stormy", which is true
  // regardless of which rain input we measured. Radar can also be legitimately
  // near-zero under a storm that's all lightning and no rain at the beach yet.
  const corroborated =
    weatherCode != null &&
    weatherCode >= 95 &&
    weatherCode <= 99 &&
    precipProbability != null &&
    precipProbability >= 25;
  if (!corroborated) return base;
  return Math.max(base ?? 0, 70);
}

// --- Radar-observed rain component ------------------------------------------
// PrecipRate (mm/hr) observed AT the beach -> 0-100. Anchored to be broadly
// comparable to RAIN_ANCHORS' inches/hr scale so swapping one for the other
// doesn't jolt the meter: 0.1 in/hr (the 50-point anchor there) is ~2.5 mm/hr,
// which is the 50-point anchor here.
const RADAR_RATE_ANCHORS: [number, number][] = [
  [0, 0],
  [0.5, 20], // the job's own rain threshold — light drizzle
  [2.5, 50], // ~0.1 in/hr
  [6.5, 75], // ~0.25 in/hr
  [12.5, 100], // ~0.5 in/hr, torrential
];
// Areal coverage of the ~64 km box -> 0-100. A beach can sit in a dry slot
// inside a box that is otherwise full of storms; coverage catches the
// "surrounded by weather" case that a single-point rate rate misses entirely.
const RADAR_COVERAGE_ANCHORS: [number, number][] = [
  [0, 0],
  [10, 25],
  [30, 50],
  [60, 75],
  [85, 100],
];

/**
 * Whether the radar feed is fresh enough to PREFER over the forecast. Requires
 * the fetch to have succeeded ("ok" — not "stale") AND a frame no more than 25
 * min old, matching PRECIP_RADAR_STALE_MINUTES in lib/sources/precipRadar.ts.
 * The threshold is duplicated rather than imported to keep this module a pure,
 * dependency-free unit (same reasoning as the local `lerpCurve` above).
 */
function radarFresh(w: Wrapped<PrecipRadarData> | null | undefined): w is Wrapped<PrecipRadarData> {
  if (!w || w.status !== "ok" || !w.data) return false;
  const age = w.data.frameAgeMinutes;
  return age == null || age <= 25;
}

/**
 * The radar-OBSERVED rain term: max of the at-the-beach rain rate and the box's
 * areal coverage. Max (not mean) because these describe two different ways of
 * being in a storm and either one alone is real: a downpour directly overhead
 * with clear air around it, and a beach in a temporary dry slot inside a
 * wall-to-wall squall line, are both "storm activity". Averaging would let
 * each case cancel the other's evidence.
 *
 * Returns null when the radar has nothing usable for this beach (no coverage),
 * which sends the caller back to the forecast term.
 */
function radarRainScoreOf(d: PrecipRadarData): number | null {
  const rate = d.rainNowMmHr != null ? lerpCurve(d.rainNowMmHr, RADAR_RATE_ANCHORS) : null;
  const coverage = d.coveragePct != null ? lerpCurve(d.coveragePct, RADAR_COVERAGE_ANCHORS) : null;
  if (rate == null && coverage == null) return null;
  return Math.max(rate ?? 0, coverage ?? 0);
}

function bandFor(score: number): StormActivityBand {
  if (score >= 75) return "Severe";
  if (score >= 50) return "Stormy";
  if (score >= 25) return "Unsettled";
  return "Calm";
}

/** Weighted average over whatever parts are available (mirrors `combine()` in
 *  lib/score.ts) — null only when NOTHING was available to average. */
function combineParts(parts: { score: number | null; weight: number }[]): number | null {
  const avail = parts.filter((p): p is { score: number; weight: number } => p.score != null);
  if (!avail.length) return null;
  const totalW = avail.reduce((a, p) => a + p.weight, 0);
  if (totalW === 0) return 0;
  return avail.reduce((a, p) => a + p.score * p.weight, 0) / totalW;
}

/**
 * Storm Activity: a 0-100 composite of GLM strike density near the beach,
 * proximity of the nearest fresh strike, and current-hour rain — pure and
 * unit-testable so the weighting/curves can be pinned down with tests.
 *
 * Returns null (no metric — the UI renders nothing) rather than a misleading
 * number when:
 *  - there's nothing at all to go on (no lightning AND no rain data), or
 *  - the lightning feed is down/stale (see `lightningKnown`) AND rain data
 *    ALONE isn't enough to independently justify showing activity (i.e. the
 *    rain-only estimate would land in the "Calm" band). We deliberately don't
 *    silently report "Calm" purely because lightning coverage dropped out —
 *    that would mask a possibly-real storm as an all-clear. If rain data alone
 *    is severe enough on its own (Unsettled or worse), we DO show it, because
 *    that's a genuine independent signal.
 *
 * A fresh strike within 5 mi (same rule as lib/score.ts's `lightningWithin5mi`
 * get-out-of-the-water cap) is a hard safety override: it always floors the
 * score at 90 ("Severe") and is never suppressed by the above unknown-data
 * logic, mirroring how that observed hazard bottoms out the main Beach Day score.
 */
export function computeStormActivity(input: StormActivityInput): StormActivityData | null {
  const freshClose = freshStrikeWithin5mi(input.lightning);
  const known = lightningKnown(input.lightning);
  const data = input.lightning.data;

  const strikes = known && data ? strikeScoreOf(data) : null;
  const proximity = known && data ? proximityScoreOf(data) : null;
  // Prefer the radar OBSERVATION for the rain term when it's fresh; fall back
  // to the forecast hour otherwise. The weight (RAIN_WEIGHT) is unchanged —
  // this upgrades what the 0.20 term MEASURES, not how much it counts.
  const observedRain = radarFresh(input.precipRadar)
    ? radarRainScoreOf(input.precipRadar.data!)
    : null;
  const rain = rainScoreOf(
    input.precipIn,
    input.weatherCode,
    input.precipProbability,
    observedRain,
  );

  const combined = combineParts([
    { score: strikes, weight: STRIKE_WEIGHT },
    { score: proximity, weight: PROXIMITY_WEIGHT },
    { score: rain, weight: RAIN_WEIGHT },
  ]);

  // True only when the rain term actually CAME FROM radar — lets the meter say
  // "observed" instead of "forecast" without re-deriving the preference order.
  const rainFromRadar = observedRain != null;

  if (freshClose) {
    const score = clamp(Math.round(Math.max(combined ?? 90, 90)), 0, 100);
    return { score, band: bandFor(score), parts: { strikes, proximity, rain }, rainFromRadar };
  }

  if (combined == null) return null;
  const roundedCombined = Math.round(combined);
  if (!known && bandFor(roundedCombined) === "Calm") return null;

  const score = clamp(roundedCombined, 0, 100);
  return { score, band: bandFor(score), parts: { strikes, proximity, rain }, rainFromRadar };
}
