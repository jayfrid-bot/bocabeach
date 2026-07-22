// ---------------------------------------------------------------------------
// Feels-like beach temperature — an on-the-towel comfort number that beats a
// plain weather-app heat index because it also accounts for the two things a
// beach uniquely piles on top of ambient heat: direct overhead sun beating
// down on bare skin, and radiant heat coming back UP off hot sand. A stock
// heat index only ever looks at air temperature + humidity in the shade.
//
// Composition: NOAA heat index (Rothfusz regression + its documented low-temp
// fallback) as the base, then three beach-specific adjustments layered on:
//   + solar radiant load   (direct sun on skin)
//   + sand/ground radiant load (heat re-radiating off hot sand)
//   − wind cooling          (evaporative/convective relief, damped by humidity)
//
// FIRST-GUESS CALIBRATION: the three add-on terms (solar, sand, wind) are
// physically-reasoned starting points, not field-fit the way lib/sandTemp.ts's
// constants are — there is no equivalent of that file's IR-thermometer
// ground-truth log for "how hot does a beachgoer's skin actually feel". Every
// constant below carries a rationale comment so the owner can retune once real
// feedback comes in, the same posture lib/sandTemp.ts had before its first
// calibration pass.
//
// Self-contained by design: no import from lib/conditions.ts or any data
// source — every input arrives as an explicit, named field on FeelsLikeInput
// so this module (and the card built on it) can be unit-tested and wired up
// independently of the rest of the dashboard.
// ---------------------------------------------------------------------------

import { clamp } from "@/lib/util";

// --- NOAA heat index (Rothfusz regression) ----------------------------------
// Source: the NWS Weather Prediction Center's published heat-index algorithm —
// a multiple regression (Rothfusz 1990) fit to Steadman's 1979 "apparent
// temperature" tables. This is THE standard US heat index, the number every
// weather app quotes, so the coefficients are transcribed verbatim rather than
// re-derived.

/**
 * Full Rothfusz regression coefficients. Only used once the simple estimate
 * below says we're plausibly in heat-index territory (heatIndexF's 80°F
 * handoff) — Rothfusz fit this polynomial specifically to the T>=80°F region
 * and it can misbehave outside it.
 */
const HI_C1 = -42.379;
const HI_C2 = 2.04901523;
const HI_C3 = 10.14333127;
const HI_C4 = -0.22475541;
const HI_C5 = -6.83783e-3;
const HI_C6 = -5.481717e-2;
const HI_C7 = 1.22874e-3;
const HI_C8 = 8.5282e-4;
const HI_C9 = -1.99e-6;

/**
 * Below the full-regression threshold, NOAA's own fallback is this simpler
 * Steadman-derived average estimate — NOT "heat index = air temp", which is
 * how a lot of hobbyist implementations wrongly simplify the low-temp case.
 * Using the real NOAA fallback keeps the curve continuous right up to the
 * 80°F handoff instead of jumping.
 */
function simpleHeatIndexF(tempF: number, rhPct: number): number {
  return 0.5 * (tempF + 61 + (tempF - 68) * 1.2 + rhPct * 0.094);
}

/**
 * NOAA/NWS heat index (°F) from air temperature (°F) and relative humidity
 * (0-100%). Implements the full Rothfusz regression once the simple estimate
 * clears NOAA's 80°F handoff (averaged with the air temp itself), its
 * documented low-RH and high-RH corrections, and the low-temperature fallback
 * (the simple Steadman estimate) below that.
 */
export function heatIndexF(tempF: number, rhPct: number): number {
  const rh = clamp(rhPct, 0, 100);
  const simple = simpleHeatIndexF(tempF, rh);
  // NOAA's own gate: average the simple estimate with the actual air temp —
  // if that average is under 80°F, heat isn't compounding enough for the full
  // regression to mean anything, so the simple estimate stands as-is.
  if ((simple + tempF) / 2 < 80) return simple;

  const T = tempF;
  const R = rh;
  let hi =
    HI_C1 +
    HI_C2 * T +
    HI_C3 * R +
    HI_C4 * T * R +
    HI_C5 * T * T +
    HI_C6 * R * R +
    HI_C7 * T * T * R +
    HI_C8 * T * R * R +
    HI_C9 * T * T * R * R;

  // NOAA's published corrections for the regression's known edge behavior: it
  // runs a bit hot in very dry air and a bit cool in very humid air, each
  // within a specific temperature band.
  if (R < 13 && T >= 80 && T <= 112) {
    hi -= ((13 - R) / 4) * Math.sqrt((17 - Math.abs(T - 95)) / 17);
  } else if (R > 85 && T >= 80 && T <= 87) {
    hi += ((R - 85) / 10) * ((87 - T) / 5);
  }
  return hi;
}

// --- Beach-specific add-on terms --------------------------------------------

/**
 * Peak solar radiant load (°F) added at FULL overhead sun with zero cloud —
 * the "standing on open sand at solar noon" ceiling. FIRST GUESS: the
 * heat-index folk rule of "add up to 15°F in full sunshine" is calibrated for
 * an inland shade-vs-sun comparison; a beachgoer is already mostly bare skin
 * with no shade baseline to subtract from, so we start conservatively lower
 * (8°F) rather than double-counting sun that's already implicit in a hot beach
 * day. Tune upward if the number under-reacts to blazing, cloudless sun.
 */
const MAX_SOLAR_RADIANT_F = 8;

/**
 * How much of the peak solar term survives as a function of the sun's
 * elevation, when known. sin(elevation) is the standard first-order model for
 * direct-beam irradiance on a horizontal surface (Lambert's cosine law from
 * the surface normal): overhead sun (90°) delivers the full beam, a sun near
 * the horizon (~0°) delivers almost none. Simple and defensible without a full
 * atmospheric-transmission model for what's ultimately a comfort estimate.
 */
function elevationFraction(sunElevationDeg: number): number {
  return clamp(Math.sin((sunElevationDeg * Math.PI) / 180), 0, 1);
}

/**
 * Full-sun ground irradiance (W/m²), used ONLY as a day/strength fallback
 * signal when no explicit sun elevation is supplied but a modeled GHI
 * (solarWm2) is. Mirrors lib/sandTemp.ts's FULL_SUN_WM2 — the same physical
 * ceiling (peak Florida midsummer sun, ~950-1000 W/m² per that file's field
 * notes) — kept as a local constant rather than an import so this module stays
 * self-contained and dependency-free.
 */
const FULL_SUN_WM2_FALLBACK = 1000;

export interface SolarRadiantInput {
  /** Cloud cover 0-100% (0 = full sun); the direct-beam damping term. */
  cloudCoverPct?: number;
  /** Sun elevation above the horizon, degrees. <=0 (or night) → 0 term. */
  sunElevationDeg?: number;
  /** Modeled ground solar irradiance (W/m²) — a day/strength fallback used
   *  only when sunElevationDeg is not supplied. */
  solarWm2?: number;
  /** Explicit day/night flag (mirrors WeatherData.isDaytime) — false forces
   *  the term to 0 even if cloud/elevation/solarWm2 suggest otherwise. */
  isDaytime?: boolean;
}

/**
 * The solar radiant-load add-on (°F): up to MAX_SOLAR_RADIANT_F at full
 * overhead sun with zero cloud, scaled down by cloud cover and (when known)
 * how low the sun sits, and zeroed outright at night.
 */
export function solarRadiantF(input: SolarRadiantInput): number {
  const { cloudCoverPct, sunElevationDeg, solarWm2, isDaytime } = input;

  if (isDaytime === false) return 0;
  if (sunElevationDeg != null && sunElevationDeg <= 0) return 0;
  // No explicit elevation/isDaytime signal at all: a modeled irradiance of
  // (near) zero is the honest "it's dark" tell (matches HourlyMetrics.solarWm2
  // reading 0 overnight).
  if (sunElevationDeg == null && isDaytime == null && solarWm2 != null && solarWm2 <= 0) {
    return 0;
  }

  const cloudFrac = 1 - clamp(cloudCoverPct ?? 0, 0, 100) / 100;
  const elevFrac =
    sunElevationDeg != null
      ? elevationFraction(sunElevationDeg)
      : solarWm2 != null
        ? clamp(solarWm2 / FULL_SUN_WM2_FALLBACK, 0, 1)
        : // Neither elevation nor irradiance given, but nothing says it's
          // night either: don't invent a discount we have no signal for —
          // let cloud cover alone govern the term.
          1;

  return MAX_SOLAR_RADIANT_F * cloudFrac * elevFrac;
}

/**
 * Coefficient turning the sand-minus-air temperature gap into added °F of felt
 * radiant heat off the ground. FIRST GUESS: a body near hot sand gets some,
 * not all, of that gap radiated back at it (unlike direct sun, ground radiance
 * is diffuse and only reaches the body from below/the side). 0.06 means the
 * everyday scorching-afternoon case — ~140°F sand against ~90°F air, a 50°F
 * gap (see lib/sandTemp.ts field notes) — lands at a felt +3°F, a real but
 * modest nudge; only the most extreme gap (lib/sandTemp.ts's own ~145°F dune
 * ceiling against a mild ~70°F morning, a 75°F gap) reaches the cap below.
 */
const SAND_RADIANT_COEFF = 0.06;

/** Ceiling on the sand radiant term — even blistering sand doesn't add more
 *  than a further ~4°F of felt ambient heat; most of that temperature gap's
 *  energy goes into direct conduction to bare feet, not ambient felt heat
 *  (which is what this whole comfort number is estimating). */
const SAND_RADIANT_MAX_F = 4;

/**
 * The sand/ground radiant-load add-on (°F): how much hotter the sand runs than
 * the air, scaled down to a felt-heat contribution and capped. 0 (never
 * negative) when the sand is at or below air temp — cooler sand doesn't make
 * the air feel colder, it just contributes nothing extra.
 */
export function sandRadiantF(sandTempF?: number, airTempF?: number): number {
  if (sandTempF == null || airTempF == null) return 0;
  return clamp((sandTempF - airTempF) * SAND_RADIANT_COEFF, 0, SAND_RADIANT_MAX_F);
}

/** Wind below this speed does essentially nothing for evaporative/convective
 *  cooling at the beach — light air, a "still" sea-breeze day. */
const WIND_COOL_FREE_MPH = 5;

/**
 * °F of cooling per mph of wind above the free threshold. FIRST GUESS:
 * roughly a third of a degree per mph is in the ballpark of how convective
 * cooling on warm skin is usually eyeballed — gentler than winter wind chill,
 * since this is relief on already-warm skin, not fighting a cold-temperature
 * deficit.
 */
const WIND_COOL_PER_MPH_F = 0.35;

/** Ceiling on wind cooling — even a stiff, sand-blasting 25+ mph gale doesn't
 *  erase a double-digit heat-index number; the other factors (radiant heat,
 *  core heat already banked) don't vanish just because it's breezy. */
const WIND_COOL_CAP_F = 7;

/**
 * Above this relative humidity, sweat can't evaporate efficiently, so wind's
 * cooling becomes mostly-convective-only — call it roughly half as effective.
 * Mirrors the same "humidity matters more past a threshold" shape used
 * elsewhere in the app (lib/score.ts's comfortScore penalizes RH>85%), pulled
 * down to 70% here because wind's evaporative component starts losing bite
 * before dew-point discomfort itself sets in.
 */
const WIND_COOL_HUMID_THRESHOLD_PCT = 70;

/** How much humidity above the threshold damps wind's cooling effectiveness. */
const WIND_COOL_HUMID_DAMP = 0.5;

/**
 * The wind-cooling subtraction (°F): ~WIND_COOL_PER_MPH_F per mph above
 * WIND_COOL_FREE_MPH, capped at WIND_COOL_CAP_F, halved when humidity is high
 * enough to choke off evaporative cooling.
 */
export function windCoolingF(windSpeedMph?: number, humidityPct?: number): number {
  if (windSpeedMph == null) return 0;
  const excess = Math.max(0, windSpeedMph - WIND_COOL_FREE_MPH);
  let cooling = Math.min(WIND_COOL_CAP_F, excess * WIND_COOL_PER_MPH_F);
  if (humidityPct != null && humidityPct > WIND_COOL_HUMID_THRESHOLD_PCT) {
    cooling *= WIND_COOL_HUMID_DAMP;
  }
  return cooling;
}

// --- Bands -------------------------------------------------------------------

export type FeelsLikeBand = "pleasant" | "warm" | "hot" | "scorching";

/**
 * Band cutoffs. OWNER-SET FIRST GUESS: shifted several degrees above the
 * plain NWS heat-index caution bands (80/90/103/125) because this number
 * already runs hotter than a stock heat index — it bakes in sun and sand on
 * top. Reusing the stock bands unchanged would have nearly every sunny beach
 * afternoon reading "danger" the moment the solar/sand terms kick in, which
 * would make the band meaningless as a day-to-day signal.
 */
const PLEASANT_MAX_F = 88; // exclusive upper bound — "pleasant" is <88
const WARM_MAX_F = 95; // inclusive upper bound — "warm" is 88-95
const HOT_MAX_F = 103; // inclusive upper bound — "hot" is 96-103; ≥104 = scorching

/** The comfort band a feels-like reading falls into. */
export function feelsLikeBand(tempF: number): FeelsLikeBand {
  if (tempF < PLEASANT_MAX_F) return "pleasant";
  if (tempF <= WARM_MAX_F) return "warm";
  if (tempF <= HOT_MAX_F) return "hot";
  return "scorching";
}

export interface FeelsLikeBandInfo {
  label: string;
  /** Accent hex — reuses the exact tone palette lib/sandTemp.ts's sandVerdict
   *  uses for its barefoot-comfort bands (emerald/amber/orange/rose), so the
   *  two beach-heat readouts read as the same visual language. */
  color: string;
  /** Tailwind text colour, light + dark — same convention as lib/scoreBands.ts. */
  textClass: string;
}

const BAND_INFO: Record<FeelsLikeBand, FeelsLikeBandInfo> = {
  pleasant: { label: "Pleasant", color: "#34d399", textClass: "text-emerald-600 dark:text-emerald-400" },
  warm: { label: "Warm", color: "#fbbf24", textClass: "text-amber-600 dark:text-amber-400" },
  hot: { label: "Hot", color: "#fb923c", textClass: "text-orange-600 dark:text-orange-400" },
  scorching: { label: "Scorching", color: "#fb7185", textClass: "text-rose-600 dark:text-rose-400" },
};

/** Display metadata (label + tone colors) for a comfort band. */
export function feelsLikeBandInfo(band: FeelsLikeBand): FeelsLikeBandInfo {
  return BAND_INFO[band];
}

// --- Drivers -------------------------------------------------------------

/** Minimum °F swing for a term to be worth naming as a driver — anything
 *  smaller is noise the reader doesn't need called out. */
const DRIVER_MIN_F = 1;
/** Solar driver phrase tiers (°F contributed). */
const SOLAR_BLAZING_F = 6;
const SOLAR_STRONG_F = 3;
/** Sand driver phrase tier (°F contributed). */
const SAND_SCORCHING_F = 3;
/** Wind driver phrase tiers (°F of cooling) — BRISK sits near the 7°F cap
 *  (only reachable at high wind speeds), STEADY covers the common case. */
const WIND_BRISK_F = 6;
const WIND_STEADY_F = 2;

function formatDriver(label: string, deltaF: number): string {
  const sign = deltaF >= 0 ? "+" : "−"; // real minus sign, not a hyphen
  return `${label} ${sign}${Math.round(Math.abs(deltaF))}°`;
}

/** Short phrases for the top ±contributors, sorted by |magnitude|, largest first. */
function buildDrivers(solarF: number, sandF: number, windCoolF: number): string[] {
  const contributions: { label: string; deltaF: number }[] = [];
  if (solarF >= DRIVER_MIN_F) {
    const label =
      solarF >= SOLAR_BLAZING_F ? "blazing sun" : solarF >= SOLAR_STRONG_F ? "strong sun" : "hazy sun";
    contributions.push({ label, deltaF: solarF });
  }
  if (sandF >= DRIVER_MIN_F) {
    const label = sandF >= SAND_SCORCHING_F ? "scorching sand" : "warm sand";
    contributions.push({ label, deltaF: sandF });
  }
  if (windCoolF >= DRIVER_MIN_F) {
    const label =
      windCoolF >= WIND_BRISK_F ? "brisk wind" : windCoolF >= WIND_STEADY_F ? "steady breeze" : "light breeze";
    contributions.push({ label, deltaF: -windCoolF });
  }
  return contributions
    .sort((a, b) => Math.abs(b.deltaF) - Math.abs(a.deltaF))
    .map((c) => formatDriver(c.label, c.deltaF));
}

// --- Composite ---------------------------------------------------------------

export interface FeelsLikeInput {
  /** Air temperature, °F. Required — honest-null without it. */
  airTempF?: number;
  /** Relative humidity, 0-100%. Required — honest-null without it. */
  humidityPct?: number;
  /** Wind speed, mph. */
  windSpeedMph?: number;
  /** Cloud cover 0-100% (0 = full sun); damps the solar term. */
  cloudCoverPct?: number;
  /** Estimated dry-sand surface temp, °F (lib/sandTemp.ts's estimate). */
  sandTempF?: number;
  /** Sun elevation above the horizon, degrees, when known. */
  sunElevationDeg?: number;
  /** Modeled ground solar irradiance, W/m² (lib/types.ts HourlyMetrics.solarWm2). */
  solarWm2?: number;
  /** Explicit day/night flag (lib/types.ts WeatherData.isDaytime). */
  isDaytime?: boolean;
}

export interface FeelsLikeResult {
  /** The feels-like number, °F, rounded to the nearest degree. */
  tempF: number;
  band: FeelsLikeBand;
  /** Short phrases for the top ±contributors, e.g. "blazing sun +6°". Empty
   *  when every add-on term is negligible (e.g. a mild, calm, shaded hour). */
  drivers: string[];
}

/**
 * The feels-like beach temperature: NOAA heat index plus sun + sand radiant
 * load, minus wind cooling. Honest-null (undefined) when air temp or
 * humidity — the two heat-index inputs with no substitute — are missing.
 * Night is a valid state (the sun term simply drops to 0), not a null case.
 */
export function feelsLikeBeach(input: FeelsLikeInput): FeelsLikeResult | undefined {
  const { airTempF, humidityPct } = input;
  if (airTempF == null || humidityPct == null) return undefined;

  const base = heatIndexF(airTempF, humidityPct);
  const solar = solarRadiantF({
    cloudCoverPct: input.cloudCoverPct,
    sunElevationDeg: input.sunElevationDeg,
    solarWm2: input.solarWm2,
    isDaytime: input.isDaytime,
  });
  const sand = sandRadiantF(input.sandTempF, airTempF);
  const windCool = windCoolingF(input.windSpeedMph, humidityPct);

  const tempF = Math.round(base + solar + sand - windCool);
  return {
    tempF,
    band: feelsLikeBand(tempF),
    drivers: buildDrivers(solar, sand, windCool),
  };
}
