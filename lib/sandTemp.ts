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
 * Calibrated against IR-thermometer ground truth at Boca on 2026-06-11
 * (~2 PM: soil 98°F, ~980 W/m², 11 mph): measured 140°F by the dunes and
 * 130°F near the surf, vs the original model's 109°F.
 */
const MAX_SUN_BOOST_F = 50;
/** Near-surf sand is firmer/damper; it keeps ~75% of the dry-sand boost. */
const SURF_BOOST_FRACTION = 0.75;

export interface SandTempInput {
  /** Modeled ground-surface temp (°F), e.g. Open-Meteo soil_temperature_0cm. */
  soilTempF?: number;
  /** Solar radiation hitting the ground (W/m²). */
  solarWm2?: number;
  windSpeedMph?: number;
  /** Rain over the last few hours (inches) — wet sand barely heats. */
  recentRainIn?: number;
}

/** The sun/wind/rain boost (°F) dry sand carries above the modeled ground. */
function sandBoostF(input: SandTempInput): number | undefined {
  const { soilTempF, solarWm2, windSpeedMph, recentRainIn } = input;
  if (soilTempF == null) return undefined;

  const sunFrac = Math.min(1, Math.max(0, (solarWm2 ?? 0) / FULL_SUN_WM2));
  let boost = sunFrac * MAX_SUN_BOOST_F;

  // A breeze takes some edge off the surface, but radiative heating dominates:
  // the 140°F dune reading was taken in an 11 mph sea breeze.
  const wind = Math.max(0, windSpeedMph ?? 0);
  boost *= Math.max(0.6, 1 - wind / 60);

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

/**
 * The sand estimate for the hour bucket nearest `nowMs`, with recent rain
 * summed over that hour and the two before it. This is the "right now" value
 * used by the metric card and the Beach Day score.
 */
export function currentSandTempF(
  hours: Array<{
    time: string;
    soilTempF?: number;
    solarWm2?: number;
    windSpeedMph?: number;
    precipIn?: number;
  }>,
  nowMs: number = Date.now(),
): number | undefined {
  if (!hours.length) return undefined;
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < hours.length; i++) {
    const dist = Math.abs(new Date(hours[i].time).getTime() - nowMs);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  // Only trust a bucket within 2h of now (stale/misaligned data → no estimate).
  if (best < 0 || bestDist > 2 * 3600_000) return undefined;
  const h = hours[best];
  const recentRainIn = [best, best - 1, best - 2].reduce(
    (a, j) => a + (hours[j]?.precipIn ?? 0),
    0,
  );
  return estimateSandTempF({
    soilTempF: h.soilTempF,
    solarWm2: h.solarWm2,
    windSpeedMph: h.windSpeedMph,
    recentRainIn,
  });
}
