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
    sun: wrap(null),
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

  it("scores wind as a band: 5-13 mph ideal, calm and gusty both demerit", () => {
    const windSub = (mph: number) =>
      scoreBeachDay(deriveMetrics(snapshot({ weather: { windSpeedMph: mph } })))
        .subScores.find((s) => s.key === "wind")!.score;

    // The 5-13 mph sea-breeze band is full marks.
    expect(windSub(5)).toBe(100);
    expect(windSub(8)).toBe(100);
    expect(windSub(13)).toBe(100);

    // Too little wind (stagnant) demerits; dead calm is clearly off-peak.
    expect(windSub(3)!).toBeLessThan(100);
    expect(windSub(0)!).toBeLessThan(windSub(3)!);

    // Too much wind (choppy/sandblasting) demerits; a gale bottoms out.
    expect(windSub(20)!).toBeLessThan(100);
    expect(windSub(25)).toBe(0);
  });

  it("rewards full sun and penalizes overcast/partly cloudy skies", () => {
    // Isolate the cloud-cover signal: no forecast text, no precip probability.
    const sky = (cloud: number) =>
      scoreBeachDay(
        deriveMetrics(snapshot({ marine: { cloudCoverPct: cloud } })),
      ).subScores.find((s) => s.key === "sky")!.score;

    expect(sky(0)).toBe(100); // full sun adds the most
    expect(sky(50)).toBe(50); // partly cloudy is middling
    expect(sky(100)).toBe(0); // overcast takes the most away
    expect(sky(20)!).toBeGreaterThan(sky(80)!); // monotonic
  });

  it("blends cloud cover with rain chance in the sky sub-score", () => {
    // 20% cloud (sunshine 80) + 50% rain chance (dry 50) -> 0.6*80 + 0.4*50 = 68.
    const r = scoreBeachDay(
      deriveMetrics(
        snapshot({
          marine: { cloudCoverPct: 20 },
          weather: { precipProbability: 50 },
        }),
      ),
    );
    expect(r.subScores.find((s) => s.key === "sky")!.score).toBe(68);
  });

  it("excludes unavailable inputs from the average", () => {
    const sparse = snapshot({ weather: { airTempF: 82 } });
    const beachDay = computeScore(sparse);
    // Only one sub-score available, but it should still produce a valid number.
    expect(beachDay.score).toBeGreaterThanOrEqual(0);
    expect(beachDay.subScores.some((s) => s.score == null)).toBe(true);
  });
});
