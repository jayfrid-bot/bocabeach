import type {
  ConditionsSnapshot,
  FlagColor,
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
  flags: FlagColor[];
  waterAdvisory: boolean;
  waterRating: WaterQualityRating;
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
    flags: c?.flags ?? ["unknown"],
    waterAdvisory: q?.advisory ?? false,
    waterRating: q?.overall ?? "unknown",
  };
}

// --- individual curves -----------------------------------------------------
const windCalm = (mph: number) => clamp(100 - Math.max(0, mph - 6) * 6, 0, 100);
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

function skyScore(d: Derived): number | null {
  const f = d.shortForecast?.toLowerCase() ?? "";
  let s: number | null =
    typeof d.precipProbability === "number" ? 100 - d.precipProbability : null;
  if (f) {
    let base = s ?? 75;
    if (/thunder|storm/.test(f)) base = Math.min(base, 45);
    else if (/rain|shower/.test(f)) base = Math.min(base, 60);
    else if (/cloud|overcast/.test(f)) base = Math.min(base, 80);
    else if (/sun|clear|fair/.test(f)) base = Math.max(base, 85);
    s = base;
  }
  return s;
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
    sub("sky", "Sky / precipitation", skyScore(d), 0.22, d.shortForecast),
    sub(
      "wind",
      "Wind (calmness)",
      d.windSpeedMph != null ? windCalm(d.windSpeedMph) : null,
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
  return { score, caps };
}

export function computeScore(s: ConditionsSnapshot): ScoreResult {
  return scoreBeachDay(deriveMetrics(s));
}
