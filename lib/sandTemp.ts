// Estimated beach-sand surface temperature. Nobody measures sand directly, so
// this is an empirical model: start from the weather model's ground-surface
// temperature (soil_temperature_0cm) and add a "dry sand" boost — loose dry
// sand insulates, so solar heat piles up in the top layer and runs well above
// generic modeled ground. The boost grows with solar radiation and is damped
// by wind (convective cooling) and recent rain (wet sand conducts heat away).
// Guidance only — calibrated to "is it comfortable barefoot", not lab accuracy.

/** Full Florida midsummer noon sun is ~900-1000 W/m²; treat 900 as "full". */
const FULL_SUN_WM2 = 900;
/** Max extra °F dry sand runs above the modeled ground surface in full sun. */
const MAX_SUN_BOOST_F = 18;

export interface SandTempInput {
  /** Modeled ground-surface temp (°F), e.g. Open-Meteo soil_temperature_0cm. */
  soilTempF?: number;
  /** Solar radiation hitting the ground (W/m²). */
  solarWm2?: number;
  windSpeedMph?: number;
  /** Rain over the last few hours (inches) — wet sand barely heats. */
  recentRainIn?: number;
}

/** Estimated dry-sand surface temperature (°F), or undefined without a basis. */
export function estimateSandTempF(input: SandTempInput): number | undefined {
  const { soilTempF, solarWm2, windSpeedMph, recentRainIn } = input;
  if (soilTempF == null) return undefined;

  const sunFrac = Math.min(1, Math.max(0, (solarWm2 ?? 0) / FULL_SUN_WM2));
  let boost = sunFrac * MAX_SUN_BOOST_F;

  // A steady breeze strips heat off the surface: -50% by ~15 mph, floor -65%.
  const wind = Math.max(0, windSpeedMph ?? 0);
  boost *= Math.max(0.35, 1 - wind / 30);

  // Rain in the last few hours keeps the top layer damp and conductive.
  if ((recentRainIn ?? 0) >= 0.05) boost *= 0.3;

  return Math.round(soilTempF + boost);
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
export const SAND_SCALE_MAX_F = 145;

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
