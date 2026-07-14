// Estimated beach-sand surface temperature. Nobody measures sand directly, so
// this is an empirical model: start from the weather model's ground-surface
// temperature (soil_temperature_0cm) and add a "dry sand" boost — loose dry
// sand insulates, so solar heat piles up in the top layer and runs well above
// generic modeled ground. The boost grows with solar radiation and is damped
// by wind (convective cooling) and recent rain (wet sand conducts heat away).
// Guidance only — calibrated to "is it comfortable barefoot", not lab accuracy.

/**
 * Full Florida midsummer peak sun is ~1000 W/m². Setting "full" any lower
 * clips the true early-afternoon peak (real days hit 950-1000) and makes a
 * light-wind late morning at ~890 W/m² read hotter than peak sun — a false
 * midday dip in the curve.
 */
const FULL_SUN_WM2 = 1000;
/**
 * Max extra °F dry sand runs above the modeled ground surface in full sun.
 * Calibrated against IR-thermometer ground truth at Boca:
 *  - 2026-06-11 ~2 PM:   soil 98°F,  980 W/m², 11 mph, 16% cloud → 130-140°F measured (dunes)
 *  - 2026-06-15 ~1 PM:   soil 109°F, 820 W/m², 10 mph, 41% cloud → 129-135°F measured (dunes)
 *  - 2026-06-23 ~9:54 AM: soil 91°F, 380 W/m², 2 mph, 63% broken → 113°F surf / 124°F dunes
 *  - 2026-07-06 ~4-5 PM: soil 94°F, ~320 W/m², 2 mph, ~100% OVERCAST → 96°F measured
 *    (twice, an hour apart — solid overcast pins sand to ground temp; see damping)
 *  - 2026-07-14 ~1 PM:  soil 105°F, 965 W/m², 11 mph, 0% cloud → 135-142°F measured
 *    (model said 137 — inside the spread, ~1.5° under the midpoint. NOT retuned:
 *    the 6/15 point already reads ~4° high, so a hot-day bump would overshoot it.)
 */
const MAX_SUN_BOOST_F = 55;
/**
 * Solid overcast kills the dry-sand boost. The boost is driven by DIRECT beam
 * radiation: broken clouds (even ~63% cover, 6/23) still pass full beam between
 * them and the sand runs hot, but a solid grey deck passes only diffuse light and
 * the sand sits at ground temp. Ground truth 2026-07-06 ~4-5 PM: soil 94°F,
 * ~100% cloud → 96°F measured (twice, an hour apart) vs ~121°F the un-damped
 * model predicted. So: no damping through 70% cover, then a steep ramp to ~90%
 * damping at full overcast. (Modeled W/m² alone can't tell — Open-Meteo still
 * reported 259-418 W/m² "direct" under that 96-98% deck.)
 */
const OVERCAST_START_PCT = 70;
const OVERCAST_MAX_DAMP = 0.9;
/**
 * The wet/firm sand by the surf runs much cooler than the dry dune sand — a
 * ~11°F surf-to-dunes spread measured at Boca (2026-06-23: 113°F surf → 124°F
 * dunes). So the surf side carries ~0.65 of the dry-sand boost, the dunes the
 * full boost. (Was 0.8, which made the two read nearly identical.)
 */
const SURF_BOOST_FRACTION = 0.65;

export interface SandTempInput {
  /** Modeled ground-surface temp (°F), e.g. Open-Meteo soil_temperature_0cm. */
  soilTempF?: number;
  /** Solar radiation hitting the ground (W/m²). */
  solarWm2?: number;
  windSpeedMph?: number;
  /** Rain over the last few hours (inches) — wet sand barely heats. */
  recentRainIn?: number;
  /** Cloud cover (0-100%) — solid overcast collapses the dry-sand boost. */
  cloudCoverPct?: number;
}

/** The sun/wind/rain boost (°F) dry sand carries above the modeled ground. */
function sandBoostF(input: SandTempInput): number | undefined {
  const { soilTempF, solarWm2, windSpeedMph, recentRainIn, cloudCoverPct } = input;
  if (soilTempF == null) return undefined;

  const sunFrac = Math.min(1, Math.max(0, (solarWm2 ?? 0) / FULL_SUN_WM2));
  // Dry sand heats fast and holds it, so its surface temp responds CONCAVELY to
  // instantaneous solar — even moderate morning sun drives the dry top layer
  // hot. Scale by sqrt(sunFrac), not sunFrac. Calibrated to 2026-06-23 ~9:54 AM
  // (soil 91°F, 380 W/m², 2 mph → 124°F dunes measured; linear scaling predicted
  // only ~111°F), while still landing the high-sun afternoons (6/11, 6/15).
  let boost = Math.sqrt(sunFrac) * MAX_SUN_BOOST_F;

  // A breeze takes some edge off the surface, but radiative heating dominates:
  // the 140°F dune reading was taken in an 11 mph sea breeze.
  const wind = Math.max(0, windSpeedMph ?? 0);
  boost *= Math.max(0.6, 1 - wind / 60);

  // Solid overcast: no direct beam → the dry top layer barely runs above the
  // modeled ground. No damping through OVERCAST_START_PCT (broken clouds still
  // pass full sun between them — the 6/23 124°F reading was under 63% cover),
  // then a steep ramp to OVERCAST_MAX_DAMP at a 100% grey deck (7/06: 96°F
  // measured vs ~121°F undamped). Unknown cloud cover → no damping.
  const cloud = Math.min(100, Math.max(0, cloudCoverPct ?? 0));
  if (cloud > OVERCAST_START_PCT) {
    const f = (cloud - OVERCAST_START_PCT) / (100 - OVERCAST_START_PCT);
    boost *= 1 - OVERCAST_MAX_DAMP * Math.pow(f, 1.5);
  }

  // The weather model's soil temp already absorbs some solar heating on hot
  // afternoons (today: 109°F vs 98°F on the 6/11 calibration day). Shrink the
  // boost as the modeled baseline climbs past ~90°F so we don't double-count
  // the sun. Floor 0.4 — even very hot ground gets some dry-sand differential.
  boost *= Math.max(0.4, Math.min(1, 1 - (soilTempF - 90) / 55));

  // Rain in the last few hours keeps the top layer damp and conductive.
  if ((recentRainIn ?? 0) >= 0.05) boost *= 0.3;

  return boost;
}

/**
 * Estimated dry-sand (dune-side) surface temperature (°F) — the hottest sand
 * a barefoot walk crosses — or undefined without a basis.
 */
export function estimateSandTempF(input: SandTempInput): number | undefined {
  const boost = sandBoostF(input);
  return boost == null ? undefined : Math.round(input.soilTempF! + boost);
}

/** The surf-to-dunes range: damp firm sand by the water vs dry loose sand. */
export function estimateSandRangeF(
  input: SandTempInput,
): { surfF: number; dunesF: number } | undefined {
  const boost = sandBoostF(input);
  if (boost == null) return undefined;
  return {
    surfF: Math.round(input.soilTempF! + boost * SURF_BOOST_FRACTION),
    dunesF: Math.round(input.soilTempF! + boost),
  };
}

export interface SandVerdict {
  label: string;
  /** Short advice, e.g. "sandals recommended". */
  advice: string;
  color: string;
}

/** Barefoot-comfort bands; burn-risk literature puts real danger above ~130°F. */
export function sandVerdict(tempF: number): SandVerdict {
  if (tempF < 95) return { label: "Barefoot fine", advice: "comfortable underfoot", color: "#34d399" };
  if (tempF < 115) return { label: "Warm", advice: "quick barefoot walks OK", color: "#fbbf24" };
  if (tempF < 130) return { label: "Hot", advice: "sandals recommended", color: "#fb923c" };
  return { label: "Scorching", advice: "burn risk — wear shoes", color: "#fb7185" };
}

/** Scale bounds for the visual barefoot meter. */
export const SAND_SCALE_MIN_F = 70;
export const SAND_SCALE_MAX_F = 155;

export type SandHour = {
  time: string;
  soilTempF?: number;
  solarWm2?: number;
  windSpeedMph?: number;
  precipIn?: number;
  cloudCoverPct?: number;
};

/**
 * The sand-model inputs for the hour bucket that contains `nowMs` (recent rain
 * summed over that hour + the two before). One source of truth for "now" so the
 * Beach Day score, the metric card, and the panel agree on which hour — and thus
 * which value. Returns undefined when no bucket is within ~2h of now.
 */
/**
 * Optional "now" overrides for inputs where a live consensus beats the single
 * hourly-forecast value (cloud cover: the median across NWS/MET/Open-Meteo/etc.,
 * the same number the Sky card shows).
 */
export interface SandNowOverride {
  cloudCoverPct?: number;
}

function currentSandInput(
  hours: SandHour[],
  nowMs: number = Date.now(),
  override?: SandNowOverride,
): SandTempInput | undefined {
  if (!hours.length) return undefined;
  // Prefer the bucket that actually contains now under half-open [start, start+1h)
  // — matches score.ts's convention. Latest such bucket if any overlap; else the
  // nearest bucket.
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < hours.length; i++) {
    const start = new Date(hours[i].time).getTime();
    if (start <= nowMs && nowMs < start + 3600_000) best = i;
    const dist = Math.abs(start - nowMs);
    if (dist < bestDist) bestDist = dist;
  }
  if (best < 0) {
    for (let i = 0; i < hours.length; i++) {
      if (Math.abs(new Date(hours[i].time).getTime() - nowMs) === bestDist) {
        best = i;
        break;
      }
    }
  }
  // Only trust a bucket within 2h of now (stale/misaligned data → no estimate).
  if (best < 0 || Math.abs(new Date(hours[best].time).getTime() - nowMs) > 2 * 3600_000)
    return undefined;
  const h = hours[best];
  const recentRainIn = [best, best - 1, best - 2].reduce((a, j) => a + (hours[j]?.precipIn ?? 0), 0);
  return {
    soilTempF: h.soilTempF,
    solarWm2: h.solarWm2,
    windSpeedMph: h.windSpeedMph,
    recentRainIn,
    cloudCoverPct: override?.cloudCoverPct ?? h.cloudCoverPct,
  };
}

/** The "right now" dry-sand (dunes) estimate — used by the Beach Day score. */
export function currentSandTempF(
  hours: SandHour[],
  nowMs: number = Date.now(),
  override?: SandNowOverride,
): number | undefined {
  const input = currentSandInput(hours, nowMs, override);
  return input ? estimateSandTempF(input) : undefined;
}

/**
 * The "right now" surf-to-dunes range — used by BOTH the metric card and the
 * SandTempPanel so they display the same value, from the same bucket as the score.
 */
export function currentSandRangeF(
  hours: SandHour[],
  nowMs: number = Date.now(),
  override?: SandNowOverride,
): { surfF: number; dunesF: number } | undefined {
  const input = currentSandInput(hours, nowMs, override);
  return input ? estimateSandRangeF(input) : undefined;
}
