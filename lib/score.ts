import type {
  ConditionsSnapshot,
  FlagColor,
  HourlyScore,
  ScoreResult,
  SubScore,
  WaterQualityRating,
} from "@/lib/types";
import { clamp, degToCardinal, plateau } from "@/lib/util";

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
  weatherCode?: number; // WMO code (hourly path); drives the rain cap
  flags: FlagColor[];
  waterAdvisory: boolean;
  waterRating: WaterQualityRating;
  /** City-issued no-swim/beach advisory is active (myboca AlertCenter). */
  noSwimAdvisory: boolean;
}

export function deriveMetrics(s: ConditionsSnapshot): Derived {
  const w = s.weather.data;
  const b = s.buoy.data;
  const m = s.marine.data;
  const c = s.cityOfficial.data;
  const q = s.waterQuality.data;
  return {
    airTempF: w?.airTempF ?? b?.airTempF,
    waterTempF: b?.waterTempF ?? m?.seaSurfaceTempF,
    windSpeedMph: w?.windSpeedMph ?? b?.windSpeedMph,
    windDirDeg: w?.windDirDeg ?? b?.windDirDeg,
    waveHeightFt: b?.waveHeightFt ?? m?.waveHeightFt,
    precipProbability: w?.precipProbability,
    shortForecast: w?.shortForecast,
    uvIndex: m?.uvIndex,
    cloudCoverPct: m?.cloudCoverPct,
    flags: c?.flags ?? ["unknown"],
    waterAdvisory: q?.advisory ?? false,
    waterRating: q?.overall ?? "unknown",
    noSwimAdvisory: !!c?.noSwimAdvisory,
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

export function scoreBeachDay(d: Derived): ScoreResult {
  const subs: SubScore[] = [
    sub(
      "airTemp",
      "Air temperature",
      d.airTempF != null ? plateau(d.airTempF, 78, 88, 18) : null,
      0.22,
      f1(d.airTempF, "°F"),
    ),
    sub("sky", "Sky (sun & rain)", skyScore(d), 0.22, skyDisplay(d)),
    sub(
      "wind",
      "Wind (sea breeze)",
      d.windSpeedMph != null ? windScore(d.windSpeedMph) : null,
      0.18,
      d.windSpeedMph != null
        ? `${d.windSpeedMph} mph${d.windDirDeg != null ? " " + degToCardinal(d.windDirDeg) : ""}`
        : undefined,
    ),
    sub(
      "waterTemp",
      "Water temperature",
      d.waterTempF != null ? plateau(d.waterTempF, 77, 84, 15) : null,
      0.15,
      f1(d.waterTempF, "°F"),
    ),
    sub(
      "waves",
      "Sea state (swim calmness)",
      d.waveHeightFt != null ? waveCalm(d.waveHeightFt) : null,
      0.1,
      f1(d.waveHeightFt, " ft"),
    ),
    sub(
      "waterQuality",
      "Water quality",
      waterQualityScore(d.waterRating),
      0.08,
      d.waterRating,
    ),
    sub(
      "uv",
      "UV index",
      d.uvIndex != null ? uvScore(d.uvIndex) : null,
      0.05,
      d.uvIndex != null ? `${d.uvIndex}` : undefined,
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
    if (c >= 95 && c <= 99) return "thunder";
    if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82)) return "rain";
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
  // Lifeguard flags are authoritative safety overrides. Note: the purple
  // (dangerous marine life) flag is intentionally NOT a score cap — it's a
  // near-constant in South Florida, so it carries no day-to-day signal. It is
  // still surfaced in the safety banner for awareness.
  if (d.flags.includes("double-red")) {
    score = Math.min(score, 5);
    caps.push("Double red flag — water access closed");
  } else if (d.flags.includes("red")) {
    score = Math.min(score, 40);
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
 */
export function computeHourlyScores(s: ConditionsSnapshot): HourlyScore[] {
  const hours = s.hourly.data;
  if (!hours?.length) return [];

  // Day-constant inputs (water temp/quality/flags/waves) reuse the snapshot.
  const base = deriveMetrics(s);
  const sun = s.sun.data;
  const sunrise = sun?.sunrise ? new Date(sun.sunrise).getTime() : null;
  const sunset = sun?.sunset ? new Date(sun.sunset).getTime() : null;

  return hours
    .filter((h) => {
      if (sunrise == null || sunset == null) return true; // no bounds -> keep all
      const t = new Date(h.time).getTime();
      // Include the hour bucket that contains sunrise, through the last hour <= sunset.
      return t + HOUR_MS > sunrise && t <= sunset;
    })
    .map((h) => {
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
        weatherCode: h.weatherCode,
        flags: base.flags,
        waterAdvisory: base.waterAdvisory,
        waterRating: base.waterRating,
        noSwimAdvisory: base.noSwimAdvisory,
      };
      const r = scoreBeachDay(d);
      return {
        time: h.time,
        score: r.score,
        rating: r.rating,
        emoji: h.emoji ?? "",
        raining: rainSeverity(d) !== "none",
        windSpeedMph: h.windSpeedMph,
        windDirDeg: h.windDirDeg,
      };
    });
}
