// Shared fixtures for the alerts-engine tests. Just enough of a conditions
// response for the rules to read — never a network call, never a real snapshot.
// Test-only: nothing in the app imports this.

import { computeScore } from "@/lib/score";
import type {
  AirQualityData,
  BuoyData,
  BusynessData,
  CityOfficialData,
  ClarityData,
  ConditionsResponse,
  ConditionsSnapshot,
  ForecastDay,
  GoesCloudData,
  HourlyMetrics,
  LightningData,
  MarineData,
  MetnoCurrent,
  NowcastData,
  NwsData,
  PrecipRadarData,
  SargassumData,
  SunData,
  TideData,
  TrafficData,
  WaterQualityData,
  WeatherData,
  Wrapped,
} from "@/lib/types";

export interface ConditionsOver {
  score?: number;
  rating?: string;
  subScores?: unknown[];
  alerts?: { event: string; severity?: string }[];
  rip?: "low" | "moderate" | "high" | "unknown";
  flags?: string[];
  noSwim?: { title: string; url: string };
  waterAdvisory?: boolean;
  lightning?: { nearestMi?: number; nearestMinutesAgo?: number; lastMinutesAgo?: number } | null;
  gustMph?: number;
  hourly?: { time: string; weatherCode?: number; precipProbability?: number }[];
  shortForecast?: string;
  sunrise?: string;
  sunset?: string;
  radar?: {
    rainNowMmHr?: number | null;
    etaMinutes?: number | null;
    frameAgeMinutes?: number;
    frameIso?: string;
  } | null;
  radarStatus?: "ok" | "stale" | "error";
}

/** A conditions response carrying only what the alert rules look at. */
export function conditionsFixture(over: ConditionsOver = {}): ConditionsResponse {
  return {
    score: {
      score: over.score ?? 80,
      rawScore: over.score ?? 80,
      rating: over.rating ?? "Good",
      caps: [],
      subScores: over.subScores ?? [],
    },
    hourlyScores: [],
    hourlyForecast: [],
    multiDayWindows: [],
    cams: [],
    snapshot: {
      location: { slug: "boca-raton", name: "Boca Raton", timezone: "America/New_York" },
      lightning: { status: "ok", data: over.lightning ?? null },
      nws: { status: "ok", data: { alerts: over.alerts ?? [], ripCurrentRisk: over.rip ?? "low" } },
      cityOfficial: {
        status: "ok",
        data: { flags: over.flags ?? [], noSwimAdvisory: over.noSwim },
      },
      waterQuality: { status: "ok", data: { advisory: over.waterAdvisory ?? false } },
      buoy: { status: "ok", data: over.gustMph != null ? { windGustMph: over.gustMph } : null },
      hourly: { status: "ok", data: over.hourly ?? [] },
      weather: {
        status: "ok",
        data: over.shortForecast ? { shortForecast: over.shortForecast } : null,
      },
      sun: {
        status: "ok",
        data: over.sunrise || over.sunset ? { sunrise: over.sunrise, sunset: over.sunset } : null,
      },
      precipRadar: {
        status: over.radarStatus ?? (over.radar ? "ok" : "error"),
        data: over.radar
          ? {
              rainNowMmHr: over.radar.rainNowMmHr ?? null,
              nearestRainKm: null,
              nearestBearingDeg: null,
              coveragePct: null,
              motion: null,
              etaMinutes: over.radar.etaMinutes ?? null,
              frameIso: over.radar.frameIso ?? "2026-09-02T15:00:00Z",
              framesUsed: 2,
              frameAgeMinutes: over.radar.frameAgeMinutes ?? 4,
            }
          : null,
      },
    },
  } as unknown as ConditionsResponse;
}

// --- A snapshot the SCORER can actually read -------------------------------
// `conditionsFixture` above carries only what the alert rules look at. This one
// carries every source the scoring engine reaches for, so a test can re-score it
// through a profile and watch the number move.

export const FIXTURE_SUNRISE = "2026-09-02T10:45:00Z"; // 6:45 AM ET
export const FIXTURE_SUNSET = "2026-09-02T23:35:00Z"; // 7:35 PM ET

export function wrapped<T>(data: T | null): Wrapped<T> {
  return { source: "test", status: data ? "ok" : "error", fetchedAt: "", attribution: "test", data };
}

/** A head-high, sunny day: great for a surfer, choppy for a swimmer. */
export function scorableSnapshot(over: { waveHeightFt?: number } = {}): ConditionsSnapshot {
  return {
    location: {
      slug: "boca-raton",
      name: "Boca Raton",
      region: "FL",
      lat: 26.36,
      lon: -80.07,
      timezone: "America/New_York",
    },
    generatedAt: FIXTURE_SUNRISE,
    tides: wrapped<TideData>(null),
    buoy: wrapped<BuoyData>(null),
    weather: wrapped<WeatherData>({
      airTempF: 85,
      windSpeedMph: 8,
      shortForecast: "Sunny",
      precipProbability: 5,
      humidityPct: 60,
      dewPointF: 62,
      cloudCoverPct: 10,
    }),
    marine: wrapped<MarineData>({
      waveHeightFt: over.waveHeightFt ?? 4,
      seaSurfaceTempF: 84,
      uvIndex: 6,
      cloudCoverPct: 10,
    }),
    cityOfficial: wrapped<CityOfficialData>({ flags: ["green"] }),
    waterQuality: wrapped<WaterQualityData>({ overall: "good", advisory: false, sites: [] }),
    nowcast: wrapped<NowcastData>(null),
    nws: wrapped<NwsData>({ alerts: [], ripCurrentRisk: "low" }),
    traffic: wrapped<TrafficData>(null),
    airQuality: wrapped<AirQualityData>(null),
    metno: wrapped<MetnoCurrent>(null),
    gfs: wrapped<MetnoCurrent>(null),
    lightning: wrapped<LightningData>(null),
    goesCloud: wrapped<GoesCloudData>(null),
    precipRadar: wrapped<PrecipRadarData>(null),
    sargassum: wrapped<SargassumData>({ level: "none" } as SargassumData),
    busyness: wrapped<BusynessData>(null),
    clarity: wrapped<ClarityData>(null),
    forecast: wrapped<ForecastDay[]>(null),
    sun: wrapped<SunData>({ date: "2026-09-02", sunrise: FIXTURE_SUNRISE, sunset: FIXTURE_SUNSET }),
    hourly: wrapped<HourlyMetrics[]>(null),
  };
}

/** The same snapshot as a full response, scored for everyone. */
export function scorableResponse(over: { waveHeightFt?: number } = {}): ConditionsResponse {
  const snapshot = scorableSnapshot(over);
  return {
    snapshot,
    score: computeScore(snapshot),
    hourlyScores: [],
    hourlyForecast: [],
    multiDayWindows: [],
    cams: [],
  };
}
