import { describe, it, expect } from "vitest";
import { computeScores, deriveMetrics, scoreBeachDay } from "@/lib/score";
import type {
  BuoyData,
  CityOfficialData,
  ConditionsSnapshot,
  Location,
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
  };
}

const LOC: Location = {
  slug: "boca-raton",
  name: "Boca Raton",
  region: "FL",
  lat: 26.36,
  lon: -80.07,
  timezone: "America/New_York",
  noaaTideStationId: "8722816",
  ndbcBuoyId: "LKWF1",
  offshoreWindFromDeg: 270,
  cams: [],
};

const NICE = snapshot({
  buoy: { waterTempF: 82, windSpeedMph: 8, windDirDeg: 90 },
  weather: { airTempF: 84, shortForecast: "Sunny", precipProbability: 10 },
  marine: { swellHeightFt: 3, swellPeriodS: 9, waveHeightFt: 2, uvIndex: 7 },
  city: { flags: ["green"] },
  water: { overall: "good", advisory: false, sites: [] },
});

describe("deriveMetrics", () => {
  it("prefers buoy water temp, marine swell, weather air temp", () => {
    const d = deriveMetrics(NICE);
    expect(d.waterTempF).toBe(82);
    expect(d.airTempF).toBe(84);
    expect(d.surfHeightFt).toBe(3);
    expect(d.surfPeriodS).toBe(9);
  });
});

describe("scoring", () => {
  it("gives nice conditions a strong Beach Day score with no caps", () => {
    const { beachDay } = computeScores(NICE, LOC);
    expect(beachDay.score).toBeGreaterThanOrEqual(70);
    expect(beachDay.caps).toHaveLength(0);
  });

  it("caps Beach Day at 60 under a purple flag", () => {
    const snap = snapshot({
      ...{ buoy: NICE.buoy.data, weather: NICE.weather.data, marine: NICE.marine.data, water: NICE.water?.data ?? undefined },
      city: { flags: ["yellow", "purple"] },
      water: { overall: "good", advisory: false, sites: [] },
    });
    const r = scoreBeachDay(deriveMetrics(snap));
    expect(r.score).toBeLessThanOrEqual(60);
    expect(r.caps.join(" ")).toMatch(/purple/i);
  });

  it("drives Beach Day to ~0 under a double-red flag", () => {
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

  it("excludes unavailable inputs from the average", () => {
    const sparse = snapshot({ weather: { airTempF: 82 } });
    const { beachDay } = computeScores(sparse, LOC);
    // Only one sub-score available, but it should still produce a valid number.
    expect(Number.isFinite(beachDay.score)).toBe(true);
    expect(beachDay.subScores.some((s) => s.score == null)).toBe(true);
  });
});
