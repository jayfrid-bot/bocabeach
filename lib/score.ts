import type {
  BestWindow,
  CapPolicy,
  DataCoverage,
  DayWindow,
  HourlyMetrics,
  ConditionsSnapshot,
  FlagColor,
  HourlyScore,
  RipRisk,
  SargassumRisk,
  ScoreResult,
  ScoringOptions,
  SubKey,
  SubScore,
  WaterQualityRating,
  WaveMode,
} from "@/lib/types";
import { clamp, degToCardinal, dewPointFromTempRH, plateau, round } from "@/lib/util";
import { estimateSurfFromSources, type SurfSourceResult } from "@/lib/surfHeight";
import { assessLightning, assessRain, type HazardAssessment } from "@/lib/hazards/assess";
import { resolveRipNow, ripCapFor, type RipNow } from "@/lib/ripRisk";
import { isAlertInEffectAt } from "@/lib/ripRisk/resolve";
import { isRipAlertEvent } from "@/lib/ripRisk/types";
import { modelNowFromSeries, type RipNwpsBeachSeries } from "@/lib/sources/ripNwps";
import { currentSandTempF, estimateSandTempF, hoursFromSolarNoon } from "@/lib/sandTemp";
import { seaState } from "@/lib/format";
import { scoreBand, SCORE_BANDS } from "@/lib/scoreBands";

// Consolidated, best-available values pulled across all sources.
/**
 * Which feed actually produced a displayed metric. Buoy coverage is per-FIELD
 * now (lib/sources/buoy.ts merges two stations field by field, because Boca's
 * primary C-MAN mast reports wind but structurally never waves), so "the buoy"
 * is no longer a single answer for the whole card — the nerd cards
 * (lib/nerdInfo.ts) name whichever station or model fed THIS number.
 */
export type MetricSource =
  | { kind: "buoy"; stationId?: string }
  /** `model` names WHICH model: "nwps" is the NWS nearshore wave model whose
   *  point sits at the beach; "open-meteo" is the marine model, whose grid
   *  cell for a coastal beach is routinely well offshore (Boca's is ~12 mi
   *  out in the Gulf Stream, 2026-10-08). Absent = unknown model. */
  | { kind: "model"; model?: "nwps" | "open-meteo" };

export interface Derived {
  airTempF?: number;
  waterTempF?: number;
  /** Where `waterTempF` came from: a named NDBC station, or the marine model's
   *  sea-surface field when no buoy reported WTMP. */
  waterTempSource?: MetricSource;
  /** Where `waveHeightFt` came from. In practice almost always the model —
   *  the nearest wave-reporting buoy to SE Florida is ~90 mi north. */
  waveHeightSource?: MetricSource;
  windSpeedMph?: number;
  windDirDeg?: number;
  /**
   * ESTIMATED SURF (breaking) HEIGHT, not the raw buoy/model significant
   * wave height (Hs) — this is what shows and scores as "waves" everywhere
   * in the app. Hs is an offshore average; for a long-period swell, the
   * height that actually breaks at the shore runs well above it. Derived
   * from `waveSwellHeightFt` + `wavePeriodS` below via
   * `lib/surfHeight.ts`'s `estimateSurfFromSources` (Komar & Gaughan 1972) —
   * see docs/benchmarks/2026-09-28-surf-height-validation.md for why. The
   * rip-current model/curve (lib/ripRiskCurve.ts, lib/sources/ripNwps.ts)
   * reads its own wave data straight from the marine model, NOT this field,
   * so it keeps using the raw Hs it always has.
   */
  waveHeightFt?: number; // combined sea state (for swimming calmness) — SURF estimate
  /**
   * The TRUE raw TOTAL significant wave height (buoy WVHT, or the model's
   * own `wave_height`) — untouched, never the swell component (Codex review
   * round-2 #1). `waveSwellHeightFt` below can legitimately BE the swell
   * component when the total's own period was missing (see
   * `estimateSurfFromSources`), so it can no longer stand in for "the raw
   * total Hs" everywhere — this field is the one place that always does.
   * `lib/history/archive.ts` archives THIS into `beach_hourly.wave_ft`,
   * which has always meant the raw total Hs. Undefined when the source
   * reported no total height at all (only a swell reading, if any).
   */
  waveTotalHsFt?: number;
  /** The raw Hs (buoy WVHT, or model TOTAL/SWELL wave height — whichever
   *  reading actually fed the estimate, per `estimateSurfFromSources`) that
   *  fed `waveHeightFt` above — shown as the card's secondary "wave height"
   *  line so the underlying reading is never hidden behind the surf estimate.
   *  Not labeled "swell" in the UI: it can be the TOTAL sea-state reading,
   *  not the swell component specifically. Use `waveTotalHsFt` above, not
   *  this field, whenever "the raw total Hs" specifically is what's needed
   *  (e.g. archiving) — this one can legitimately be the swell component. */
  waveSwellHeightFt?: number;
  /** The dominant/peak wave period (s) paired with `waveSwellHeightFt` —
   *  the buoy's DPD when the buoy supplied the height, or the marine
   *  model's own dominant wave period when the model did. Never a period
   *  from one source paired with a height from the other. */
  wavePeriodS?: number;
  precipProbability?: number;
  shortForecast?: string;
  uvIndex?: number;
  cloudCoverPct?: number; // 0 = full sun, 100 = overcast
  humidityPct?: number; // relative humidity, 0-100
  dewPointF?: number; // °F — the comfort/mugginess driver
  weatherCode?: number; // WMO code (hourly path); drives the rain cap
  /** Worst-of-cams seaweed level (morning-preferred); day-constant. */
  sargassumLevel?: SargassumRisk;
  /** 0-100 seaweed coverage at the worst cam; refines the seaweed sub-score. */
  sargassumCoveragePct?: number;
  /** 0-100 beach fullness (busiest cam now, or the hour's history); 0=empty. */
  crowdPct?: number;
  /** 0-100 cam-read water clarity (100 = crystal clear). Weight 0 in the free
   *  score, so it only moves a personal (Plus) score — see DEFAULT_SCORING. */
  clarityPct?: number;
  /** Estimated dry-sand surface temp (°F) — barefoot comfort (lib/sandTemp). */
  sandTempF?: number;
  flags: FlagColor[];
  waterAdvisory: boolean;
  waterRating: WaterQualityRating;
  /** City-issued no-swim/beach advisory is active (myboca AlertCenter). */
  noSwimAdvisory: boolean;
  /** NWS Surf Zone Forecast rip-current risk — the FIRST SRF period's word,
   *  kept for back-compat (safetyTone/safetyLine's older callers). Prefer
   *  `ripNow` for anything that needs to know whether a rip hazard is
   *  actually in effect right now vs merely forecast/scheduled. */
  ripCurrentRisk: RipRisk;
  /** Temporally-resolved rip status for this hour (lib/ripRisk's
   *  resolveRipNow): an alert actually in effect (always High) > a fresh NOAA
   *  rip current model reading (possibly softened one band below a
   *  disagreeing SRF word, or upgrade-only once its run is aging) > the
   *  current SRF period's word > unknown. Drives the rip cap below — never
   *  the raw flat word. Optional so a hand-built test `Derived` (constructed
   *  directly, not via `deriveMetrics`) doesn't have to supply it;
   *  `deriveMetrics` itself always populates it. Absent is treated as
   *  "unknown" (no cap) — see `ripCapFor`. */
  ripNow?: RipNow;
  /** A severe NWS warning (hurricane/tropical storm/tsunami/high surf) is active. */
  severeAlert: boolean;
  /** A coastal-flood ADVISORY or a Beach Hazards Statement (sub-warning tier)
   *  is active — soft swim cap (85). NOT high surf: see highSurfAdvisory. */
  surfAdvisory?: boolean;
  /** An NWS High Surf ADVISORY is active — dangerous breaking surf, capped at 70
   *  like a red flag (owner 2026-09-28). The WARNING tier is severeAlert. */
  highSurfAdvisory?: boolean;
  /** Live nowcast says it's precipitating RIGHT NOW (observed, beats the forecast). */
  nowcastRaining?: boolean;
  /**
   * A fresh MRMS radar frame sees no rain at or near the beach (now-only). An
   * observation that vetoes the current hour's FORECAST rain cap and the model
   * nowcast — the forecast said "rain showers, 1.72 in" for a 2 PM hour on
   * 2026-09-04 while the radar showed 0 mm/hr and the sand read 130°F.
   */
  radarDryNow?: boolean;
  /** A fresh GOES GLM strike landed within 5 mi (now-only) — trips the get-out cap. */
  lightningWithin5mi?: boolean;
  /** Minutes since the most recent strike in the scanned area (now-only). */
  lightningLastMinutesAgo?: number;
  /** The shared lightning assessment (lib/hazards/assess.ts) this beach's
   *  `lightningWithin5mi` was derived from — carries the reason string and
   *  hold-window bookkeeping for UI copy. */
  hazardLightning?: HazardAssessment;
  /** The shared rain assessment (lib/hazards/assess.ts) this beach's
   *  `nowcastRaining` was derived from. */
  hazardRain?: HazardAssessment;
}

/** Events that make the beach genuinely dangerous/closed — hard score cap.
 *  Note `tsunami (warning|advisory)` not bare `tsunami`: a Tsunami WATCH or
 *  (routine) INFORMATION STATEMENT is not a swim threat and must not cap. */
const SEVERE_ALERT =
  /hurricane warning|tropical storm warning|storm surge warning|tsunami (warning|advisory)|high surf warning|tornado warning|flash flood warning|special marine warning|extreme wind warning|coastal flood warning/i;

/** The hourly-forecast entry whose bucket contains "now" (within 2h), if any. */
export function currentHourOf(hours: HourlyMetrics[], nowMs: number = Date.now()) {
  // Prefer the bucket whose half-open interval [start, start+1h) CONTAINS now —
  // i.e. the latest bucket that has already started (start <= now < start+1h).
  let contained: HourlyMetrics | undefined;
  let containedStart = -Infinity;
  for (const h of hours) {
    const start = new Date(h.time).getTime();
    if (start <= nowMs && nowMs < start + 3600_000 && start > containedStart) {
      containedStart = start;
      contained = h;
    }
  }
  if (contained) return contained;
  // Fall back to the nearest bucket (within 2h) when none contains now.
  let best: HourlyMetrics | undefined;
  let bestDist = 2 * 3600_000;
  for (const h of hours) {
    const dist = Math.abs(new Date(h.time).getTime() - nowMs);
    if (dist < bestDist) {
      bestDist = dist;
      best = h;
    }
  }
  return best;
}

/**
 * Consensus across independent sources: the median when 2+ report (so one
 * outlier model can't skew the metric), else whichever single value exists.
 */
export function median(...vals: (number | undefined)[]): number | undefined {
  const xs = vals.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (!xs.length) return undefined;
  xs.sort((a, b) => a - b);
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? round(xs[mid]) : round((xs[mid - 1] + xs[mid]) / 2);
}

/**
 * Consensus cloud cover RIGHT NOW: the median across NWS obs, MET Norway,
 * Open-Meteo, marine and GFS — the same number the Sky card shows. One model's
 * hourly forecast can flip-flop between refreshes (63% vs 100% for the same hour,
 * observed 2026-07-06), so anything sensitive to "how grey is the sky now" (the
 * sand-temp overcast damping) must read this consensus, not a single source.
 *
 * PLUS the satellite, DOUBLE-WEIGHTED, whenever the GOES Clear Sky Mask read is
 * FRESH (see satelliteCloudPct below). Rationale, in order:
 *
 *  - The other five voices are all MODELS. GOES is the only actual OBSERVATION
 *    of the sky over this beach, and models can miss it by ~70 points — the
 *    2026-07-15 anvil incident documented directly below had every forecast
 *    reading 11-24% under a genuinely ~97% overcast sky. A median of five
 *    wrong-in-the-same-direction models is confidently wrong.
 *  - So it gets TWO votes, not one: with 5 model voices, a single satellite
 *    vote can never move the median off the model cluster (it just becomes the
 *    new min or max). Two votes let a satellite that disagrees with all five
 *    pull the median a full model-step toward reality.
 *  - But still a MEDIAN, not an override: satellite granules are noisy (thin
 *    cirrus, edge-of-swath geometry, a sparse valid-pixel count), and the
 *    models remain the tie-breaker. 5 models + 2 satellite votes = 7 entries,
 *    so the median is the 4th value — the satellite can drag the consensus to
 *    the edge of the model spread and no further. One bad granule cannot
 *    dictate the number; a consistently-disagreeing satellite wins.
 *
 * Stale or missing satellite → identical behavior to before (5 model voices).
 */
export function consensusCloudPct(
  s: ConditionsSnapshot,
  nowMs: number = Date.now(),
): number | undefined {
  // A satellite-OBSERVED sunshine reading, when we have one, is a direct
  // MEASUREMENT of cloud opacity and outranks a median of forecast models that
  // can be unanimously wrong the same way (2026-09-04: three of five models said
  // 100% cloud while 94% of the sun measurably reached the ground). It resolves
  // both failure modes — thin cirrus the mask over-counts, and a thunderstorm
  // anvil the models miss (the anvil starves the radiation, so it reads cloudy).
  const observed = observedSkyCloudPct(s, nowMs);
  if (observed != null) return observed;
  const om = currentHourOf(s.hourly.data ?? [], nowMs);
  const sat = satelliteCloudPct(s);
  return median(
    s.marine.data?.cloudCoverPct,
    s.metno.data?.cloudCoverPct,
    om?.cloudCoverPct,
    s.weather.data?.cloudCoverPct,
    s.gfs.data?.cloudCoverPct,
    // The binary mask, double-weighted, only when no observed-sunshine read is
    // available (night, low sun, stale feed) — see the double-weight rationale
    // above. observedSkyCloudPct supersedes it whenever the sun is measurably up.
    sat,
    sat,
  );
}

/**
 * Fair-weather clear-sky global horizontal irradiance at the zenith (W/m²) at
 * sea level. Deliberately on the HIGH side (~1050) so a genuinely clear sky
 * divides out to a transmission just under 1.0 — reading a few % cloud, never a
 * negative or impossible value from sensor/model noise.
 */
const CLEAR_SKY_GHI_PEAK_WM2 = 1050;
/**
 * Below this sun elevation the sin() clear-sky model and rising air mass make
 * the transmission ratio unreliable, so the observed read stands down and the
 * model consensus is used. Sky quality matters least near the horizon anyway.
 */
const SKY_OBS_MIN_SUN_ELEV_DEG = 25;
/** The observed-radiation hour must be at least this fresh to speak for "now". */
const SKY_OBS_MAX_AGE_MS = 90 * 60_000;

/**
 * Cloud cover RIGHT NOW inferred from the satellite-OBSERVED shortwave radiation
 * — a quantitative measurement of how much sun actually reaches the ground,
 * which both the forecast models and the binary GOES cloud MASK get wrong in
 * BOTH directions:
 *   - thin cirrus: mask flags "cloud", models forecast overcast, yet the sun
 *     pours through (2026-09-04: mask 98%, models 3×100%, but 853 W/m² of a ~907
 *     clear-sky ceiling reached the ground — a 130°F beach under a blue sky);
 *   - a thunderstorm anvil the models miss (2026-07-15): the radiation collapses,
 *     so this correctly reads heavy cloud.
 * cloud% = (1 − observed/clear-sky(elevation)). Returns undefined — falling back
 * to the model+mask consensus — unless the GOES granule is fresh with the sun
 * well up and enough valid pixels, and a satellite-observed shortwave hour sits
 * within the last ~90 min. The elevation comes from the granule itself.
 */
export function observedSkyCloudPct(
  s: ConditionsSnapshot,
  nowMs: number = Date.now(),
): number | undefined {
  const g = s.goesCloud;
  if (g.status !== "ok" || g.data == null) return undefined;
  const elev = g.data.sunElevDeg;
  if (elev == null || elev < SKY_OBS_MIN_SUN_ELEV_DEG) return undefined;
  const { validPixels: vp, totalPixels: tp } = g.data;
  if (tp > 0 && vp / tp < 0.5) return undefined; // degraded granule — don't trust it

  // The most recent satellite-OBSERVED shortwave hour near now (overlaid onto
  // elapsed hours by hourlyForecast.ts; a forecast hour is never solarObserved).
  let obs: number | undefined;
  let bestAge = Infinity;
  for (const h of s.hourly.data ?? []) {
    if (h.solarObserved !== true || h.solarWm2 == null) continue;
    const age = Math.abs(nowMs - (new Date(h.time).getTime() + 1800_000));
    if (age < bestAge) {
      bestAge = age;
      obs = h.solarWm2;
    }
  }
  if (obs == null || bestAge > SKY_OBS_MAX_AGE_MS) return undefined;

  const clearSky = CLEAR_SKY_GHI_PEAK_WM2 * Math.sin((elev * Math.PI) / 180);
  if (clearSky < 50) return undefined;
  const transmission = Math.max(0, Math.min(1, obs / clearSky));
  return Math.round((1 - transmission) * 100);
}

/**
 * Satellite-OBSERVED cloud cover right now (NOAA GOES-19 Clear Sky Mask,
 * OVERHEAD box), when the feed is fresh and carries a valid reading for this
 * beach.
 *
 * 2026-07-15 CALIBRATION NOTE: Open-Meteo's forecast cloud field read 11-24%
 * (701-821 W/m2 "clear sky" solar) while the Boca beach sat under a real
 * thunderstorm anvil — genuinely ~95-100% overcast. consensusCloudPct is a
 * median of FORECAST models, so it inherited that same ~70-point miss; the
 * sand-temp overcast damping in lib/sandTemp.ts never fired because its
 * cloud INPUT was wrong, not because the damping curve itself was wrong (see
 * that file's calibration log). This is one fix: an actual satellite
 * observation of the sky, independent of any forecast model's guess. See
 * satelliteBeamCloudPct below for the further 2026-07-15 refinement (beam-
 * path, not overhead, cloud) that the sand model now prefers over this.
 *
 * Returns undefined when the feed is stale/missing/invalid — see
 * GOES_CLOUD_STALE_MINUTES in lib/sources/goesCloud.ts for why "stale" has to
 * be a fairly generous window (the feed itself gaps by 80+ minutes at times).
 * Callers fall back to consensusCloudPct exactly as before in that case.
 */
export function satelliteCloudPct(s: ConditionsSnapshot): number | undefined {
  const g = s.goesCloud;
  if (g.status !== "ok" || g.data?.cloudPct == null) return undefined;
  return g.data.cloudPct;
}

/**
 * Satellite-OBSERVED cloud cover along the DIRECT SOLAR BEAM path (NOAA
 * GOES-19 Clear Sky Mask, offset boxes stepped toward the sun — see
 * scripts/goes_cloud.py's beam_cloud_pct()), when the feed is fresh and
 * carries a valid beam reading for this beach.
 *
 * 2026-07-15 CONFIRMED FINDING: the overhead box (satelliteCloudPct) reads
 * "is the sky grey above the beach", but dry-sand heating is driven by the
 * DIRECT BEAM, which at low sun angle travels through air kilometres toward
 * the sun before reaching the ground. The archived 20:16Z granule for Boca
 * proved this directly: overhead read 31% cloud while boxes stepped along
 * the solar azimuth read 58% at 3 km, 71% at 6 km, 86% at 10 km, 85-100% at
 * 15-30 km — the beam was blocked by cloud the overhead box never saw. See
 * lib/sandTemp.ts's 2026-07-15 calibration note (candidate (c), now
 * CONFIRMED) for the full writeup and the resolved morning-vs-afternoon
 * asymmetry.
 *
 * Returns undefined when the feed is stale/missing, this beach's beam
 * reading is null (old-format feed, sun below ~5° elevation, or too few
 * offset-box pixels — never fabricated upstream), or beamCloudPct is
 * entirely absent (pre-beam-path cached feed). Callers should fall back to
 * satelliteCloudPct (overhead), then consensusCloudPct, in that order.
 */
export function satelliteBeamCloudPct(s: ConditionsSnapshot): number | undefined {
  const g = s.goesCloud;
  if (g.status !== "ok" || g.data?.beamCloudPct == null) return undefined;
  return g.data.beamCloudPct;
}

/** The NWPS nearshore model's wave reading for the hour containing `tMs`,
 *  or null when the series has no finite height for that hour. */
function nwpsWaveAt(
  series: RipNwpsBeachSeries | null,
  tMs: number,
): { hsFt: number; periodS?: number } | null {
  if (!series) return null;
  const hourMs = Math.floor(tMs / 3_600_000) * 3_600_000;
  const row = series.hours.find((h) => Date.parse(h.t) === hourMs);
  if (!row || row.hsFt == null || !Number.isFinite(row.hsFt) || row.hsFt < 0) return null;
  const periodS = row.periodS != null && Number.isFinite(row.periodS) ? row.periodS : undefined;
  return { hsFt: row.hsFt, periodS };
}

/** NWPS is a NEARSHORE point, so its Hs is already shoaled toward the beach —
 *  the Komar-Gaughan deep-water breaker amplification (lib/surfHeight.ts) is
 *  not applied on top of it. Surf = Hs, period kept for the reading line. */
function nwpsSurf(w: { hsFt: number; periodS?: number }): SurfSourceResult {
  const hsFt = round(w.hsFt, 1);
  return { surfFt: hsFt, rawHeightFt: hsFt, rawPeriodS: w.periodS };
}

/** `metricSource` for waves, which has TWO model rungs (see the preference
 *  comment at the call site). */
function waveSourceOf(
  buoyValue: number | undefined,
  buoyStationId: string | null | undefined,
  nwps: boolean,
  modelValue: number | undefined,
): MetricSource | undefined {
  if (buoyValue != null) return { kind: "buoy", stationId: buoyStationId ?? undefined };
  if (nwps) return { kind: "model", model: "nwps" };
  if (modelValue != null) return { kind: "model", model: "open-meteo" };
  return undefined;
}

/** Mirror of a `buoyValue ?? modelValue` preference as a {@link MetricSource}. */
function metricSource(
  buoyValue: number | undefined,
  buoyStationId: string | null | undefined,
  modelValue: number | undefined,
): MetricSource | undefined {
  if (buoyValue != null) return { kind: "buoy", stationId: buoyStationId ?? undefined };
  if (modelValue != null) return { kind: "model" };
  return undefined;
}

// `nowMs` only feeds the sand model's "current hour" pick. Callers that already
// hold a clock (the hourly/personal scorers, SSR vs hydration) pass it in so the
// same snapshot scores the same way regardless of wall time; the default keeps
// every existing call site unchanged.
export function deriveMetrics(s: ConditionsSnapshot, nowMs: number = Date.now()): Derived {
  const w = s.weather.data;
  const b = s.buoy.data;
  const m = s.marine.data;
  const c = s.cityOfficial.data;
  const q = s.waterQuality.data;
  const n = s.nws.data;
  const rn = s.ripNwps?.data ?? null;
  const mn = s.metno.data;
  const g = s.gfs.data;
  // Open-Meteo's reading for the current hour — the third consensus voice.
  const om = currentHourOf(s.hourly.data ?? []);
  const cloudCoverPct = consensusCloudPct(s, nowMs);
  // Consensus current values (median across sources), computed up front so the
  // dew-point fallback derives from the SAME temp + humidity the UI shows — not a
  // single provider, which previously made dew point inconsistent with the card.
  const airTempF = median(w?.airTempF, mn?.airTempF, om?.airTempF, g?.airTempF) ?? b?.airTempF;
  const humidityPct = median(w?.humidityPct, mn?.humidityPct, om?.humidityPct, g?.humidityPct);
  // Dew point drives the comfort score; when no source reports it directly, derive
  // it from the consensus temp + humidity above so it agrees with what's displayed.
  const dpFallback =
    airTempF != null && humidityPct != null ? dewPointFromTempRH(airTempF, humidityPct) : undefined;
  const precipProbability = w?.precipProbability ?? om?.precipProbability;
  // Nowcast "raining" needs CORROBORATION before it caps the score. Open-Meteo's
  // minutely_15 is a MODEL nowcast, not an observation, and FL sea-breeze
  // convection makes it hallucinate showers (2026-07-15: "raining, easing in
  // 14 min" under a verifiably clear sky — code 0, 2% prob, 16% cloud consensus,
  // 0.00" measured — capping a sunny day at 25). Count it as observed rain only
  // when at least ONE independent signal agrees: a rain/storm weather code this
  // hour (even a prob-vetoed code 95 corroborates — the real 2026-06-15 rain),
  // fresh lightning within 5 mi (NOT wider: FL storm cells routinely sit 10-20 mi
  // inland while the beach is in full sun — a 25 mi radius wrongly corroborated
  // the 2026-07-15 phantom with a cell 11.4 mi away; within 5 mi the lightning
  // cap owns the score anyway), cloud consensus >= 50% (rain requires clouds),
  // precip probability >= 25, or measured precip this hour. Unknown signals do
  // NOT veto (fail-safe: only positive evidence of a clear sky kills the cap).
  // UV under a satellite-OBSERVED deck. Open-Meteo's cloud-aware uv_index
  // barely discounts decks its radiation model thinks are thin — 2026-07-16
  // 4 PM: clear-sky 7.35 vs "100% cloud" 7.25 (-1.4%) while GOES read a real
  // 99% deck (the same optical-depth blindness as the sand-temp saga; real
  // solid overcast transmits only ~25-45% of UV). When the satellite sees
  // heavy cloud (>=50%, fresh feed), attenuate the CLEAR-SKY UV by observed
  // cover — linear to a 0.4 transmission floor at a 100% deck. Two safety
  // rails, because a UV metric must never under-warn: (1) min() — we only
  // ever LOWER the forecast number, so if Open-Meteo already discounted more
  // than we would, theirs stands; (2) the 0.4 floor keeps "you can still burn
  // through bright overcast" true (7.4 clear-sky → 3.0, ~67 min to burn — a
  // warning, not an all-clear). Overhead cloud (not beam-path): UV reaching
  // skin has a large diffuse/scattered component, so the sky above matters,
  // unlike the sand model's direct-beam physics. Stale/missing satellite →
  // forecast UV unchanged.
  const uvForecast = om?.uvIndex ?? m?.uvIndex;
  const satCloudForUv = satelliteCloudPct(s);
  let uvIndex = uvForecast;
  if (satCloudForUv != null && satCloudForUv >= 50 && om?.uvClearSkyIndex != null) {
    const transmission = 1 - 0.6 * ((satCloudForUv - 50) / 50);
    const satUv = round(om.uvClearSkyIndex * transmission, 1);
    uvIndex = uvForecast != null ? Math.min(uvForecast, satUv) : satUv;
  }
  const nowcastSaysRain = s.nowcast.data?.state === "raining";
  const rainishCode =
    om?.weatherCode != null &&
    ((om.weatherCode >= 51 && om.weatherCode <= 67) ||
      (om.weatherCode >= 80 && om.weatherCode <= 99));

  // The one shared lightning/rain assessment (lib/hazards/assess.ts) — score
  // and the alert engine both call this so a cap and a push can never
  // disagree about whether it's raining or lightning is near right now.
  // Lightning goes FIRST: the rain-corroboration gate below needs its
  // (recency-fixed) `active` verdict, not a second, independently-paired
  // distance/age calc that could disagree with it.
  const hazardAnchor = { kind: "beach" as const, slug: s.location.slug };
  const hazardLightning = assessLightning({
    status: s.lightning.status,
    closeStrikeMinutesAgo: s.lightning.data?.closeStrikeMinutesAgo,
    windowMinutes: s.lightning.data?.windowMinutes,
    nearestMi: s.lightning.data?.nearestMi,
    nearestMinutesAgo: s.lightning.data?.nearestMinutesAgo,
    nowMs,
    anchor: hazardAnchor,
  });
  // Fresh close-by strikes corroborate a rain nowcast/model signal (one truth
  // with the lightning cap itself — see hazardLightning above).
  const freshStrikesNear = hazardLightning.active;
  const nowcastCorroborated =
    rainishCode ||
    freshStrikesNear ||
    (cloudCoverPct ?? 100) >= 50 ||
    (precipProbability ?? 100) >= 25 ||
    (om?.precipIn ?? 0) > 0;
  const rainStormSignal =
    (om?.weatherCode != null && om.weatherCode >= 95 && om.weatherCode <= 99) ||
    /thunder|storm/i.test(w?.shortForecast ?? "");
  const hazardRain = assessRain({
    radar: s.precipRadar
      ? {
          status: s.precipRadar.status,
          frameAgeMinutes: s.precipRadar.data?.frameAgeMinutes,
          rainNowMmHr: s.precipRadar.data?.rainNowMmHr,
          nearestRainKm: s.precipRadar.data?.nearestRainKm,
          wetMinutesAgo: s.precipRadar.data?.wetMinutesAgo,
        }
      : null,
    nowcastState: nowcastSaysRain ? "raining" : "dry",
    corroborated: nowcastCorroborated,
    stormSignal: rainStormSignal,
    nowMs,
    anchor: hazardAnchor,
  });
  // A fresh MRMS radar frame that sees nothing at the beach is an OBSERVATION
  // that outranks both the model nowcast and a forecast hour's rain code.
  // assessRain computes the one confident-dry formula (fresh + OK + no wet-now
  // + no wet-recently) — read it back here instead of re-deriving it, so score
  // and the alert engine can never disagree about what counts as "dry".
  const radarDryNow = !!hazardRain.confidentDryVeto;
  // Hs (raw significant wave height) + its OWN source's period — buoy WVHT
  // pairs only with the buoy's DPD (BuoyData has no separate swell field, so
  // there is nothing to cross-pair there); the model's TOTAL wave height
  // pairs with the model's own TOTAL period when it has one, and only falls
  // back to the model's SWELL height+period (matched to each other, never
  // spliced onto the total height) when the model's total period is missing
  // — see `estimateSurfFromSources` (lib/surfHeight.ts, Codex review
  // 2026-09-28 #2) for why a swell-only period can never pair with a total
  // height. Then converted to an estimated surf height — see lib/surfHeight.ts
  // + the validation doc cited on `Derived.waveHeightFt` above.
  // The TRUE raw total Hs (Codex review round-2 #1) — computed independently
  // of `estimateSurfFromSources`'s result, so it always names the actual
  // total reading (buoy WVHT or the model's `wave_height`), never the swell
  // component the estimate may have fallen back to. `undefined` when neither
  // source reported a total height at all.
  // Preference: buoy observation → NWPS nearshore model → Open-Meteo marine
  // model. NWPS sits between the two (2026-10-08) because its point is AT the
  // beach (Boca: 26.36, -80.07) while Open-Meteo's marine cell for a coastal
  // beach is well offshore (Boca: ~12 mi out in the Gulf Stream), where an
  // 8 s, 3.3 ft swell exists that never reaches a flat, green-flag shore.
  const nwpsNow = nwpsWaveAt(rn, nowMs);
  const waveTotalHsFt = b?.waveHeightFt ?? nwpsNow?.hsFt ?? m?.waveHeightFt;
  const surfSource = b?.waveHeightFt != null
    ? estimateSurfFromSources({ totalHeightFt: b.waveHeightFt, totalPeriodS: b?.dominantPeriodS })
    : nwpsNow
      ? nwpsSurf(nwpsNow)
      : estimateSurfFromSources({
          totalHeightFt: m?.waveHeightFt,
          totalPeriodS: m?.wavePeriodS,
          swellHeightFt: m?.swellHeightFt,
          swellPeriodS: m?.swellPeriodS,
        });
  return {
    // Shared metrics are the MEDIAN of NWS (real station obs), MET Norway, and
    // Open-Meteo, so no single provider or model can skew the dashboard.
    airTempF,
    waterTempF: b?.waterTempF ?? m?.seaSurfaceTempF,
    // Provenance for the two metrics whose real source is routinely NOT what
    // the card used to imply — see MetricSource. Both follow the exact `??`
    // preference above/below them, so the label can never drift from the value.
    waterTempSource: metricSource(b?.waterTempF, b?.sources?.waterTempF, m?.seaSurfaceTempF),
    // Model provenance whenever ANY surf estimate came from model data —
    // including the swell-only fallback (Codex review round-3 #2), where
    // `m?.waveHeightFt` alone (the model's TOTAL height) is undefined even
    // though `surfSource` DID compute a reading from `m.swellHeightFt` +
    // `m.swellPeriodS`. Leaving this undefined in that case wrongly gave the
    // "waves" factor full (not 0.5 estimated) completeness credit, dropped
    // it from `estimatedFactors`, and archived `wave_source` as null instead
    // of "model" (lib/history/archive.ts).
    waveHeightSource: waveSourceOf(
      b?.waveHeightFt,
      b?.sources?.waveHeightFt,
      nwpsNow != null,
      b?.waveHeightFt != null ? undefined : surfSource.surfFt,
    ),
    windSpeedMph:
      median(w?.windSpeedMph, mn?.windSpeedMph, om?.windSpeedMph, g?.windSpeedMph) ?? b?.windSpeedMph,
    windDirDeg: w?.windDirDeg ?? mn?.windDirDeg ?? b?.windDirDeg,
    waveHeightFt: surfSource.surfFt,
    waveTotalHsFt,
    waveSwellHeightFt: surfSource.rawHeightFt,
    wavePeriodS: surfSource.rawPeriodS,
    precipProbability,
    shortForecast: w?.shortForecast,
    // The current hour's forecast UV (marine "/current" lags hours behind — a
    // fallback only), attenuated by GOES-observed cloud when the satellite
    // sees a real deck the forecast's radiation model doesn't — see the
    // uvIndex block above the return.
    uvIndex,
    cloudCoverPct,
    sargassumLevel: s.sargassum.data?.level,
    sargassumCoveragePct: s.sargassum.data?.coveragePct,
    crowdPct: s.busyness.data?.crowdPct ?? crowdLevelPct(s.busyness.data?.level),
    // Cam-read water clarity. Null/absent whenever the read is night-gated,
    // stale, or the beach has no cams — the sub-score then drops out and the
    // remaining weights renormalize, exactly like any other missing input.
    clarityPct: s.clarity?.data?.pct ?? undefined,
    // Sand "now" prefers the satellite BEAM-PATH observation (fresh + valid),
    // then the satellite OVERHEAD observation (fresh + valid), then the
    // forecast consensus (same as the Sky card) — see satelliteBeamCloudPct's
    // 2026-07-15 CONFIRMED-finding note above for why beam-path outranks
    // overhead: at low sun angle the cloud that actually blocks the beam
    // heating the sand can sit kilometres away from an overhead reading of
    // "clear". This is deliberately surgical: it only changes sandCloudPct
    // (the sand model's input), NOT the shared `cloudCoverPct` above, so the
    // Sky sub-score, its display, and the rain-corroboration gate are
    // untouched.
    sandTempF: s.hourly.data
      ? currentSandTempF(
          s.hourly.data,
          nowMs,
          {
            cloudCoverPct: satelliteBeamCloudPct(s) ?? satelliteCloudPct(s) ?? cloudCoverPct,
            // Beam-path readings damp from 50% (sustained blockage), not 70%.
            cloudIsBeamPath: satelliteBeamCloudPct(s) != null,
            // Lets the sand model drop phantom forecast rain and carry the
            // previous observed hour's radiation into this forecast hour.
            radarDryNow,
          },
          s.location.lon, // afternoon-decay term (hours from solar noon)
        )
      : undefined,
    humidityPct,
    dewPointF:
      median(w?.dewPointF, mn?.dewPointF, om?.dewPointF, g?.dewPointF) ??
      (dpFallback != null ? round(dpFallback) : undefined),
    flags: c?.flags ?? ["unknown"],
    waterAdvisory: q?.advisory ?? false,
    waterRating: q?.overall ?? "unknown",
    noSwimAdvisory: !!c?.noSwimAdvisory,
    ripCurrentRisk: n?.ripCurrentRisk ?? "unknown",
    // Back-compat: older snapshots/fixtures/test data carry only the flat
    // `ripCurrentRisk` word with no `srfPeriods` array. Treat that word as a
    // single windowless "TODAY" period so resolveRipNow's forecast source
    // still applies — a windowless period always matches "now" (see
    // lib/ripRisk/resolve.ts's currentSrfPeriod fallback).
    ripNow: resolveRipNow({
      alerts: n?.alerts ?? [],
      srfPeriods:
        n?.srfPeriods ?? (n?.ripCurrentRisk && n.ripCurrentRisk !== "unknown"
          ? [{ label: "TODAY", level: n.ripCurrentRisk }]
          : []),
      model: modelNowFromSeries(rn, nowMs),
      now: nowMs,
    }),
    // Both gated on isAlertInEffectAt (item 1, shared with SafetyBanner/
    // safetyTone/evaluate.ts's push path) — a Warning/Advisory scheduled for
    // later, or already expired, must never cap the score as if active. Rip-
    // related events (incl. a rip-mentioning Beach Hazards Statement) are
    // excluded here too — they're the rip cap's job below, via d.ripNow,
    // never double-counted through this generic path.
    severeAlert: (n?.alerts ?? []).some(
      (a) =>
        !isRipAlertEvent(a) &&
        isAlertInEffectAt(a, nowMs) &&
        (SEVERE_ALERT.test(a.event) || /^(Severe|Extreme)$/i.test(a.severity)),
    ),
    surfAdvisory: (n?.alerts ?? []).some(
      (a) =>
        !isRipAlertEvent(a) &&
        isAlertInEffectAt(a, nowMs) &&
        /beach hazards|coastal flood advisory/i.test(a.event),
    ),
    highSurfAdvisory: (n?.alerts ?? []).some(
      (a) => !isRipAlertEvent(a) && isAlertInEffectAt(a, nowMs) && /high surf advisory/i.test(a.event),
    ),
    // Observed "now" signals — they override the forecast-based rain logic.
    // (Corroboration-gated: see nowcastCorroborated above — a phantom model
    // shower under a clear sky must not cap the day.)
    nowcastRaining: hazardRain.active,
    radarDryNow,
    // Lightning trips the get-out cap only when the feed is OK, the closest
    // strike landed within 5 mi, AND that SAME strike's own age is fresh
    // (<=30 min) — see lib/hazards/assess.ts for the recency-bug fix this
    // replaced (pairing nearestMi with the wrong strike's age).
    lightningWithin5mi: hazardLightning.active,
    lightningLastMinutesAgo: s.lightning.data?.lastMinutesAgo,
    hazardLightning,
    hazardRain,
  };
}

/**
 * The longest contiguous run of today's scored daylight hours that stays within
 * 8 points of the day's peak — i.e. "the best stretch to go". `endIso` is the
 * end of the last hour in the run. Null when there are no hours.
 */
export function bestBeachWindow(hours: HourlyScore[], nowMs?: number): BestWindow | null {
  // When a `nowMs` is supplied, drop any hour whose bucket has already ended so
  // the window only ever points at time still ahead. Caller passes a post-mount
  // value (not defaulted here, which would desync SSR/client).
  if (typeof nowMs === "number") {
    hours = hours.filter((h) => new Date(h.time).getTime() + HOUR_MS > nowMs);
  }
  if (!hours.length) return null;
  const max = Math.max(...hours.map((h) => h.score));
  const threshold = max - 8;
  let bestStart = -1;
  let bestLen = 0;
  let bestPeak = 0;
  let curStart = -1;
  let curLen = 0;
  let curPeak = 0;
  for (let i = 0; i < hours.length; i++) {
    if (hours[i].score >= threshold) {
      if (curLen === 0) curStart = i;
      curLen += 1;
      curPeak = Math.max(curPeak, hours[i].score);
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
        bestPeak = curPeak;
      }
    } else {
      curLen = 0;
      curPeak = 0;
    }
  }
  if (bestStart < 0) return null;
  const last = hours[bestStart + bestLen - 1];
  return {
    startIso: hours[bestStart].time,
    endIso: new Date(new Date(last.time).getTime() + 3600000).toISOString(),
    score: Math.round(bestPeak),
  };
}

// --- individual curves -----------------------------------------------------
// Wind: a light sea breeze is the sweet spot, not dead calm. Under ~5 mph is
// stagnant/buggy/hot; 5-12 mph is ideal; above 12 mph turns choppy and starts
// blowing sand. Plateau across [5, 12]; eases off over 12 mph below, drops over 3 mph above
// (so dead calm ≈ 58; 13 mph = 75, 14 = 50, 15 = 25, 16 mph and up = 0).
/** Below the band the score eases off over 12 mph (dead calm ≈ 58: hot and
 *  buggy, not dangerous). ABOVE the band it drops over 4 mph (2026-10-09):
 *  the owner at Boca in a 15–16 mph onshore wind — sand blowing, towels
 *  pinned, chop — with the wind factor still at 75. The old 12 mph slide
 *  (zero only at a 25 mph gale) never knocked off the points a real beach
 *  day loses. 4 mph, not 3 (Codex): the hourly curve runs on one rounded
 *  forecast, and a 33-point step per mph would split best windows and flip
 *  Good/Decent on ordinary 1 mph wobbles. Presets own their band and may
 *  override the high-side slide (`ideals.windFalloffHigh`; surf keeps 12). */
export const WIND_LOW_FALLOFF_MPH = 12;
export const WIND_HIGH_FALLOFF_MPH = 4;
export const windScore = (mph: number, low = 5, high = 12, highFalloff = WIND_HIGH_FALLOFF_MPH) =>
  mph > high
    ? clamp(100 * (1 - (mph - high) / highFalloff), 0, 100)
    : plateau(mph, low, high, WIND_LOW_FALLOFF_MPH);
const waveCalm = (ft: number) => clamp(100 - Math.max(0, ft - 1) * 25, 0, 100);
const uvScore = (uv: number) => clamp(100 - Math.max(0, uv - 8) * 12, 0, 100);

// Wave curves, one per taste (ScoringIdeals.waveMode):
//  - `calm`   the free score's curve: flat water is perfect, every foot costs.
//  - `some`   a bit of swell is the point — 1-3 ft is perfect, gentle either way.
//  - `surf`   rideable waves: 2-5 ft is perfect, ankle-slappers are a bust
//             (~30) and anything over 7 ft is for experienced surfers only (~40).
const waveSome = (ft: number) => plateau(ft, 1, 3, 5);
const SURF_WAVE_CURVE: [number, number][] = [
  [0, 30],
  [1, 30],
  [2, 100],
  [5, 100],
  [7, 40],
  [12, 10],
];
const waveSurf = (ft: number) => lerpCurve(ft, SURF_WAVE_CURVE);
function waveScore(ft: number, mode: WaveMode): number {
  if (mode === "surf") return waveSurf(ft);
  if (mode === "some") return waveSome(ft);
  return waveCalm(ft);
}

/**
 * Bump whenever the scoring MATH changes (a curve, a cap threshold, a weight) —
 * anything that would make an old archived score not reproducible from today's
 * code. The history archiver (lib/history/archive.ts) stamps every row with
 * this, so a trend chart can show "the engine changed here" instead of a silent
 * jump. A build SHA alone is not an engine version: most commits don't touch
 * scoring at all, and we don't want every deploy to look like a model change.
 */
// 2026-09-22.1: completeness now credits model-only waterTemp/waves at 0.5
// instead of 1 (provenance-aware coverage), and classifies full/partial/
// limited on the unrounded ratio instead of the rounded display value —
// both change which days get capped/annotated, so old archived rows are not
// reproducible from this version alone.
// 2026-09-28.1: the "waves" factor now scores an ESTIMATED SURF (breaking)
// height instead of the raw buoy/model significant wave height (Hs) — see
// lib/surfHeight.ts and docs/benchmarks/2026-09-28-surf-height-validation.md.
// For a long-period swell this raises the number substantially (e.g. Boca
// on 2026-09-27: Hs ~2.5 ft, DPD 15s -> surf ~4.8 ft), which lowers the
// "waves" sub-score on real swell days that used to read as flat-calm — not
// reproducible from an older version.
// 2026-09-28.2: a red flag and an NWS High Surf Advisory now cap the default
// score at 70 (were 85); a coastal-flood advisory / Beach Hazards Statement
// keeps its 85 cap under its own name. Red-flag days read "Decent", not
// "Yes — good beach day".
export const SCORING_ENGINE_VERSION = "2026-10-09.1";

/** Comfort curve (see comfortScore): dew point up to this is a perfect 100… */
export const COMFORT_FREE_DEW_F = 65;
/** …and each °F above it costs this many points. */
export const COMFORT_PER_DEG_F = 2.5;
/** Bump whenever `DEFAULT_SCORING` itself (weights/curves as DATA) changes,
 *  independent of `SCORING_ENGINE_VERSION` above — kept distinct in case a
 *  future release lets Plus users pick among named configs. */
export const SCORING_CONFIG_VERSION = "default-1";

/**
 * Today's engine, expressed as data: the free Beach Day score. Passing this (or
 * nothing) to `scoreBeachDay` reproduces the free score exactly — same numbers,
 * same sub-score order, same cap strings. `clarity` sits at weight 0, and
 * zero-weight factors never reach `subScores`, so the free breakdown still has
 * the same ten slices it always had.
 *
 * Treat it as read-only: `resolveScoring(null)` hands back this very object.
 */
export const DEFAULT_SCORING: ScoringOptions = {
  weights: {
    airTemp: 0.16,
    sky: 0.16,
    wind: 0.13,
    comfort: 0.08,
    waterTemp: 0.09,
    waves: 0.14,
    sargassum: 0.07,
    crowds: 0.05,
    uv: 0.04,
    sandTemp: 0.08,
    clarity: 0,
  },
  ideals: {
    airPlateau: [78, 88],
    waterPlateau: [77, 90],
    windPlateau: [5, 12],
    waveMode: "calm",
  },
  capPolicy: "water",
};

// Water quality is no longer a weighted sub-score — it's binary (safe vs. not),
// so it only ever CAPS the score via an active advisory (see applyBeachCaps'
// `d.waterAdvisory` branch). Its old 0.06 weight moved to sea state (waves).

// Sky sub-score blends "sunshine" (from cloud cover) with "dryness" (from precip
// probability): full sun + no rain → ~100; partly cloudy → mid; overcast or rainy
// → low. Sunshine is weighted a bit higher (it drives the "is it a sunny beach
// day" feel), while active storms/rain in the forecast text clamp it as a floor.
// (Confirmed rain ALSO hard-caps the whole composite score — see applyBeachCaps.)
function skyScore(d: Derived): number | null {
  const sunshine =
    d.cloudCoverPct != null ? clamp(100 - d.cloudCoverPct, 0, 100) : null;
  const dry =
    typeof d.precipProbability === "number"
      ? clamp(100 - d.precipProbability, 0, 100)
      : null;

  let base: number | null;
  if (sunshine != null && dry != null) base = 0.6 * sunshine + 0.4 * dry;
  else base = sunshine ?? dry;

  const f = d.shortForecast?.toLowerCase() ?? "";
  if (base == null) {
    if (!f) return null; // no numeric or text signal at all
    base = 75; // neutral default when only text is available
  }
  if (/thunder|storm/.test(f)) base = Math.min(base, 45);
  else if (/rain|shower/.test(f)) base = Math.min(base, 60);
  else if (/overcast/.test(f)) base = Math.min(base, 60);
  return clamp(base, 0, 100);
}

/** Human-readable summary of the sky inputs for the score breakdown. */
function skyDisplay(d: Derived): string | undefined {
  const parts: string[] = [];
  const word = d.shortForecast;
  const cloud = d.cloudCoverPct;
  // Never print a word and a number that plainly contradict — the "Clear · 98%
  // cloud" a thin-cirrus day used to show (the ground station reports clear, a
  // binary cloud mask counts the cirrus). Keep the human word, drop the number.
  const clearWord = word != null && /clear|sunny|fair/i.test(word);
  const cloudyWord = word != null && /cloud|overcast/i.test(word);
  const contradicts =
    cloud != null && ((clearWord && cloud >= 70) || (cloudyWord && cloud <= 20));
  if (word) parts.push(word);
  if (cloud != null && !contradicts) parts.push(`${cloud}% cloud`);
  return parts.length ? parts.join(" · ") : undefined;
}

// --- combination + caps ----------------------------------------------------
// Returns null when NO sub-score was available (total data outage) so the
// caller can surface an explicit "Unavailable" rather than a misleading 0.
function combine(subs: SubScore[]): number | null {
  const avail = subs.filter((s) => s.score != null);
  if (avail.length === 0) return null;
  const totalW = avail.reduce((a, s) => a + s.weight, 0);
  if (totalW === 0) return 0;
  const sum = avail.reduce((a, s) => a + (s.score as number) * s.weight, 0);
  return Math.round(sum / totalW);
}

function ratingFor(score: number): string {
  return scoreBand(score).rating;
}

// --- data coverage -----------------------------------------------------
// How much of this profile's weighted score actually had a live reading —
// see the docstring on DataCoverage (lib/types.ts). Most beaches have no
// cams (36 of 39 today), so seaweed/crowds/clarity are routinely null; a
// data-poor beach must say so instead of reading a confident "Excellent".
const COMPLETENESS_FULL_MIN = 0.85;
const COMPLETENESS_PARTIAL_MIN = 0.6;

/** Highest score that still sits below the second-best band's floor (today
 *  74, one under "Yes — good beach day" at 75) — the ceiling for a `limited`
 *  day, so it can never read "Yes!"/"Absolutely!" on mostly-missing data. */
export const LIMITED_DATA_CAP = SCORE_BANDS[1].min - 1;

/** Plain-English words for a missing weighted factor — used by the
 *  DataCoverageNote UI (components/DataCoverageNote.tsx). */
export const FACTOR_WORDS: Record<string, string> = {
  airTemp: "air temperature",
  sky: "sky conditions",
  wind: "wind",
  comfort: "humidity",
  waterTemp: "water temperature",
  waves: "observed waves",
  sargassum: "seaweed",
  crowds: "crowds",
  uv: "UV index",
  sandTemp: "sand temperature",
  clarity: "water clarity",
};

export interface Completeness {
  /** Share (0-1) of this profile's total configured weight with a reading,
   *  weighted by per-factor credit (see {@link computeCompleteness}). Rounded
   *  for display/storage only — the full/partial/limited split below is
   *  decided on the unrounded ratio. */
  completeness: number;
  dataCoverage: DataCoverage;
  /** Keys of weighted factors that had no reading (zero credit). */
  missingFactors: string[];
  /** Keys of weighted factors whose reading came from a model, not an
   *  observation (half credit) — waterTemp/waves only, per `MetricSource`. */
  estimatedFactors: string[];
}

/**
 * `completeness` = Σ(weight × credit) / Σ(weight) over every weighted
 * sub-score. Credit is per-factor: 1 for a sub-score that has a reading and
 * either carries no provenance tracking or was observed (buoy), 0.5 when its
 * `Derived` source is model-only (`waterTempSource`/`waveHeightSource`.kind
 * === "model" — a forecast standing in for a live reading, not the real
 * thing), 0 when missing entirely. Weight-0 factors are already absent from
 * `subs` (see scoreBeachDay), so they never enter either side. Empty `subs`
 * (no factors configured at all) reads as fully complete — there's nothing to
 * be missing.
 *
 * Classification (full/partial/limited) is decided on the UNROUNDED ratio so
 * a value just below a threshold (e.g. 0.5999999) never gets rounded across
 * it; only the returned `completeness` number itself is rounded, for display
 * and storage.
 */
function computeCompleteness(subs: SubScore[], d: Derived): Completeness {
  const totalW = subs.reduce((a, s) => a + s.weight, 0);
  const missing: SubScore[] = [];
  const estimated: SubScore[] = [];
  let creditedW = 0;
  for (const s of subs) {
    if (s.score == null) {
      missing.push(s);
      continue;
    }
    const source =
      s.key === "waterTemp" ? d.waterTempSource : s.key === "waves" ? d.waveHeightSource : undefined;
    if (source?.kind === "model") {
      estimated.push(s);
      creditedW += s.weight * 0.5;
    } else {
      creditedW += s.weight;
    }
  }
  const rawCompleteness = totalW > 0 ? creditedW / totalW : 1;
  const dataCoverage: DataCoverage =
    rawCompleteness >= COMPLETENESS_FULL_MIN
      ? "full"
      : rawCompleteness >= COMPLETENESS_PARTIAL_MIN
        ? "partial"
        : "limited";
  return {
    completeness: round(rawCompleteness, 2),
    dataCoverage,
    missingFactors: missing.map((s) => s.key),
    estimatedFactors: estimated.map((s) => s.key),
  };
}

function f1(n: number | undefined, unit: string): string | undefined {
  return n == null ? undefined : `${n}${unit}`;
}

function sub(
  key: string,
  label: string,
  score: number | null,
  weight: number,
  display?: string,
): SubScore {
  return { key, label, score: score == null ? null : Math.round(score), weight, display };
}

/**
 * Comfort (mugginess) from dew point — the real "how heavy does the air feel"
 * signal (sweat can't evaporate as the dew point climbs). Tuned for the
 * SHORE, not inland: water and a sea breeze make humidity far more tolerable,
 * so <=65°F is a perfect 100 and each °F above costs 2.5 (70°F→88, 75°F→75,
 * 80°F→63). The old curve (free to 60°F, −5/°F) made comfort the single most
 * expensive factor on good days — 3.8 points on average, more than waves or
 * sky — and scored every Florida summer day 25–40 here (owner, 2026-10-06,
 * docs/scorecards/README.md "Model changes"). Very high relative humidity
 * (>85%) adds a small extra penalty. Null when no dew point is known.
 */
function comfortScore(d: Derived): number | null {
  if (d.dewPointF == null) return null;
  let s = clamp(100 - Math.max(0, d.dewPointF - COMFORT_FREE_DEW_F) * COMFORT_PER_DEG_F, 0, 100);
  if (d.humidityPct != null && d.humidityPct > 85) {
    s = clamp(s - (d.humidityPct - 85) * 1.5, 0, 100);
  }
  return s;
}

function comfortDisplay(d: Derived): string | undefined {
  if (d.dewPointF == null) return undefined;
  const parts = [`${d.dewPointF}°F dew pt`];
  if (d.humidityPct != null) parts.push(`${d.humidityPct}% RH`);
  return parts.join(" · ");
}

/** Piecewise-linear interpolation through sorted (x,y) anchors, clamped to the ends. */
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
 * Seaweed (sargassum) as a beach-quality sub-score. When the vision job reports a
 * 0-100 coverage %, we interpolate a fine score through anchors that match the
 * categorical values exactly (so nothing regresses); otherwise we fall back to the
 * category map. Unknown → null (excluded from the average). Moderate/high ALSO cap
 * the score by category (see applyBeachCaps).
 */
const SARGASSUM_SCORE: Record<string, number> = { none: 100, low: 85, moderate: 55, high: 20 };
const SEAWEED_COVER_CURVE: [number, number][] = [
  [0, 100],
  [10, 85],
  [30, 55],
  [60, 20],
  [100, 0],
];
function sargassumScore(level: SargassumRisk | undefined, pct?: number): number | null {
  if (pct != null) return lerpCurve(pct, SEAWEED_COVER_CURVE);
  return level && level in SARGASSUM_SCORE ? SARGASSUM_SCORE[level] : null;
}
function sargassumDisplay(d: Derived): string | undefined {
  if (!d.sargassumLevel || d.sargassumLevel === "unknown") return undefined;
  const label = d.sargassumLevel[0].toUpperCase() + d.sargassumLevel.slice(1);
  return d.sargassumCoveragePct != null ? `${label} · ~${d.sargassumCoveragePct}% covered` : label;
}

/** Representative fullness % for a categorical crowd level (fallback when no pct). */
const CROWD_LEVEL_PCT: Record<string, number> = {
  empty: 5,
  quiet: 25,
  moderate: 50,
  busy: 75,
  packed: 95,
};
function crowdLevelPct(level: string | undefined): number | undefined {
  return level && level in CROWD_LEVEL_PCT ? CROWD_LEVEL_PCT[level] : undefined;
}
/** Crowds as a beach-quality sub-score: emptier is better, packed is worst. */
const CROWD_CURVE: [number, number][] = [
  [0, 100],
  [25, 90],
  [50, 70],
  [75, 45],
  [100, 25],
];
function crowdScore(pct: number | undefined): number | null {
  return pct == null ? null : lerpCurve(pct, CROWD_CURVE);
}

/**
 * Sand barefoot-comfort as a sub-score: fine under ~95°F, sandals territory
 * through the low 100s-120s, burn-risk sand near worthless. Mirrors the
 * verdict bands in lib/sandTemp.ts.
 */
const SAND_CURVE: [number, number][] = [
  [95, 100],
  [115, 70],
  [130, 35],
  [145, 5],
];
function sandScore(tempF: number | undefined): number | null {
  return tempF == null ? null : lerpCurve(tempF, SAND_CURVE);
}

/**
 * The Beach Day score for one set of conditions.
 *
 * `opts` is the whole engine as data — weights, ideals, cap policy. The default
 * (`DEFAULT_SCORING`) is the free score, byte-identical to what it has always
 * produced; a personal profile (see lib/profile/resolve.ts) passes its own.
 * Factors weighted 0 are dropped from `subScores` entirely, so the wheel and the
 * explainer never show a slice that cannot move the number.
 */
export function scoreBeachDay(d: Derived, opts: ScoringOptions = DEFAULT_SCORING): ScoreResult {
  const w = opts.weights;
  const { airPlateau, waterPlateau, windPlateau, waveMode } = opts.ideals;
  const all: SubScore[] = [
    sub(
      "airTemp",
      "Air temperature",
      d.airTempF != null ? plateau(d.airTempF, airPlateau[0], airPlateau[1], 18) : null,
      w.airTemp,
      f1(d.airTempF, "°F"),
    ),
    sub("sky", "Sky (sun & rain)", skyScore(d), w.sky, skyDisplay(d)),
    sub(
      "wind",
      "Wind (sea breeze)",
      d.windSpeedMph != null
        ? windScore(d.windSpeedMph, windPlateau[0], windPlateau[1], opts.ideals.windFalloffHigh)
        : null,
      w.wind,
      d.windSpeedMph != null
        ? `${d.windSpeedMph} mph${d.windDirDeg != null ? " " + degToCardinal(d.windDirDeg) : ""}`
        : undefined,
    ),
    sub("comfort", "Comfort (mugginess)", comfortScore(d), w.comfort, comfortDisplay(d)),
    sub(
      "waterTemp",
      "Water temperature",
      // Full credit 77-90°F. The old top end (84°F) treated warm summer ocean
      // as a defect — 87°F Boca bathwater was quietly costing ~2 points. For a
      // BEACHGOER, warmer is better right up until genuinely hot-tub territory;
      // only past 90°F does it start to read as soup (and it also tracks coral
      // bleaching / weaker cooling-off value).
      d.waterTempF != null
        ? plateau(d.waterTempF, waterPlateau[0], waterPlateau[1], 15)
        : null,
      w.waterTemp,
      f1(d.waterTempF, "°F"),
    ),
    sub(
      "waves",
      "Sea state (swim calmness)",
      d.waveHeightFt != null ? waveScore(d.waveHeightFt, waveMode) : null,
      // 0.14 = its own 0.08 + water quality's old 0.06 (water quality left the
      // weighted score to become advisory-cap-only; owner 2026-07-17).
      w.waves,
      d.waveHeightFt != null
        ? `${f1(d.waveHeightFt, " ft")} · ${seaState(d.waveHeightFt).label.toLowerCase()}`
        : undefined,
    ),
    sub(
      "sargassum",
      "Seaweed (sargassum)",
      sargassumScore(d.sargassumLevel, d.sargassumCoveragePct),
      w.sargassum,
      sargassumDisplay(d),
    ),
    sub(
      "crowds",
      "Crowds",
      crowdScore(d.crowdPct),
      w.crowds,
      d.crowdPct != null ? `~${d.crowdPct}% full` : undefined,
    ),
    sub(
      "uv",
      "UV index",
      d.uvIndex != null ? uvScore(d.uvIndex) : null,
      w.uv,
      d.uvIndex != null ? `${d.uvIndex}` : undefined,
    ),
    sub(
      "sandTemp",
      "Sand temperature (barefoot)",
      sandScore(d.sandTempF),
      w.sandTemp,
      d.sandTempF != null ? `~${d.sandTempF}°F est.` : undefined,
    ),
    sub(
      "clarity",
      "Water clarity",
      d.clarityPct != null ? clamp(d.clarityPct, 0, 100) : null,
      w.clarity,
      d.clarityPct != null ? `~${d.clarityPct}% clear` : undefined,
    ),
  ];
  // A factor nobody weighted is not part of this score at all: it never reaches
  // the average, the wheel, or the explainer. This is what keeps the free score
  // identical after clarity joined the list (clarity weighs 0 by default).
  const subs = all.filter((s) => s.weight > 0);
  const { completeness, dataCoverage, missingFactors, estimatedFactors } = computeCompleteness(
    subs,
    d,
  );

  const rawScore = combine(subs);
  // Total data outage: no weather sub-score was available. Surface it explicitly
  // (score 0, "Unavailable", dataAvailable: false). We STILL run the safety caps
  // so a hazard we genuinely observe — e.g. lightning within 5 mi from the GLM
  // feed, which is independent of the weather pipeline — still registers as a cap
  // reason even when every forecast feed is down. (Math.min keeps the score at 0.)
  if (rawScore == null) {
    const { caps, scoreExceptRipCap } = applyBeachCaps(0, d, opts.capPolicy);
    return {
      score: 0,
      rawScore: 0,
      rating: "Unavailable",
      subScores: subs,
      caps,
      scoreExceptRipCap,
      dataAvailable: false,
      completeness,
      dataCoverage,
      missingFactors,
      estimatedFactors,
    };
  }
  let { score, caps, scoreExceptRipCap } = applyBeachCaps(rawScore, d, opts.capPolicy);
  // Thin-data honesty cap: a beach with under 60% of its weighted factors
  // reporting cannot read "Yes!"/"Absolutely!" on mostly-missing information.
  // Pushed through the same `caps` array the safety caps use, so it shows
  // wherever caps show (ScoreCapBanner) whenever it actually holds the score
  // down; DataCoverageNote (components/) surfaces the coverage tier itself,
  // including `partial`, which gets a quiet label but no numeric cap.
  if (dataCoverage === "limited") {
    score = Math.min(score, LIMITED_DATA_CAP);
    scoreExceptRipCap = Math.min(scoreExceptRipCap, LIMITED_DATA_CAP);
    caps.push(
      `Limited data — ${missingFactors.length} factor${missingFactors.length === 1 ? "" : "s"} unavailable`,
    );
  }
  return {
    score,
    rawScore,
    rating: ratingFor(score),
    subScores: subs,
    caps,
    scoreExceptRipCap,
    dataAvailable: true,
    completeness,
    dataCoverage,
    missingFactors,
    estimatedFactors,
  };
}

export type RainSeverity = "none" | "rain" | "thunder";

/**
 * Whether it's actively raining/stormy. WMO weather codes are authoritative when
 * present (the hourly-forecast path); otherwise we read the forecast text but
 * ignore hedged "chance/slight/possible" wording, so a mere *chance* of rain does
 * not trip the cap (it still feeds skyScore via precip probability).
 */
export function rainSeverity(d: Derived): RainSeverity {
  const c = d.weatherCode;
  if (c != null) {
    // Corroboration rule: a rain/thunder code must be backed by the same
    // model's own precipitation probability. Open-Meteo has emitted code 95
    // ("Thunderstorm") for hours it simultaneously gave 1% rain probability,
    // 0.00" precip, and satellite-observed near-full sun (2026-06-12, 11 AM
    // & 1 PM ET) — a lone uncorroborated code must not cap the score. When
    // probability is unavailable the code stands (fail safe).
    const corroborated = d.precipProbability == null || d.precipProbability >= 25;
    if (c >= 95 && c <= 99) return corroborated ? "thunder" : "none";
    if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82))
      return corroborated ? "rain" : "none";
    return "none"; // includes snow 71-86 — not relevant in S. FL, not a "rain" cap
  }
  const f = d.shortForecast?.toLowerCase() ?? "";
  if (/chance|slight|possible|isolated/.test(f)) return "none";
  if (/thunder|storm/.test(f)) return "thunder";
  if (/rain|shower|drizzle/.test(f)) return "rain";
  return "none";
}

/**
 * Clamp a raw score for the hazards that are really out there.
 *
 * `policy` decides WHICH hazards clamp THIS person's day (the safety line in
 * lib/safetyLine.ts still reports every one of them, to everybody):
 *  - `water` — all of them, the free score's behavior.
 *  - `shore` — weather only. A red flag does not spoil a day on the sand.
 *  - `surf`  — weather plus the closures. A red flag or a high rip is what a
 *              surfer came for; a closed beach or dirty water still is not.
 */
export function applyBeachCaps(
  raw: number,
  d: Derived,
  policy: CapPolicy = "water",
): { score: number; caps: string[]; scoreExceptRipCap: number } {
  let score = raw;
  // Mirrors `score` through every cap EXCEPT the rip-current one (item 3):
  // since a chain of `Math.min` is associative/commutative, this equals "the
  // score with every OTHER cap applied, rip cap excluded" regardless of
  // where in the chain the rip cap sits. The client uses it to recompute the
  // rip cap against a LIVE clock in both directions — tightening when a new
  // hazard applies that a cached response didn't know about, AND loosening
  // when an alert has since ended — without ever dropping any of the OTHER
  // caps (severe weather, wind, rain, flags, etc) that still legitimately
  // constrain the number.
  let scoreExceptRip = raw;
  const caps: string[] = [];
  // Swim-hazard caps (red flag, rip, surf advisory) apply to swimmers only.
  const swimCaps = policy === "water";
  // Closures (double red, dirty water, city no-swim) stop a surfer too.
  const closureCaps = policy === "water" || policy === "surf";
  // Lifeguard flags are safety signals. We distinguish a true closure from a
  // swim-hazard warning:
  //  - DOUBLE-RED means the water is closed — there's no beach day to be had, so
  //    it bottoms the score out.
  //  - A single RED flag means rough/hazardous surf where swimming is
  //    discouraged. Not a closure — the sand is still there — but a red-flag
  //    day must not read "Yes — good beach day": it caps at 70 ("Decent").
  //    Was 85 until 2026-09-28 (owner: red flags and high surf cap at 70).
  // The purple (dangerous marine life) flag is intentionally NOT a score cap —
  // it's a near-constant in South Florida, so it carries no day-to-day signal.
  if (closureCaps && d.flags.includes("double-red")) {
    score = Math.min(score, 5);
    scoreExceptRip = Math.min(scoreExceptRip, 5);
    caps.push("Double red flag — water access closed");
  } else if (swimCaps && d.flags.includes("red")) {
    score = Math.min(score, 70);
    scoreExceptRip = Math.min(scoreExceptRip, 70);
    caps.push("Red flag — high hazard, swimming discouraged");
  }
  if (closureCaps && d.waterAdvisory) {
    score = Math.min(score, 40);
    scoreExceptRip = Math.min(scoreExceptRip, 40);
    caps.push("Water quality advisory in effect");
  }
  // A City-issued no-swim advisory is a direct swim-safety override.
  if (closureCaps && d.noSwimAdvisory) {
    score = Math.min(score, 40);
    scoreExceptRip = Math.min(scoreExceptRip, 40);
    caps.push("City no-swim advisory in effect");
  }
  // Heavy/moderate seaweed isn't a safety hazard but it genuinely degrades the
  // beach (smelly brown mats, murky water) — so it caps how good the day can be.
  // The OLD design hard-capped at 65 for ANY "high" day and 85 for "moderate" —
  // that over-punished a barely-high ~65%-covered beach exactly as hard as one
  // that's fully blanketed. The cam-vision coverage % is the honest "how heavy"
  // signal (the weighted sargassumScore sub-score already scales with it — left
  // as-is here), so the ceiling now slides with coverage instead of the category:
  // below 50% coverage there's no extra ceiling at all (the sub-score alone
  // carries the penalty); from 50% to 90% coverage the ceiling tightens linearly
  // from 100 down to 70; at/above 90% coverage it's flat at 70 — the owner wants
  // "90 to 100 percent capped at 70", never lower, so a full-on blanket doesn't
  // read as a beach closure.
  {
    const SEAWEED_FALLBACK_PCT: Record<string, number> = { high: 70, moderate: 40, low: 15 };
    const c =
      typeof d.sargassumCoveragePct === "number" && Number.isFinite(d.sargassumCoveragePct)
        ? d.sargassumCoveragePct
        : (d.sargassumLevel && SEAWEED_FALLBACK_PCT[d.sargassumLevel]) ?? 0;
    if (c >= 50) {
      const ceiling = c >= 90 ? 70 : Math.round(100 - (c - 50) * 0.75);
      if (ceiling < score) {
        const severity = c >= 90 ? "Extremely heavy seaweed" : "Heavy seaweed";
        caps.push(`${severity} — ~${Math.round(c)}% of the beach covered`);
      }
      score = Math.min(score, ceiling);
      scoreExceptRip = Math.min(scoreExceptRip, ceiling);
    }
  }
  // Rip-current risk: HIGH means life-threatening rip currents are likely.
  // Like a red flag, this is a swimmer-safety hazard rather than a beach-day
  // killer — you can still enjoy the sand — so it caps at 85, not lower.
  //
  // TEMPORAL CORRECTNESS (2026-09-24 fix): the cap is driven by d.ripNow, NOT
  // a flat word — an alert that hasn't started yet (scheduled) or has already
  // ended must never cap the score. See lib/ripRisk/resolve.ts's
  // resolveRipNow for the full freshness/disagreement hierarchy (alert in
  // effect always High; a fresh NOAA model reading, possibly softened one
  // band below a disagreeing SRF word; else the SRF word itself).
  if (swimCaps) {
    const cap = ripCapFor(d.ripNow);
    if (cap != null) {
      score = Math.min(score, cap);
      caps.push(
        d.ripNow?.source === "alert"
          ? "Rip current warning in effect"
          : `Rip current risk: ${d.ripNow?.level === "high" ? "High" : "Moderate"}`,
      );
    }
  }
  // A HIGH SURF advisory means dangerous breaking surf: capped at 70 like a
  // red flag (owner 2026-09-28). A coastal-flood advisory or Beach Hazards
  // Statement stays a soft 85 — king tides trigger coastal-flood advisories
  // on many calm fall days, and those days should not read "Decent". The
  // WARNING tier of either is the hard SEVERE_ALERT cap below.
  if (swimCaps && d.highSurfAdvisory) {
    score = Math.min(score, 70);
    scoreExceptRip = Math.min(scoreExceptRip, 70);
    caps.push("High surf advisory — dangerous surf, swimming discouraged");
  }
  if (swimCaps && d.surfAdvisory) {
    score = Math.min(score, 85);
    scoreExceptRip = Math.min(scoreExceptRip, 85);
    caps.push("Coastal flood or beach hazards advisory — swimming discouraged");
  }
  // A severe NWS warning (hurricane/tropical storm/tsunami/high surf) closes the day.
  if (d.severeAlert) {
    score = Math.min(score, 15);
    scoreExceptRip = Math.min(scoreExceptRip, 15);
    caps.push("Severe weather warning in effect");
  }
  // Strong wind is a day-wrecker regardless of how nice everything else is: blown
  // sand, whitecapped water, umbrellas taking flight. Over 20 mph hard-caps at 15
  // (owner 2026-07-17). Wind is also a weighted sub-score, but that only tapers;
  // this is the ceiling on a genuinely windy day.
  if ((d.windSpeedMph ?? 0) > 20) {
    score = Math.min(score, 15);
    scoreExceptRip = Math.min(scoreExceptRip, 15);
    caps.push("High wind — over 20 mph");
  }
  // OBSERVED lightning (GOES GLM) within 5 mi in the recent scan window is a
  // get-out-of-the-water emergency — the single most dangerous beach condition.
  // This is observed data, so it bottoms the score regardless of the forecast.
  if (d.lightningWithin5mi) {
    score = Math.min(score, 10);
    scoreExceptRip = Math.min(scoreExceptRip, 10);
    caps.push(
      d.hazardLightning?.latched
        ? "Lightning within 5 miles in the last 30 minutes"
        : "Lightning within 5 miles — get out of the water",
    );
  }
  // Rain is a hard ceiling on the whole day. We trust OBSERVATION over forecast:
  // the live nowcast ("it's raining right now") overrides the forecast-code path,
  // which can miss a real storm when the model's precip probability is low (the
  // corroboration rule in rainSeverity would otherwise veto it).
  const rain = rainSeverity(d);
  if (rain === "thunder") {
    score = Math.min(score, 15);
    scoreExceptRip = Math.min(scoreExceptRip, 15);
    caps.push("Thunderstorm in the forecast");
  } else if (d.nowcastRaining) {
    // It's observed-raining now. If an independent storm signal corroborates a
    // thunderstorm (a vetoed thunder code, or storm/thunder in the forecast
    // text), treat it as a storm cap (15) rather than plain rain (25).
    const stormSignal =
      (d.weatherCode != null && d.weatherCode >= 95 && d.weatherCode <= 99) ||
      /thunder|storm/i.test(d.shortForecast ?? "");
    if (stormSignal) {
      score = Math.min(score, 15);
      scoreExceptRip = Math.min(scoreExceptRip, 15);
      caps.push("Thunderstorm — raining now");
    } else {
      score = Math.min(score, 25);
      scoreExceptRip = Math.min(scoreExceptRip, 25);
      caps.push(d.hazardRain?.latched ? "Rain in the last 20 minutes" : "Raining right now");
    }
  } else if (rain === "rain" && !d.radarDryNow) {
    // A forecast rain code for the current hour yields to a fresh radar frame
    // that sees nothing (radarDryNow is set on the now-bucket only, so future
    // hours keep their forecast caps). Thunder is deliberately NOT vetoed here:
    // the lightning feed owns that, and a dry radar says nothing about strikes.
    score = Math.min(score, 25);
    scoreExceptRip = Math.min(scoreExceptRip, 25);
    caps.push("Rain in the forecast");
  }
  return { score, caps, scoreExceptRipCap: scoreExceptRip };
}

const RIP_CAP_LABEL_PREFIX = "rip current";

/**
 * Re-applies a LIVE rip cap to an already-computed `ScoreResult` (item 3,
 * 2026-09-24 round 2/3 fix) — pure, so the client (ConditionsDashboard.tsx)
 * can recompute the displayed score/rating/caps against a minute-ticking
 * clock without re-running the whole scoring pipeline. Uses
 * `base.scoreExceptRipCap` (every OTHER cap applied, rip cap excluded) as
 * the foundation, so the result follows the clock in BOTH directions:
 * tighter when `liveRipCap` newly applies, looser when it's gone (an
 * expired alert's cap AND its "(NWS alert)"/"(NOAA model)" explanation both
 * disappear on time) — without ever dropping any other cap still in force.
 * `rating` is recomputed from the adjusted score via `scoreBand`, so the
 * headline word (ScoreWheel's center label) never lags the number.
 * Falls back to a simple tighten-only clamp against `base.score` itself
 * when `base` predates `scoreExceptRipCap` (back-compat with an older
 * cached payload).
 */
export function applyLiveRipCap(
  base: ScoreResult,
  liveRipCap: number | null,
  ripNow: RipNow | null | undefined,
): ScoreResult {
  const otherCaps = base.caps.filter((c) => !c.toLowerCase().includes(RIP_CAP_LABEL_PREFIX));
  const liveRipCapLabel =
    liveRipCap != null && ripNow
      ? ripNow.source === "alert"
        ? "Rip current warning in effect"
        : `Rip current risk: ${ripNow.level === "high" ? "High" : "Moderate"}`
      : null;

  if (base.scoreExceptRipCap != null) {
    const adjustedScore = liveRipCap != null ? Math.min(base.scoreExceptRipCap, liveRipCap) : base.scoreExceptRipCap;
    return {
      ...base,
      score: adjustedScore,
      rating: scoreBand(adjustedScore).rating,
      caps: liveRipCapLabel ? [...otherCaps, liveRipCapLabel] : otherCaps,
    };
  }
  // Back-compat, tighten-only (no scoreExceptRipCap to recompute from).
  if (liveRipCap != null && liveRipCap < base.score) {
    return {
      ...base,
      score: liveRipCap,
      rating: scoreBand(liveRipCap).rating,
      caps: liveRipCapLabel && !otherCaps.includes(liveRipCapLabel) ? [...otherCaps, liveRipCapLabel] : base.caps,
    };
  }
  return base;
}

export function computeScore(
  s: ConditionsSnapshot,
  opts: ScoringOptions = DEFAULT_SCORING,
  nowMs: number = Date.now(),
): ScoreResult {
  return scoreBeachDay(deriveMetrics(s, nowMs), opts);
}

const HOUR_MS = 3_600_000;

/**
 * Forecast the Beach Day score across today's daylight hours. Reuses the pure
 * `scoreBeachDay` by combining each forecast hour's weather with the day-constant
 * water / quality / flag inputs from the current snapshot. Bounded to the hours
 * between sunrise and sunset. Returns [] when hourly data is unavailable.
 *
 * Seaweed is point-in-time: hours that have already passed score with the cam
 * read that was in effect at that hour (today's read log), so a later change
 * never retroactively rewrites the morning. Current and future hours use the
 * latest read. `nowMs` is injectable for tests.
 */
/** One fully-scored hour: the compact `HourlyScore` plus the full breakdown
 *  (sub-scores + caps) that produced it, for callers that need more than the
 *  chart curve (e.g. the outlook strip's per-day "anticipated scoring"). */
interface FullHourlyScore {
  time: string;
  result: ScoreResult;
  emoji: string;
  raining: boolean;
  windSpeedMph?: number;
  windDirDeg?: number;
}

function toHourlyScore(h: FullHourlyScore): HourlyScore {
  return {
    time: h.time,
    score: h.result.score,
    rating: h.result.rating,
    emoji: h.emoji,
    raining: h.raining,
    windSpeedMph: h.windSpeedMph,
    windDirDeg: h.windDirDeg,
  };
}

/**
 * Score EVERY fetched hourly bucket (no daylight filter), reusing day-constant
 * inputs from the snapshot. Shared by `computeHourlyScores` (today's daylight
 * chart) and `computeMultiDayWindows` (the multi-day best-times forecast).
 * Observed-"now" signals (nowcast rain, fresh lightning) are applied ONLY to the
 * bucket containing `nowMs`, so future days never inherit them. Returns the
 * FULL per-hour breakdown (sub-scores + caps); `scoreAllHours` below projects
 * it down to the compact `HourlyScore` shape used by the chart curve.
 */
function scoreAllHoursFull(
  s: ConditionsSnapshot,
  nowMs: number = Date.now(),
  opts: ScoringOptions = DEFAULT_SCORING,
): FullHourlyScore[] {
  const hours = s.hourly.data;
  if (!hours?.length) return [];

  // Day-constant inputs (water temp/quality/flags/seaweed) reuse the snapshot.
  const base = deriveMetrics(s);

  // Waves are NOT day-constant: the marine model forecasts them hour by hour
  // for the week (lib/sources/marine.ts, forecast_days=7). Before this lookup
  // every future hour scored today's reading, so all seven day cards read the
  // same sea state (2026-09-10: "3 ft · really choppy" for a week that was
  // forecast to calm to under 2 ft). An hour outside the marine horizon still
  // falls back to today's reading.
  // Raw Hs (total + swell, each with its OWN period) per hour — converted to
  // a surf estimate below via `estimateSurfFromSources`, alongside `base`'s
  // already-converted current reading (see `Derived.waveHeightFt`'s doc
  // comment for why a height and period must stay paired to the same
  // reading — total with total, swell with swell, never cross-paired).
  const waveByTime = new Map<
    string,
    {
      waveHeightFt?: number;
      wavePeriodS?: number;
      swellHeightFt?: number;
      swellPeriodS?: number;
      /** Set when this hour came from the NWPS nearshore series (used as-is,
       *  no breaker amplification — see `nwpsSurf`). */
      nwps?: boolean;
    }
  >();
  for (const w of s.marine.data?.hourlyWaves ?? []) {
    // A usable hour has a total height OR a complete swell height+period
    // pair (Codex review round-3 #1) — requiring the total unconditionally
    // dropped every swell-only hour before it ever reached
    // `estimateSurfFromSources`, which is able to estimate from the swell
    // pair alone.
    const hasTotal = w.waveHeightFt != null;
    const hasSwellPair = w.swellHeightFt != null && w.swellPeriodS != null;
    if (hasTotal || hasSwellPair) {
      waveByTime.set(w.time, {
        waveHeightFt: w.waveHeightFt,
        wavePeriodS: w.wavePeriodS,
        swellHeightFt: w.swellHeightFt,
        swellPeriodS: w.swellPeriodS,
      });
    }
  }
  // The NWPS nearshore series wins every hour it covers — same preference as
  // the current reading above (2026-10-08). Hours past its horizon keep the
  // marine model's hour.
  for (const h of s.ripNwps?.data?.hours ?? []) {
    if (h.hsFt == null || !Number.isFinite(h.hsFt) || h.hsFt < 0) continue;
    const t = Date.parse(h.t);
    if (!Number.isFinite(t)) continue;
    waveByTime.set(new Date(t).toISOString(), {
      waveHeightFt: h.hsFt,
      wavePeriodS: h.periodS != null && Number.isFinite(h.periodS) ? h.periodS : undefined,
      nwps: true,
    });
  }

  // Crowds vary through the day: map each LOCAL hour to its typical fullness.
  const tz = s.location.timezone;
  const localHourOf = (iso: string) =>
    Number(
      new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(
        new Date(iso),
      ),
    ) % 24;
  const crowdByHour = new Map<number, number | undefined>();
  for (const bh of s.busyness.data?.byHour ?? []) {
    crowdByHour.set(bh.hour, bh.crowdPct ?? crowdLevelPct(bh.level));
  }

  // The seaweed read in effect at a given past local hour: the last of today's
  // reads at-or-before that hour, else the day's first read (closest we have).
  // These reads belong to TODAY only, so they're applied only to today's hours
  // (see `isToday` below) — never to prior days' hours (from past_days=2) or to
  // future days, which use the latest read instead.
  const reads = s.sargassum.data?.todayReads ?? [];
  const seaweedAtHour = (localHour: number) => {
    const prior = reads.filter((r) => r.hour <= localHour);
    return prior.length ? prior[prior.length - 1] : reads[0];
  };
  const localDateOf = (iso: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(iso));
  const todayLocal = localDateOf(new Date(nowMs).toISOString());

  // Per-hour sand estimate (recent rain = that hour + the two before it),
  // computed against the full hourly array before the daylight filter.
  const sandByTime = new Map<string, number | undefined>();
  hours.forEach((h, i) => {
    sandByTime.set(
      h.time,
      estimateSandTempF({
        soilTempF: h.soilTempF,
        solarWm2: h.solarWm2,
        windSpeedMph: h.windSpeedMph,
        recentRainIn: [i, i - 1, i - 2].reduce((a, j) => a + (hours[j]?.precipIn ?? 0), 0),
        cloudCoverPct: h.cloudCoverPct,
        // Per-hour afternoon decay (each forecast hour tapers by its own phase).
        hoursFromSolarNoon: hoursFromSolarNoon(s.location.lon, new Date(h.time)),
      }),
    );
  });

  return hours
    .map((h) => {
      // Past hours keep the read that was current then; now/future use latest.
      // Only TODAY's past hours map to historical reads — yesterday's hours and
      // future days fall through to the latest read (base.sargassumLevel).
      const hStart = new Date(h.time).getTime();
      const isPast = hStart + HOUR_MS <= nowMs;
      const isToday = localDateOf(h.time) === todayLocal;
      const histRead = isPast && isToday ? seaweedAtHour(localHourOf(h.time)) : undefined;
      // The bucket that strictly CONTAINS now gets the observed-"now" signals
      // (nowcast rain + fresh lightning); every other hour is forecast-only and
      // leaves these unset. NWS alerts/flags (severeAlert, surfAdvisory, rip,
      // flags) are TODAY-constant rather than now-only, so they apply to all of
      // TODAY's hours (otherwise an all-day advisory would only cap the current
      // hour and bestBeachWindow could pick an uncapped future hour today) — but
      // NOT to future days; see the isToday gates below.
      const isCurrentHour = hStart <= nowMs && nowMs < hStart + HOUR_MS;
      // The hour containing "now" keeps the dashboard's own reading when that
      // reading is a buoy observation — otherwise the headline could say 1 ft
      // (buoy) while this same hour scores 1.9 ft (model) (Codex 2026-10-08
      // #4). Model hours start with the next hour.
      const hourlyWave =
        isCurrentHour && base.waveHeightSource?.kind === "buoy" ? undefined : waveByTime.get(h.time);
      const hourlySurf = hourlyWave
        ? hourlyWave.nwps && hourlyWave.waveHeightFt != null
          ? nwpsSurf({ hsFt: hourlyWave.waveHeightFt, periodS: hourlyWave.wavePeriodS })
          : estimateSurfFromSources({
              totalHeightFt: hourlyWave.waveHeightFt,
              totalPeriodS: hourlyWave.wavePeriodS,
              swellHeightFt: hourlyWave.swellHeightFt,
              swellPeriodS: hourlyWave.swellPeriodS,
            })
        : undefined;
      const d: Derived = {
        airTempF: h.airTempF,
        waterTempF: base.waterTempF,
        windSpeedMph: h.windSpeedMph,
        windDirDeg: h.windDirDeg,
        waveHeightFt: hourlySurf ? hourlySurf.surfFt : base.waveHeightFt,
        // This hour's own TOTAL height (whatever the model reported for THIS
        // hour), never the swell component — same round-2 #1 fix as `base`.
        waveTotalHsFt: hourlyWave ? hourlyWave.waveHeightFt : base.waveTotalHsFt,
        waveSwellHeightFt: hourlySurf ? hourlySurf.rawHeightFt : base.waveSwellHeightFt,
        wavePeriodS: hourlySurf ? hourlySurf.rawPeriodS : base.wavePeriodS,
        // Water temp is day-constant (reuses the snapshot's source); waves
        // above come from the marine model's per-hour forecast whenever it
        // covers this hour, so THAT hour's source is "model" even though
        // `base.waveHeightSource` may say "buoy" for today's current reading
        // — otherwise every future hour would misreport itself as observed.
        waterTempSource: base.waterTempSource,
        waveHeightSource: hourlyWave
          ? { kind: "model", model: hourlyWave.nwps ? "nwps" : "open-meteo" }
          : base.waveHeightSource,
        precipProbability: h.precipProbability,
        shortForecast: h.shortForecast,
        uvIndex: h.uvIndex,
        cloudCoverPct: h.cloudCoverPct,
        humidityPct: h.humidityPct,
        dewPointF: h.dewPointF,
        weatherCode: h.weatherCode,
        // Seaweed is a TODAY-only observation (the cams see the beach right now,
        // not next Tuesday) — past hours use the read in effect then, the rest of
        // today uses the latest read, and FUTURE DAYS score with seaweed unknown
        // (sub-score excluded + no cap), so a heavy-seaweed 65-cap today can't
        // flat-line the whole week's forecast.
        sargassumLevel: isToday ? (histRead?.level ?? base.sargassumLevel) : undefined,
        sargassumCoveragePct: isToday
          ? histRead
            ? histRead.coveragePct
            : base.sargassumCoveragePct
          : undefined,
        crowdPct: crowdByHour.get(localHourOf(h.time)),
        sandTempF: sandByTime.get(h.time),
        // Clarity, like seaweed, is a TODAY-only cam observation — the cams see
        // this water now, not next Tuesday. Future days score it as unknown.
        clarityPct: isToday ? base.clarityPct : undefined,
        // Current NWS alerts/flags are TODAY-only conditions (most expire within
        // the day) — apply them to TODAY's hours only, NEVER to future days, so a
        // single warning/flag today can't flat-line the whole week's forecast.
        // (Water quality + surf/seaweed are slowly-changing, so they stay carried
        // forward as an estimate.)
        flags: isToday ? base.flags : [],
        waterAdvisory: base.waterAdvisory,
        waterRating: base.waterRating,
        noSwimAdvisory: base.noSwimAdvisory,
        ripCurrentRisk: isToday ? base.ripCurrentRisk : "unknown",
        // Resolved against THIS hour's own clock (hStart), not global `now` —
        // a future hour reflects whichever alert/SRF period will actually
        // apply THEN (e.g. an alert whose onset lands mid-afternoon caps only
        // the hours at/after onset, not the whole day). TODAY-only, same gate
        // as every other NWS-alert-derived field above.
        ripNow: isToday
          ? resolveRipNow({
              alerts: s.nws.data?.alerts ?? [],
              srfPeriods:
                s.nws.data?.srfPeriods ??
                (base.ripCurrentRisk !== "unknown" ? [{ label: "TODAY", level: base.ripCurrentRisk }] : []),
              model: modelNowFromSeries(s.ripNwps?.data ?? null, hStart),
              now: hStart,
              // Overlap, not point-in-time: an alert that starts/ends mid-hour
              // still covers this whole bucket (item 11 — max severity within
              // the hour, never missed because hStart itself precedes onset).
              hourEndMs: hStart + 3_600_000,
            })
          : {
              source: "unknown",
              level: "unknown",
              alert: null,
              upcomingAlert: null,
              period: null,
              model: null,
              watch: false,
            },
        severeAlert: isToday ? base.severeAlert : false,
        surfAdvisory: isToday ? base.surfAdvisory : false,
        highSurfAdvisory: isToday ? base.highSurfAdvisory : false,
        ...(isCurrentHour
          ? {
              nowcastRaining: base.nowcastRaining,
              radarDryNow: base.radarDryNow,
              lightningWithin5mi: base.lightningWithin5mi,
              lightningLastMinutesAgo: base.lightningLastMinutesAgo,
              hazardLightning: base.hazardLightning,
              hazardRain: base.hazardRain,
            }
          : {}),
      };
      const r = scoreBeachDay(d, opts);
      const raining = rainSeverity(d) !== "none";
      // When the corroboration rule vetoes a phantom rain/thunder code, don't
      // show its storm emoji either — fall back to a cloud-cover sky.
      const codeClaimsRain =
        d.weatherCode != null &&
        ((d.weatherCode >= 51 && d.weatherCode <= 67) ||
          (d.weatherCode >= 80 && d.weatherCode <= 99));
      const emoji =
        !raining && codeClaimsRain
          ? (h.cloudCoverPct ?? 0) <= 30
            ? "☀️"
            : (h.cloudCoverPct ?? 0) <= 70
              ? "⛅"
              : "☁️"
          : (h.emoji ?? "");
      return {
        time: h.time,
        result: r,
        emoji,
        raining,
        windSpeedMph: h.windSpeedMph,
        windDirDeg: h.windDirDeg,
      };
    });
}

/** Compact-scores projection of `scoreAllHoursFull`, for callers (the hourly
 *  chart) that only need the curve, not the per-hour breakdown. */
function scoreAllHours(
  s: ConditionsSnapshot,
  nowMs: number = Date.now(),
  opts: ScoringOptions = DEFAULT_SCORING,
): HourlyScore[] {
  return scoreAllHoursFull(s, nowMs, opts).map(toHourlyScore);
}

/**
 * Today's Beach Day score across daylight hours, for the hourly chart. Scores
 * every fetched hour, then keeps only TODAY's daylight (the bucket containing
 * sunrise through the last hour at/before sunset). With no sun data, keeps all.
 */
export function computeHourlyScores(
  s: ConditionsSnapshot,
  nowMs: number = Date.now(),
  opts: ScoringOptions = DEFAULT_SCORING,
): HourlyScore[] {
  const scored = scoreAllHours(s, nowMs, opts);
  const sun = s.sun.data;
  const sunrise = sun?.sunrise ? new Date(sun.sunrise).getTime() : null;
  const sunset = sun?.sunset ? new Date(sun.sunset).getTime() : null;
  if (sunrise == null || sunset == null) {
    // No daylight bounds to filter by. But the hourly fetch now spans TWO prior
    // days (past_days=2, added for the man-o'-war trailing-wind lookback), so
    // returning `scored` as-is would leak yesterday's + the day-before's scored
    // buckets into the no-sun response (it used to carry only today +/- 1). Those
    // prior buckets are raw inputs for the sand-rain lookback (hours[i-1]/[i-2],
    // computed over the full array above) — NOT hours to score forward — so drop
    // beach-local dates before today. Today's buckets are unchanged: they were
    // scored with the full raw array intact; only the OUTPUT is trimmed. (The
    // sun-available path below already drops prior days: they fall before today's
    // sunrise.)
    const dateFmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: s.location.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const todayKey = dateFmt.format(new Date(nowMs));
    return scored.filter((h) => dateFmt.format(new Date(h.time)) >= todayKey);
  }
  return scored.filter((h) => {
    const t = new Date(h.time).getTime();
    // Include the hour bucket that contains sunrise, through the last hour <= sunset.
    return t + HOUR_MS > sunrise && t <= sunset;
  });
}

/**
 * Snap the chart's CURRENT hour to the headline score. The headline
 * (`computeScore`) is a multi-source consensus — NWS station obs + MET Norway +
 * Open-Meteo + GFS — while the hourly curve is Open-Meteo's forecast alone, so the
 * two routinely disagree by several points at the same moment. Anchoring the
 * bucket that contains `now` to the headline makes the graph's "now" point match
 * the big number the app displays; every other hour stays the forecast shape.
 * Returns the array unchanged when no bucket contains `now` (e.g. before sunrise).
 */
export function anchorCurrentHourScore(
  hourly: HourlyScore[],
  headline: { score: number; rating: string },
  nowMs: number = Date.now(),
  /** Accepted for a uniform call shape across the engine. Anchoring copies the
   *  headline the caller already computed, so the options never change it. */
  _opts: ScoringOptions = DEFAULT_SCORING,
): HourlyScore[] {
  const i = hourly.findIndex((h) => {
    const t = new Date(h.time).getTime();
    return t <= nowMs && nowMs < t + HOUR_MS;
  });
  if (i < 0) return hourly;
  const next = hourly.slice();
  next[i] = { ...next[i], score: headline.score, rating: headline.rating };
  return next;
}

/** Local hour (0-23) of an instant in a given IANA timezone. */
function localHourInTz(iso: string, tz: string): number {
  return (
    Number(
      new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(
        new Date(iso),
      ),
    ) % 24
  );
}

/**
 * Best beach-time window + peak score per upcoming day (today first), powering
 * the multi-day "best beach times" forecast. Scores the whole multi-day hourly
 * window, groups by the beach's LOCAL date, keeps daylight hours (today's
 * sunrise/sunset local-hour bounds, which drift only minutes across a week),
 * and finds each day's best contiguous window. For today the window only spans
 * time still ahead; future days use the whole daylight span.
 *
 * The weather that varies hour-to-hour (sun, wind, rain, UV, heat) is the real
 * per-day forecast; slowly-changing inputs (water temp, surf, advisories) are
 * carried from the current snapshot — so treat future days as an estimate.
 */
export function computeMultiDayWindows(
  s: ConditionsSnapshot,
  nowMs: number = Date.now(),
  maxDays = 7,
  opts: ScoringOptions = DEFAULT_SCORING,
): DayWindow[] {
  const scoredFull = scoreAllHoursFull(s, nowMs, opts);
  if (!scoredFull.length) return [];
  const scored = scoredFull.map(toHourlyScore);
  // Full breakdown per hour, keyed by time, so the day's peak hour can carry its
  // sub-scores/caps into `peakBreakdown` alongside the compact score curve above.
  const fullByTime = new Map<string, FullHourlyScore>(scoredFull.map((h) => [h.time, h]));
  const tz = s.location.timezone;

  // Daylight bounds as LOCAL hours from today's sun (reused for every day).
  const sun = s.sun.data;
  const sunriseH = sun?.sunrise ? localHourInTz(sun.sunrise, tz) : 7;
  const sunsetH = sun?.sunset ? localHourInTz(sun.sunset, tz) : 19;

  const dateFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }); // → YYYY-MM-DD
  const dowFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" });
  const todayKey = dateFmt.format(new Date(nowMs));

  // Group scored hours by local date, daylight only, today and forward.
  const groups = new Map<string, HourlyScore[]>();
  for (const h of scored) {
    const when = new Date(h.time);
    const key = dateFmt.format(when);
    if (key < todayKey) continue; // drop prior days (from past_days=2)
    const lh = localHourInTz(h.time, tz);
    // Daylight only. The sunset hour is EXCLUSIVE: a window's end is the top of
    // its last hour, so including the sunset-hour bucket would push the window
    // end to sunsetH+1 — past actual sunset, into the dark. Dropping it keeps
    // the window end at/before sunset.
    if (lh < sunriseH || lh >= sunsetH) continue;
    const arr = groups.get(key);
    if (arr) arr.push(h);
    else groups.set(key, [h]);
  }

  const out: DayWindow[] = [];
  for (const key of [...groups.keys()].sort().slice(0, maxDays)) {
    const dayHours = groups.get(key)!;
    const isToday = key === todayKey;
    const best = bestBeachWindow(dayHours, isToday ? nowMs : undefined);
    // Headline score = the peak of the window we actually show, so the chip never
    // claims a higher score than any hour in the displayed window. Only fall back
    // to the day's max when there's no window (e.g. today already past sunset).
    const peak = best ? best.score : Math.round(Math.max(...dayHours.map((h) => h.score)));
    // Representative emoji: the daylight hour nearest local 13:00.
    let mid = dayHours[0];
    let midDist = Math.abs(localHourInTz(mid.time, tz) - 13);
    for (const h of dayHours) {
      const dist = Math.abs(localHourInTz(h.time, tz) - 13);
      if (dist < midDist) {
        mid = h;
        midDist = dist;
      }
    }
    // The day's "peak hour" for the breakdown panel: the highest-scoring hour
    // within the displayed best window (so the breakdown matches what's shown),
    // or across the whole day when there's no window. First hour wins ties, to
    // match the Math.max()/bestPeak conventions above.
    const rangeStartMs = best ? new Date(best.startIso).getTime() : -Infinity;
    const rangeEndMs = best ? new Date(best.endIso).getTime() : Infinity;
    let peakHour: HourlyScore | undefined;
    for (const h of dayHours) {
      const t = new Date(h.time).getTime();
      if (t < rangeStartMs || t >= rangeEndMs) continue;
      if (!peakHour || h.score > peakHour.score) peakHour = h;
    }
    const peakFull = peakHour ? fullByTime.get(peakHour.time) : undefined;
    out.push({
      date: key,
      dow: isToday ? "Today" : dowFmt.format(new Date(dayHours[0].time)),
      best,
      peakScore: peak,
      emoji: mid.emoji,
      peakBreakdown: peakFull
        ? {
            time: peakFull.time,
            score: peakFull.result.score,
            rating: peakFull.result.rating,
            subScores: peakFull.result.subScores,
            caps: peakFull.result.caps,
          }
        : undefined,
    });
  }
  return out;
}
