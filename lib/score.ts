import type {
  BestWindow,
  DayWindow,
  HourlyMetrics,
  ConditionsSnapshot,
  FlagColor,
  HourlyScore,
  RipRisk,
  SargassumRisk,
  ScoreResult,
  SubScore,
  WaterQualityRating,
} from "@/lib/types";
import { clamp, degToCardinal, dewPointFromTempRH, plateau, round } from "@/lib/util";
import { currentSandTempF, estimateSandTempF, hoursFromSolarNoon } from "@/lib/sandTemp";
import { seaState } from "@/lib/format";

// Consolidated, best-available values pulled across all sources.
export interface Derived {
  airTempF?: number;
  waterTempF?: number;
  windSpeedMph?: number;
  windDirDeg?: number;
  waveHeightFt?: number; // combined sea state (for swimming calmness)
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
  /** Estimated dry-sand surface temp (°F) — barefoot comfort (lib/sandTemp). */
  sandTempF?: number;
  flags: FlagColor[];
  waterAdvisory: boolean;
  waterRating: WaterQualityRating;
  /** City-issued no-swim/beach advisory is active (myboca AlertCenter). */
  noSwimAdvisory: boolean;
  /** NWS Surf Zone Forecast rip-current risk. */
  ripCurrentRisk: RipRisk;
  /** A severe NWS warning (hurricane/tropical storm/tsunami/high surf) is active. */
  severeAlert: boolean;
  /** A surf/coastal-flood ADVISORY (sub-warning tier) is active — soft swim cap. */
  surfAdvisory?: boolean;
  /** Live nowcast says it's precipitating RIGHT NOW (observed, beats the forecast). */
  nowcastRaining?: boolean;
  /** A fresh GOES GLM strike landed within 5 mi (now-only) — trips the get-out cap. */
  lightningWithin5mi?: boolean;
  /** Minutes since the most recent strike in the scanned area (now-only). */
  lightningLastMinutesAgo?: number;
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
 */
export function consensusCloudPct(s: ConditionsSnapshot): number | undefined {
  const om = currentHourOf(s.hourly.data ?? []);
  return median(
    s.marine.data?.cloudCoverPct,
    s.metno.data?.cloudCoverPct,
    om?.cloudCoverPct,
    s.weather.data?.cloudCoverPct,
    s.gfs.data?.cloudCoverPct,
  );
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

export function deriveMetrics(s: ConditionsSnapshot): Derived {
  const w = s.weather.data;
  const b = s.buoy.data;
  const m = s.marine.data;
  const c = s.cityOfficial.data;
  const q = s.waterQuality.data;
  const n = s.nws.data;
  const mn = s.metno.data;
  const g = s.gfs.data;
  // Open-Meteo's reading for the current hour — the third consensus voice.
  const om = currentHourOf(s.hourly.data ?? []);
  const cloudCoverPct = consensusCloudPct(s);
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
  const freshStrikesNear =
    s.lightning.status === "ok" &&
    (s.lightning.data?.lastMinutesAgo ?? Infinity) <= 30 &&
    (s.lightning.data?.nearestMi ?? Infinity) <= 5;
  const nowcastCorroborated =
    rainishCode ||
    freshStrikesNear ||
    (cloudCoverPct ?? 100) >= 50 ||
    (precipProbability ?? 100) >= 25 ||
    (om?.precipIn ?? 0) > 0;
  return {
    // Shared metrics are the MEDIAN of NWS (real station obs), MET Norway, and
    // Open-Meteo, so no single provider or model can skew the dashboard.
    airTempF,
    waterTempF: b?.waterTempF ?? m?.seaSurfaceTempF,
    windSpeedMph:
      median(w?.windSpeedMph, mn?.windSpeedMph, om?.windSpeedMph, g?.windSpeedMph) ?? b?.windSpeedMph,
    windDirDeg: w?.windDirDeg ?? mn?.windDirDeg ?? b?.windDirDeg,
    waveHeightFt: b?.waveHeightFt ?? m?.waveHeightFt,
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
          Date.now(),
          {
            cloudCoverPct: satelliteBeamCloudPct(s) ?? satelliteCloudPct(s) ?? cloudCoverPct,
            // Beam-path readings damp from 50% (sustained blockage), not 70%.
            cloudIsBeamPath: satelliteBeamCloudPct(s) != null,
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
    severeAlert:
      // Match by event name OR by NWS severity tier (Severe/Extreme).
      (n?.alerts ?? []).some((a) => SEVERE_ALERT.test(a.event)) ||
      (n?.alerts ?? []).some((a) => /^(Severe|Extreme)$/i.test(a.severity)),
    surfAdvisory: (n?.alerts ?? []).some((a) =>
      /beach hazards|high surf advisory|coastal flood advisory/i.test(a.event),
    ),
    // Observed "now" signals — they override the forecast-based rain logic.
    // (Corroboration-gated: see nowcastCorroborated above — a phantom model
    // shower under a clear sky must not cap the day.)
    nowcastRaining: nowcastSaysRain && nowcastCorroborated,
    // Lightning trips the get-out cap only when the feed is OK, the activity is
    // fresh (most recent strike <=30 min ago), AND the closest strike landed
    // within 5 mi. A stale/errored scan, or strikes that are all farther than
    // 5 mi away, must not bottom the score.
    lightningWithin5mi:
      s.lightning.status === "ok" &&
      (s.lightning.data?.lastMinutesAgo == null || s.lightning.data.lastMinutesAgo <= 30) &&
      (s.lightning.data?.nearestMi ?? Infinity) <= 5,
    lightningLastMinutesAgo: s.lightning.data?.lastMinutesAgo,
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
// stagnant/buggy/hot; 5-13 mph is ideal; above ~13 mph turns choppy and starts
// blowing sand. Plateau across [5, 13], tapering to 0 over 12 mph on each side
// (so dead calm ≈ 58, a 25 mph gale ≈ 0).
const windScore = (mph: number) => plateau(mph, 5, 13, 12);
const waveCalm = (ft: number) => clamp(100 - Math.max(0, ft - 1) * 25, 0, 100);
const uvScore = (uv: number) => clamp(100 - Math.max(0, uv - 8) * 12, 0, 100);

function waterQualityScore(r: WaterQualityRating): number | null {
  switch (r) {
    case "good":
      return 100;
    case "moderate":
      return 60;
    case "poor":
      return 0;
    default:
      return null; // unknown -> excluded from the average
  }
}

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
  if (d.shortForecast) parts.push(d.shortForecast);
  if (d.cloudCoverPct != null) parts.push(`${d.cloudCoverPct}% cloud`);
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
  if (score >= 80) return "Excellent";
  if (score >= 65) return "Good";
  if (score >= 45) return "Fair";
  return "Poor";
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
 * signal (sweat can't evaporate as the dew point climbs). <=60°F feels great;
 * each °F above subtracts ~5 (≈68°F→60, 72°F→40, ≥80°F→0). Very high relative
 * humidity (>85%) adds a small extra penalty. Null when no dew point is known.
 */
function comfortScore(d: Derived): number | null {
  if (d.dewPointF == null) return null;
  let s = clamp(100 - Math.max(0, d.dewPointF - 60) * 5, 0, 100);
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

export function scoreBeachDay(d: Derived): ScoreResult {
  const subs: SubScore[] = [
    sub(
      "airTemp",
      "Air temperature",
      d.airTempF != null ? plateau(d.airTempF, 78, 88, 18) : null,
      0.16,
      f1(d.airTempF, "°F"),
    ),
    sub("sky", "Sky (sun & rain)", skyScore(d), 0.16, skyDisplay(d)),
    sub(
      "wind",
      "Wind (sea breeze)",
      d.windSpeedMph != null ? windScore(d.windSpeedMph) : null,
      0.13,
      d.windSpeedMph != null
        ? `${d.windSpeedMph} mph${d.windDirDeg != null ? " " + degToCardinal(d.windDirDeg) : ""}`
        : undefined,
    ),
    sub("comfort", "Comfort (mugginess)", comfortScore(d), 0.08, comfortDisplay(d)),
    sub(
      "waterTemp",
      "Water temperature",
      d.waterTempF != null ? plateau(d.waterTempF, 77, 84, 15) : null,
      0.09,
      f1(d.waterTempF, "°F"),
    ),
    sub(
      "waves",
      "Sea state (swim calmness)",
      d.waveHeightFt != null ? waveCalm(d.waveHeightFt) : null,
      0.08,
      d.waveHeightFt != null
        ? `${f1(d.waveHeightFt, " ft")} · ${seaState(d.waveHeightFt).label.toLowerCase()}`
        : undefined,
    ),
    sub(
      "waterQuality",
      "Water quality",
      waterQualityScore(d.waterRating),
      0.06,
      d.waterRating,
    ),
    sub(
      "sargassum",
      "Seaweed (sargassum)",
      sargassumScore(d.sargassumLevel, d.sargassumCoveragePct),
      0.07,
      sargassumDisplay(d),
    ),
    sub(
      "crowds",
      "Crowds",
      crowdScore(d.crowdPct),
      0.05,
      d.crowdPct != null ? `~${d.crowdPct}% full` : undefined,
    ),
    sub(
      "uv",
      "UV index",
      d.uvIndex != null ? uvScore(d.uvIndex) : null,
      0.04,
      d.uvIndex != null ? `${d.uvIndex}` : undefined,
    ),
    sub(
      "sandTemp",
      "Sand temperature (barefoot)",
      sandScore(d.sandTempF),
      0.08,
      d.sandTempF != null ? `~${d.sandTempF}°F est.` : undefined,
    ),
  ];

  const rawScore = combine(subs);
  // Total data outage: no weather sub-score was available. Surface it explicitly
  // (score 0, "Unavailable", dataAvailable: false). We STILL run the safety caps
  // so a hazard we genuinely observe — e.g. lightning within 5 mi from the GLM
  // feed, which is independent of the weather pipeline — still registers as a cap
  // reason even when every forecast feed is down. (Math.min keeps the score at 0.)
  if (rawScore == null) {
    const { caps } = applyBeachCaps(0, d);
    return {
      score: 0,
      rawScore: 0,
      rating: "Unavailable",
      subScores: subs,
      caps,
      dataAvailable: false,
    };
  }
  const { score, caps } = applyBeachCaps(rawScore, d);
  return { score, rawScore, rating: ratingFor(score), subScores: subs, caps, dataAvailable: true };
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

function applyBeachCaps(
  raw: number,
  d: Derived,
): { score: number; caps: string[] } {
  let score = raw;
  const caps: string[] = [];
  // Lifeguard flags are safety signals. We distinguish a true closure from a
  // swim-hazard warning:
  //  - DOUBLE-RED means the water is closed — there's no beach day to be had, so
  //    it bottoms the score out.
  //  - A single RED flag means rough/hazardous surf where swimming is
  //    discouraged. That's a swimmer-safety issue, not a beach-day-killer: you
  //    can still have a great day on the sand, so it only caps at 85 (and stays
  //    surfaced in the safety banner regardless).
  // The purple (dangerous marine life) flag is intentionally NOT a score cap —
  // it's a near-constant in South Florida, so it carries no day-to-day signal.
  if (d.flags.includes("double-red")) {
    score = Math.min(score, 5);
    caps.push("Double red flag — water access closed");
  } else if (d.flags.includes("red")) {
    score = Math.min(score, 85);
    caps.push("Red flag — high hazard, swimming discouraged");
  }
  if (d.waterAdvisory) {
    score = Math.min(score, 40);
    caps.push("Water quality advisory in effect");
  }
  // A City-issued no-swim advisory is a direct swim-safety override.
  if (d.noSwimAdvisory) {
    score = Math.min(score, 40);
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
    }
  }
  // NWS rip-current risk: HIGH means life-threatening rip currents are likely.
  // Like a red flag, this is a swimmer-safety hazard rather than a beach-day
  // killer — you can still enjoy the sand — so it caps at 85, not lower.
  if (d.ripCurrentRisk === "high") {
    score = Math.min(score, 85);
    caps.push("High rip current risk (NWS)");
  } else if (d.ripCurrentRisk === "moderate") {
    score = Math.min(score, 92);
    caps.push("Moderate rip current risk (NWS)");
  }
  // A surf/coastal-flood ADVISORY (sub-warning tier) discourages swimming — a
  // soft cap; the hard SEVERE_ALERT cap above already covers the *warning* tier.
  if (d.surfAdvisory) {
    score = Math.min(score, 85);
    caps.push("High surf or coastal-flood advisory — swimming discouraged");
  }
  // A severe NWS warning (hurricane/tropical storm/tsunami/high surf) closes the day.
  if (d.severeAlert) {
    score = Math.min(score, 15);
    caps.push("Severe weather warning in effect");
  }
  // OBSERVED lightning (GOES GLM) within 5 mi in the recent scan window is a
  // get-out-of-the-water emergency — the single most dangerous beach condition.
  // This is observed data, so it bottoms the score regardless of the forecast.
  if (d.lightningWithin5mi) {
    score = Math.min(score, 10);
    caps.push("Lightning within 5 miles — get out of the water");
  }
  // Rain is a hard ceiling on the whole day. We trust OBSERVATION over forecast:
  // the live nowcast ("it's raining right now") overrides the forecast-code path,
  // which can miss a real storm when the model's precip probability is low (the
  // corroboration rule in rainSeverity would otherwise veto it).
  const rain = rainSeverity(d);
  if (rain === "thunder") {
    score = Math.min(score, 15);
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
      caps.push("Thunderstorm — raining now");
    } else {
      score = Math.min(score, 25);
      caps.push("Raining right now");
    }
  } else if (rain === "rain") {
    score = Math.min(score, 25);
    caps.push("Rain in the forecast");
  }
  return { score, caps };
}

export function computeScore(s: ConditionsSnapshot): ScoreResult {
  return scoreBeachDay(deriveMetrics(s));
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
): FullHourlyScore[] {
  const hours = s.hourly.data;
  if (!hours?.length) return [];

  // Day-constant inputs (water temp/quality/flags/waves/seaweed) reuse the snapshot.
  const base = deriveMetrics(s);

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
  // (see `isToday` below) — never to yesterday's hours (from past_days=1) or to
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
      const d: Derived = {
        airTempF: h.airTempF,
        waterTempF: base.waterTempF,
        windSpeedMph: h.windSpeedMph,
        windDirDeg: h.windDirDeg,
        waveHeightFt: base.waveHeightFt,
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
        severeAlert: isToday ? base.severeAlert : false,
        surfAdvisory: isToday ? base.surfAdvisory : false,
        ...(isCurrentHour
          ? {
              nowcastRaining: base.nowcastRaining,
              lightningWithin5mi: base.lightningWithin5mi,
              lightningLastMinutesAgo: base.lightningLastMinutesAgo,
            }
          : {}),
      };
      const r = scoreBeachDay(d);
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
function scoreAllHours(s: ConditionsSnapshot, nowMs: number = Date.now()): HourlyScore[] {
  return scoreAllHoursFull(s, nowMs).map(toHourlyScore);
}

/**
 * Today's Beach Day score across daylight hours, for the hourly chart. Scores
 * every fetched hour, then keeps only TODAY's daylight (the bucket containing
 * sunrise through the last hour at/before sunset). With no sun data, keeps all.
 */
export function computeHourlyScores(
  s: ConditionsSnapshot,
  nowMs: number = Date.now(),
): HourlyScore[] {
  const scored = scoreAllHours(s, nowMs);
  const sun = s.sun.data;
  const sunrise = sun?.sunrise ? new Date(sun.sunrise).getTime() : null;
  const sunset = sun?.sunset ? new Date(sun.sunset).getTime() : null;
  if (sunrise == null || sunset == null) return scored;
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
): DayWindow[] {
  const scoredFull = scoreAllHoursFull(s, nowMs);
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
    if (key < todayKey) continue; // drop yesterday (from past_days=1)
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
