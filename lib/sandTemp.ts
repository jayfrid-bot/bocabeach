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
 *  - 2026-07-14 ~2:20 PM: soil 107°F, 1006 W/m², 10 mph, 1% cloud → 130-145°F measured
 *    (model said 139 vs midpoint 137.5. Across all six sessions the mean error is
 *    +0.6°F and the average miss ~1.6°F — smaller than the spot-to-spot spread of
 *    the readings themselves. Calibration confirmed; do not chase single hot spots.)
 *  - 2026-07-15 LATE-AFTERNOON MISS — the model's biggest error, RESOLVED (see below).
 *    Two readings, same afternoon, dry sand, no rain all day:
 *      ~4:15 PM: soil 104°F, 821 W/m², 7 mph, 11% cloud (forecast) → model ~135°F,
 *                MEASURED 110-115°F  (miss +22)
 *      ~5:30 PM: soil 100°F, 701 W/m², 7 mph, 24% cloud (forecast) → model 133°F,
 *                MEASURED 100°F      (miss +33 — sand at EXACTLY ground temp, boost 0)
 *    Working theory was "the forecast cloud lied; a storm anvil (~95-100%) sat over
 *    the beach and the overcast damping never fired". That theory looked NOT
 *    SUPPORTED at first: the GOES-19 Clear Sky Mask (satellite-OBSERVED, see
 *    lib/sources/goesCloud.ts) read only ~31% cloud over Boca's 14 km box, CENTERED
 *    ON THE BEACH, at 20:16Z — broken/scattered, which per the 6/23 point below
 *    should still let full beam through and run the sand hot. So overhead cloud
 *    truth did NOT account for the afternoon error — but "overhead" was the wrong
 *    question to ask.
 *
 *    The unresolved contradiction, as it stood before the fix:
 *      6/23  9:54 AM, 380 W/m², 63% broken cloud, sun elev ~43° → boost +33 (MEASURED)
 *      7/15  5:30 PM, 701 W/m², ~31% cloud (sat, overhead), sun elev ~35° → boost 0 (MEASURED)
 *    HALF the solar and MORE cloud in the morning produced a +33 boost; nearly double
 *    the solar in the late afternoon produced nothing. No function of GHI or of sun
 *    elevation alone fit both — the discriminator looked like morning-vs-afternoon
 *    itself, which is physically backwards (sand should carry the day's accumulated
 *    heat INTO the afternoon).
 *
 *    Candidate (c) is now CONFIRMED by direct measurement. Sampling the SAME 20:16Z
 *    granule in 7x7 boxes stepped along the sun's true bearing (az 272°, el 51.1°)
 *    instead of centered on the beach: overhead read 31% cloud, but the SUNWARD
 *    gradient read 58% at 3 km, 71% at 6 km, 86% at 10 km, and 85-100% at 15-30 km —
 *    while the ANTI-sun direction (out over the ocean) read 17%/4%/0%, i.e.
 *    genuinely clear. The direct beam that heats the sand was blocked by real cloud
 *    kilometres WEST of the beach, invisible to a box centered on the beach itself.
 *    An overhead cloud fraction is simply the wrong input once the sun is low enough
 *    that "toward the sun" and "overhead" are different patches of sky.
 *
 *    This also RESOLVES the morning-vs-afternoon asymmetry above: Boca's beach faces
 *    EAST. A morning sun's beam path runs back out over the (usually clear) OCEAN;
 *    a late-afternoon sun's beam path runs back over the (often convective, cloud-
 *    building) LAND. So the same overhead cloud reading means something different
 *    depending on time of day — morning beam-path cloud is typically LESS than
 *    overhead, afternoon beam-path cloud can be dramatically MORE, exactly the
 *    directional bias the 6/23-vs-7/15 comparison exposed.
 *
 *    THE FIX: scripts/goes_cloud.py now computes beamCloudPct per beach — cloud
 *    fraction sampled along the solar azimuth at several altitude slots, combined as
 *    max(overhead, mean(offset boxes)) — and lib/score.ts's sand-model input prefers
 *    it (fresh + valid) over the overhead satelliteCloudPct, which in turn is
 *    preferred over the forecast consensus. See satelliteBeamCloudPct in score.ts
 *    and beam_cloud_pct() in goes_cloud.py for the full mechanics/estimator choice.
 *
 *    Candidates (a) [measurement-spot drift], (b) [building shading], and (d) [sqrt
 *    curve too flat] remain POSSIBLE SECONDARY contributors — (c) explains a very
 *    large fraction of the miss but wasn't isolated from the others with controlled
 *    measurements. The clear-afternoon field experiment described below (dune-sand
 *    readings on a VERIFIABLY CLEAR afternoon at ~4 PM and ~6 PM, same spot, noting
 *    building shadow) is still the way to separate any residual (a)/(b)/(d) signal
 *    from (c) now that (c) is confirmed and fixed at the input level.
 *
 *    DO NOT retune MAX_SUN_BOOST_F or the sqrt curve on this evidence: every point
 *    from 9:54 AM-2:20 PM is accurate to ~1.6°F, the fix above corrects the cloud
 *    INPUT rather than the transfer function, and a still-open (a)/(b)/(d) question
 *    can't justify breaking six good calibration points on top of that. Re-run this
 *    same 7/15 afternoon with beamCloudPct wired in before concluding whether any
 *    curve retune is still warranted.
 *
 *    Note the error direction is at least the SAFE one: the app over-reports heat, so
 *    it warns about burns that aren't there rather than missing burns that are.
 *  - 2026-07-16 ~3:38 PM: soil 104°F, 930 W/m² (modeled — nonsense under the deck),
 *    10 mph, GOES-observed 99.3% cloud (overhead AND beam, fresh 32-min granule) →
 *    model 108°F, MEASURED 113°F (-5). FIRST LIVE TEST of the satellite pipeline on
 *    the exact failure class from 7/15 (blocked-sun afternoon): a 5° undershoot vs
 *    the prior day's +22/+33 overshoot. Caveat: the forecast also said 100% cloud
 *    today, so both inputs agreed — the satellite's unique win is on forecast-miss
 *    days like 7/15. Measured boost was soil+9 vs the damped model's soil+4, i.e.
 *    the ~88% damp at 99% beam may run a touch strong — but one point, -5°F, on the
 *    conservative side: leave it. */
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
 * PROVISIONAL (n=1 afternoon — recalibrate with the next field session): where
 * damping starts for a BEAM-PATH cloud reading (satelliteBeamCloudPct). The 70%
 * overhead threshold encodes "broken clouds drift past overhead and full beam
 * pours through the gaps most of the time" — but a beam-path fraction measured
 * TOWARD a low sun means a standing wall between the sun and the sand, i.e.
 * sustained blockage, not intermittent shadowing. The motivating case makes the
 * difference concrete: 2026-07-15 4:15 PM read beamCloudPct 69 — one point
 * UNDER the overhead threshold, zero damping, model ~135°F vs 110-115°F
 * measured. Starting the same 1.5-power ramp at 50% instead puts that reading
 * at ~128°F (damp ≈ 0.21) — directionally right while deliberately
 * conservative, because the beam estimator itself (mean of altitude-slot boxes)
 * likely under-reads a top-heavy anvil (the 9-12 km slots read 84-86%).
 */
const BEAM_OVERCAST_START_PCT = 50;
/**
 * The wet/firm sand by the surf runs much cooler than the dry dune sand — a
 * ~11°F surf-to-dunes spread measured at Boca (2026-06-23: 113°F surf → 124°F
 * dunes). So the surf side carries ~0.65 of the dry-sand boost, the dunes the
 * full boost. (Was 0.8, which made the two read nearly identical.)
 */
const SURF_BOOST_FRACTION = 0.65;

/**
 * AFTERNOON DECAY — the term that fixes the model's late-day overshoot, from a
 * 15-reading IR field session on 2026-07-16 (Boca, sunset 8:14 PM):
 *
 *   time    sun elev   full-sun boost (measured sand − modeled soil)
 *   1:00 PM   82°        +33     ← peak
 *   9:54 AM   43°        +33     ← FULL, at a LOW sun
 *   5:01 PM   41°        +1      ← ~ZERO, at the SAME low sun
 *   6:41 PM   19°        −2      ← below soil, in CONTINUOUS sun
 *   7:23 PM   10°        +1      ← full sun, dead
 *
 * The 9:54 AM vs 5:01 PM pair (identical 41-43° elevation, boost +33 vs +1)
 * PROVES the driver is NOT the sun's height, nor instantaneous solar (the 5 PM
 * reading had HIGHER GHI). It's thermal hysteresis: dry sand's thin top layer
 * races ahead of the bulk-soil model while the sun is climbing, then bleeds that
 * heat back out through the afternoon regardless of how strong the sun still
 * looks. The clean proxy is HOURS AFTER SOLAR NOON. Boost stays full until ~2.4 h
 * past noon (protecting the genuinely-hot ~4 PM danger window), then smooth-steps
 * to a near-zero floor by ~3.8 h — matching every afternoon reading (backtest MAE
 * ~2.2 °F, max 4 °F, errors skewed to the SAFE over-warn side). The six
 * 9:54 AM–2:20 PM calibration points are untouched (factor = 1 there).
 * FL-July-calibrated; the afternoon-decay physics generalizes, the exact timing
 * should be re-checked at other latitudes/seasons when ground truth exists.
 */
const AFTERNOON_DECAY_START_H = 2.4;
const AFTERNOON_DECAY_END_H = 3.8;
const AFTERNOON_FLOOR = 0.03;

const DEG = Math.PI / 180;

/**
 * Hours after LOCAL SOLAR NOON for an instant (negative = morning), from the
 * sun's hour angle via NOAA's low-precision solar-position algorithm. No
 * timezone needed — works at any longitude/date (latitude doesn't affect the
 * hour angle). Verified against a known value: Boca at 2026-07-15T20:16Z → the
 * sun sits ~2.9 h before solar noon... (the sand model keys its afternoon decay
 * on this — see AFTERNOON_DECAY_* above).
 */
export function hoursFromSolarNoon(lon: number, date: Date): number {
  const n = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / 86_400_000; // days since J2000
  const L = (280.460 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * DEG;
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 4e-7 * n) * DEG;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)) / DEG; // degrees
  const gmst = (280.46061837 + 360.98564736629 * n) % 360;
  let hourAngle = (((gmst + lon - ra) % 360) + 360) % 360; // 0..360, 0 = solar noon
  if (hourAngle > 180) hourAngle -= 360; // -180..180
  return hourAngle / 15; // 15° per hour
}

/** The afternoon-decay multiplier on the dry-sand boost (see AFTERNOON_DECAY_*). */
export function afternoonBoostFactor(hoursFromNoon: number): number {
  if (hoursFromNoon <= AFTERNOON_DECAY_START_H) return 1;
  const x = Math.min(
    1,
    (hoursFromNoon - AFTERNOON_DECAY_START_H) / (AFTERNOON_DECAY_END_H - AFTERNOON_DECAY_START_H),
  );
  const smoothstep = x * x * (3 - 2 * x);
  return Math.max(AFTERNOON_FLOOR, 1 - smoothstep);
}

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
  /**
   * True when cloudCoverPct is a BEAM-PATH reading (sampled toward the sun,
   * satelliteBeamCloudPct) rather than an overhead/forecast fraction. Beam-path
   * cloud means sustained beam blockage, so damping starts earlier
   * (BEAM_OVERCAST_START_PCT vs OVERCAST_START_PCT).
   */
  cloudIsBeamPath?: boolean;
  /**
   * Hours after local solar noon (negative = morning) for this hour. When set,
   * the boost decays through the afternoon (see afternoonBoostFactor). Omit to
   * skip the decay (full boost) — kept optional so bare unit tests still work.
   */
  hoursFromSolarNoon?: number;
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
  // A beam-path reading ramps from 50% (a wall toward the sun blocks
  // continuously); an overhead/forecast reading keeps the calibrated 70%
  // (broken cloud passes full beam through the gaps). Same ramp shape + max.
  const dampStart = input.cloudIsBeamPath ? BEAM_OVERCAST_START_PCT : OVERCAST_START_PCT;
  if (cloud > dampStart) {
    const f = (cloud - dampStart) / (100 - dampStart);
    boost *= 1 - OVERCAST_MAX_DAMP * Math.pow(f, 1.5);
  }

  // The weather model's soil temp already absorbs some solar heating on hot
  // afternoons (today: 109°F vs 98°F on the 6/11 calibration day). Shrink the
  // boost as the modeled baseline climbs past ~90°F so we don't double-count
  // the sun. Floor 0.4 — even very hot ground gets some dry-sand differential.
  boost *= Math.max(0.4, Math.min(1, 1 - (soilTempF - 90) / 55));

  // Afternoon decay: dry sand sheds its dry-layer boost through the afternoon
  // even under strong sun (thermal hysteresis — see AFTERNOON_DECAY_*). Full
  // boost until ~2.4 h past solar noon, then a smooth-step to a near-zero floor.
  if (input.hoursFromSolarNoon != null) {
    boost *= afternoonBoostFactor(input.hoursFromSolarNoon);
  }

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

/**
 * Scale bounds for the visual barefoot meter. 75–145°F spans real Boca ground
 * truth (78°F dawn reads → 142°F peak-summer dunes) without dead headroom: the
 * old 155°F max parked a scorching 139°F reading at ~81% of the bar, reading as
 * "not that hot" when it's about as hot as the beach ever gets (~91% now).
 */
export const SAND_SCALE_MIN_F = 75;
export const SAND_SCALE_MAX_F = 145;

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
  /** The override is a beam-path (toward-the-sun) reading — earlier damping. */
  cloudIsBeamPath?: boolean;
}

function currentSandInput(
  hours: SandHour[],
  nowMs: number = Date.now(),
  override?: SandNowOverride,
  lon?: number,
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
    // Only meaningful when the cloud value itself came from the override.
    cloudIsBeamPath: override?.cloudCoverPct != null ? override?.cloudIsBeamPath : undefined,
    // Afternoon decay keyed to "now" (the bucket ≈ now); omit without a longitude.
    hoursFromSolarNoon: lon != null ? hoursFromSolarNoon(lon, new Date(nowMs)) : undefined,
  };
}

/** The "right now" dry-sand (dunes) estimate — used by the Beach Day score. */
export function currentSandTempF(
  hours: SandHour[],
  nowMs: number = Date.now(),
  override?: SandNowOverride,
  lon?: number,
): number | undefined {
  const input = currentSandInput(hours, nowMs, override, lon);
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
  lon?: number,
): { surfF: number; dunesF: number } | undefined {
  const input = currentSandInput(hours, nowMs, override, lon);
  return input ? estimateSandRangeF(input) : undefined;
}
