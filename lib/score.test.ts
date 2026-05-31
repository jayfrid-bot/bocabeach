import { describe, it, expect } from "vitest";
import { computeScore, deriveMetrics, scoreBeachDay } from "@/lib/score";
import type {
  BuoyData,
  CityOfficialData,
  ConditionsSnapshot,
  MarineData,
  WaterQualityData,
  WeatherData,
  Wrapped,
} from "@/lib/types";

function wrap<T>(data: T | null): Wrapped<T> {
  return {
    source: "test",
    status: data ? "ok" : "error",
    fetchedAt: new Date().toISOString(),
    attribution: "test",
    data,
  };
}

function snapshot(over: {
  buoy?: BuoyData | null;
  weather?: WeatherData | null;
  marine?: MarineData | null;
  city?: CityOfficialData | null;
  water?: WaterQualityData | null;
}): ConditionsSnapshot {
  return {
    location: {
      slug: "boca-raton",
      name: "Boca Raton",
      region: "FL",
      lat: 26.36,
      lon: -80.07,
      timezone: "America/New_York",
    },
    generatedAt: new Date().toISOString(),
    tides: wrap(null),
    buoy: wrap(over.buoy ?? null),
    weather: wrap(over.weather ?? null),
    marine: wrap(over.marine ?? null),
    cityOfficial: wrap(over.city ?? null),
    waterQuality: wrap(over.water ?? null),
    forecast: wrap(null),
  };
}

const NICE = snapshot({
  buoy: { waterTempF: 82, windSpeedMph: 8, windDirDeg: 90 },
  weather: { airTempF: 84, shortForecast: "Sunny", precipProbability: 10 },
  marine: { waveHeightFt: 2, uvIndex: 7 },
  city: { flags: ["green"] },
  water: { overall: "good", advisory: false, sites: [] },
});

describe("deriveMetrics", () => {
  it("prefers buoy water temp, weather air temp, and combined sea state", () => {
    const d = deriveMetrics(NICE);
    expect(d.waterTempF).toBe(82);
    expect(d.airTempF).toBe(84);
    expect(d.waveHeightFt).toBe(2);
  });
});

describe("scoring (Beach Day only — no surf)", () => {
  it("uses the beachgoer sub-scores whose weights sum to 1", () => {
    const { subScores } = computeScore(NICE);
    const keys = subScores.map((s) => s.key).sort();
    expect(keys).toEqual(
      ["airTemp", "sky", "uv", "waterQuality", "waterTemp", "waves", "wind"].sort(),
    );
    const total = subScores.reduce((a, s) => a + s.weight, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it("gives nice conditions a strong Beach Day score with no caps", () => {
    const beachDay = computeScore(NICE);
    expect(beachDay.score).toBeGreaterThanOrEqual(70);
    expect(beachDay.caps).toHaveLength(0);
  });

  it("does NOT penalize for a purple (marine-pest) flag", () => {
    const snap = snapshot({
      buoy: NICE.buoy.data,
      weather: NICE.weather.data,
      marine: NICE.marine.data,
      city: { flags: ["yellow", "purple"] },
      water: { overall: "good", advisory: false, sites: [] },
    });
    const r = scoreBeachDay(deriveMetrics(snap));
    // Purple is near-constant in South FL, so it carries no day-to-day signal.
    expect(r.caps.join(" ")).not.toMatch(/purple/i);
    expect(r.score).toBeGreaterThanOrEqual(70);
  });

  it("caps the score under a red flag", () => {
    const snap = snapshot({
      buoy: NICE.buoy.data,
      weather: NICE.weather.data,
      marine: NICE.marine.data,
      city: { flags: ["red"] },
      water: { overall: "good", advisory: false, sites: [] },
    });
    const r = scoreBeachDay(deriveMetrics(snap));
    expect(r.score).toBeLessThanOrEqual(40);
    expect(r.caps.join(" ")).toMatch(/red flag/i);
  });

  it("drives the score to ~0 under a double-red flag", () => {
    const snap = snapshot({
      buoy: NICE.buoy.data,
      weather: NICE.weather.data,
      marine: NICE.marine.data,
      city: { flags: ["double-red"] },
      water: { overall: "good", advisory: false, sites: [] },
    });
    const r = scoreBeachDay(deriveMetrics(snap));
    expect(r.score).toBeLessThanOrEqual(5);
  });

  it("caps the score under a water-quality advisory", () => {
    const snap = snapshot({
      buoy: NICE.buoy.data,
      weather: NICE.weather.data,
      marine: NICE.marine.data,
      city: { flags: ["green"] },
      water: { overall: "poor", advisory: true, sites: [] },
    });
    const r = scoreBeachDay(deriveMetrics(snap));
    expect(r.score).toBeLessThanOrEqual(40);
    expect(r.caps.join(" ")).toMatch(/advisory/i);
  });

  it("excludes unavailable inputs from the average", () => {
    const sparse = snapshot({ weather: { airTempF: 82 } });
    const beachDay = computeScore(sparse);
    // Only one sub-score available, but it should still produce a valid number.
    expect(beachDay.score).toBeGreaterThanOrEqual(0);
    expect(beachDay.subScores.some((s) => s.score == null)).toBe(true);
  });
});
