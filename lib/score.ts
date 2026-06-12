import type {
  BestWindow,
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
import { currentSandTempF, estimateSandTempF } from "@/lib/sandTemp";
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
}

/** Events that make the beach genuinely dangerous/closed — hard score cap. */
const SEVERE_ALERT =
  /hurricane warning|tropical storm warning|storm surge warning|tsunami|high surf warning/i;

/** The hourly-forecast entry whose bucket contains "now" (within 2h), if any. */
function currentHourOf(hours: HourlyMetrics[], nowMs: number = Date.now()) {
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
  return xs.length % 2 ? xs[mid] : round((xs[mid - 1] + xs[mid]) / 2, 1);
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
  // Dew point drives the comfort score; fall back to computing it from temp + RH.
  const dpFallback =
    w?.airTempF != null && w?.humidityPct != null
      ? dewPointFromTempRH(w.airTempF, w.humidityPct)
      : undefined;
  return {
    // Shared metrics are the MEDIAN of NWS (real station obs), MET Norway, and
    // Open-Meteo, so no single provider or model can skew the dashboard.
    airTempF: median(w?.airTempF, mn?.airTempF, om?.airTempF, g?.airTempF) ?? b?.airTempF,
    waterTempF: b?.waterTempF ?? m?.seaSurfaceTempF,
    windSpeedMph:
      median(w?.windSpeedMph, mn?.windSpeedMph, om?.windSpeedMph, g?.windSpeedMph) ?? b?.windSpeedMph,
    windDirDeg: w?.windDirDeg ?? mn?.windDirDeg ?? b?.windDirDeg,
    waveHeightFt: b?.waveHeightFt ?? m?.waveHeightFt,
    precipProbability: w?.precipProbability ?? om?.precipProbability,
    shortForecast: w?.shortForecast,
    uvIndex: m?.uvIndex,
    cloudCoverPct: median(m?.cloudCoverPct, mn?.cloudCoverPct, om?.cloudCoverPct, w?.cloudCoverPct, g?.cloudCoverPct),
    sargassumLevel: s.sargassum.data?.level,
    sargassumCoveragePct: s.sargassum.data?.coveragePct,
    crowdPct: s.busyness.data?.crowdPct ?? crowdLevelPct(s.busyness.data?.level),
    sandTempF: s.hourly.data ? currentSandTempF(s.hourly.data) : undefined,
    humidityPct: median(w?.humidityPct, mn?.humidityPct, om?.humidityPct, g?.humidityPct),
    dewPointF:
      median(w?.dewPointF, mn?.dewPointF, om?.dewPointF, g?.dewPointF) ??
      (dpFallback != null ? round(dpFallback) : undefined),
    flags: c?.flags ?? ["unknown"],
    waterAdvisory: q?.advisory ?? false,
    waterRating: q?.overall ?? "unknown",
    noSwimAdvisory: !!c?.noSwimAdvisory,
    ripCurrentRisk: n?.ripCurrentRisk ?? "unknown",
    severeAlert: (n?.alerts ?? []).some((a) => SEVERE_ALERT.test(a.event)),
  };
}

/**
 * The longest contiguous run of today's scored daylight hours that stays within
 * 8 points of the day's peak — i.e. "the best stretch to go". `endIso` is the
 * end of the last hour in the run. Null when there are no hours.
 */
export function bestBeachWindow(hours: HourlyScore[]): BestWindow | null {
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
function combine(subs: SubScore[]): number {
  const avail = subs.filter((s) => s.score != null);
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
  const { score, caps } = applyBeachCaps(rawScore, d);
  return { score, rawScore, rating: ratingFor(score), subScores: subs, caps };
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
  if (d.sargassumLevel === "high") {
    score = Math.min(score, 65);
    caps.push("Heavy seaweed (sargassum) on the beach");
  } else if (d.sargassumLevel === "moderate") {
    score = Math.min(score, 85);
    caps.push("Moderate seaweed (sargassum) on the beach");
  }
  // NWS rip-current risk: HIGH means life-threatening rip currents are likely.
  // Like a red flag, this is a swimmer-safety hazard rather than a beach-day
  // killer — you can still enjoy the sand — so it caps at 85, not lower.
  if (d.ripCurrentRisk === "high") {
    score = Math.min(score, 85);
    caps.push("High rip current risk (NWS)");
  }
  // A severe NWS warning (hurricane/tropical storm/tsunami/high surf) closes the day.
  if (d.severeAlert) {
    score = Math.min(score, 15);
    caps.push("Severe weather warning in effect");
  }
  // Rain is a hard ceiling on the whole day (not just the sky sub-score): an
  // actively rainy/stormy hour is an unacceptable beach day regardless of how
  // warm/calm it is otherwise.
  const rain = rainSeverity(d);
  if (rain === "thunder") {
    score = Math.min(score, 15);
    caps.push("Thunderstorm in the forecast");
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
export function computeHourlyScores(
  s: ConditionsSnapshot,
  nowMs: number = Date.now(),
): HourlyScore[] {
  const hours = s.hourly.data;
  if (!hours?.length) return [];

  // Day-constant inputs (water temp/quality/flags/waves/seaweed) reuse the snapshot.
  const base = deriveMetrics(s);
  const sun = s.sun.data;
  const sunrise = sun?.sunrise ? new Date(sun.sunrise).getTime() : null;
  const sunset = sun?.sunset ? new Date(sun.sunset).getTime() : null;

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
  const reads = s.sargassum.data?.todayReads ?? [];
  const seaweedAtHour = (localHour: number) => {
    const prior = reads.filter((r) => r.hour <= localHour);
    return prior.length ? prior[prior.length - 1] : reads[0];
  };

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
      }),
    );
  });

  return hours
    .filter((h) => {
      if (sunrise == null || sunset == null) return true; // no bounds -> keep all
      const t = new Date(h.time).getTime();
      // Include the hour bucket that contains sunrise, through the last hour <= sunset.
      return t + HOUR_MS > sunrise && t <= sunset;
    })
    .map((h) => {
      // Past hours keep the read that was current then; now/future use latest.
      const isPast = new Date(h.time).getTime() + HOUR_MS <= nowMs;
      const histRead = isPast ? seaweedAtHour(localHourOf(h.time)) : undefined;
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
        sargassumLevel: histRead?.level ?? base.sargassumLevel,
        sargassumCoveragePct: histRead ? histRead.coveragePct : base.sargassumCoveragePct,
        crowdPct: crowdByHour.get(localHourOf(h.time)),
        sandTempF: sandByTime.get(h.time),
        flags: base.flags,
        waterAdvisory: base.waterAdvisory,
        waterRating: base.waterRating,
        noSwimAdvisory: base.noSwimAdvisory,
        ripCurrentRisk: base.ripCurrentRisk,
        severeAlert: base.severeAlert,
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
        score: r.score,
        rating: r.rating,
        emoji,
        raining,
        windSpeedMph: h.windSpeedMph,
        windDirDeg: h.windDirDeg,
      };
    });
}
