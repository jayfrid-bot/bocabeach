import { describe, it, expect } from "vitest";
import {
  computeHourlyScores,
  computeScore,
  deriveMetrics,
  rainSeverity,
  scoreBeachDay,
} from "@/lib/score";
import type {
  AirQualityData,
  BuoyData,
  BusynessData,
  CityOfficialData,
  ConditionsSnapshot,
  ForecastDay,
  HourlyMetrics,
  LightningData,
  MarineData,
  NwsData,
  SargassumData,
  SunData,
  TideData,
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
  nws?: NwsData | null;
  sun?: SunData | null;
  hourly?: HourlyMetrics[] | null;
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
    tides: wrap<TideData>(null),
    buoy: wrap(over.buoy ?? null),
    weather: wrap(over.weather ?? null),
    marine: wrap(over.marine ?? null),
    cityOfficial: wrap(over.city ?? null),
    waterQuality: wrap(over.water ?? null),
    nws: wrap(over.nws ?? null),
    airQuality: wrap<AirQualityData>(null),
    lightning: wrap<LightningData>(null),
    sargassum: wrap<SargassumData>(null),
    busyness: wrap<BusynessData>(null),
    forecast: wrap<ForecastDay[]>(null),
    sun: wrap(over.sun ?? null),
    hourly: wrap(over.hourly ?? null),
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

  it("caps the score under a City no-swim advisory", () => {
    const snap = snapshot({
      buoy: NICE.buoy.data,
      weather: NICE.weather.data,
      marine: NICE.marine.data,
      city: {
        flags: ["green"],
        noSwimAdvisory: {
          title: "NO SWIM ADVISORY for Spanish River Beach",
          url: "https://www.myboca.us/AlertCenter.aspx?AID=x",
        },
      },
      water: { overall: "good", advisory: false, sites: [] },
    });
    const r = scoreBeachDay(deriveMetrics(snap));
    expect(r.score).toBeLessThanOrEqual(40);
    expect(r.caps.join(" ")).toMatch(/no-swim advisory/i);
  });

  it("caps the score under a HIGH NWS rip-current risk", () => {
    const snap = snapshot({
      buoy: NICE.buoy.data,
      weather: NICE.weather.data,
      marine: NICE.marine.data,
      city: { flags: ["green"] },
      water: { overall: "good", advisory: false, sites: [] },
      nws: { alerts: [], ripCurrentRisk: "high" },
    });
    const r = scoreBeachDay(deriveMetrics(snap));
    expect(r.score).toBeLessThanOrEqual(40);
    expect(r.caps.join(" ")).toMatch(/rip current/i);
  });

  it("drives the score very low under a severe NWS warning", () => {
    const snap = snapshot({
      buoy: NICE.buoy.data,
      weather: NICE.weather.data,
      marine: NICE.marine.data,
      nws: {
        alerts: [{ event: "Hurricane Warning", severity: "Extreme" }],
        ripCurrentRisk: "high",
      },
    });
    const r = scoreBeachDay(deriveMetrics(snap));
    expect(r.score).toBeLessThanOrEqual(15);
    expect(r.caps.join(" ")).toMatch(/severe weather/i);
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

  it("hard-caps the live score to Poor when it's actively raining", () => {
    const rainy = snapshot({
      buoy: NICE.buoy.data,
      weather: { ...NICE.weather.data, shortForecast: "Light Rain" },
      marine: NICE.marine.data,
      city: { flags: ["green"] },
      water: { overall: "good", advisory: false, sites: [] },
    });
    const r = computeScore(rainy);
    expect(r.score).toBeLessThanOrEqual(25);
    expect(r.caps.join(" ")).toMatch(/rain/i);
  });

  it("drives the score even lower for a thunderstorm", () => {
    const storm = snapshot({
      buoy: NICE.buoy.data,
      weather: { ...NICE.weather.data, shortForecast: "Thunderstorm" },
      marine: NICE.marine.data,
      city: { flags: ["green"] },
      water: { overall: "good", advisory: false, sites: [] },
    });
    const r = computeScore(storm);
    expect(r.score).toBeLessThanOrEqual(15);
    expect(r.caps.join(" ")).toMatch(/thunder/i);
  });

  it("does NOT cap for a mere chance of rain (only nudges the sky sub-score)", () => {
    const chance = snapshot({
      buoy: NICE.buoy.data,
      weather: {
        ...NICE.weather.data,
        shortForecast: "Slight Chance Rain Showers",
        precipProbability: 70,
      },
      marine: NICE.marine.data,
      city: { flags: ["green"] },
      water: { overall: "good", advisory: false, sites: [] },
    });
    const r = computeScore(chance);
    expect(r.score).toBeGreaterThan(25);
    expect(r.caps.join(" ")).not.toMatch(/rain|thunder/i);
  });
});

describe("rainSeverity", () => {
  const sev = (over: Partial<Parameters<typeof rainSeverity>[0]>) =>
    rainSeverity({
      flags: ["unknown"],
      waterAdvisory: false,
      waterRating: "unknown",
      noSwimAdvisory: false,
      ripCurrentRisk: "unknown",
      severeAlert: false,
      ...over,
    });

  it("classifies by WMO weather code", () => {
    for (const c of [51, 61, 66, 80, 82]) expect(sev({ weatherCode: c })).toBe("rain");
    for (const c of [95, 96, 99]) expect(sev({ weatherCode: c })).toBe("thunder");
    for (const c of [0, 2, 3, 71, 85]) expect(sev({ weatherCode: c })).toBe("none");
  });

  it("falls back to text but ignores hedged 'chance' wording", () => {
    expect(sev({ shortForecast: "Rain" })).toBe("rain");
    expect(sev({ shortForecast: "Heavy Thunderstorm" })).toBe("thunder");
    expect(sev({ shortForecast: "Chance of Rain" })).toBe("none");
    expect(sev({ shortForecast: "Slight Chance Showers" })).toBe("none");
    expect(sev({ shortForecast: "Sunny" })).toBe("none");
  });

  it("prefers the WMO code over the text when both are present", () => {
    expect(sev({ weatherCode: 0, shortForecast: "Rain" })).toBe("none");
  });
});

describe("computeHourlyScores", () => {
  // Boca 2026-06-01: sunrise ~6:27 AM EDT (10:27Z), sunset ~8:08 PM EDT (00:08Z next day).
  const SUN: SunData = {
    date: "2026-06-01",
    sunrise: "2026-06-01T10:27:00.000Z",
    sunset: "2026-06-02T00:08:00.000Z",
  };

  // 48h of clear, pleasant weather starting 2026-06-01T00:00Z.
  function hourlyDay(): HourlyMetrics[] {
    const start = Date.parse("2026-06-01T00:00:00.000Z");
    return Array.from({ length: 48 }, (_, i) => ({
      time: new Date(start + i * 3_600_000).toISOString(),
      airTempF: 82,
      cloudCoverPct: 10,
      precipProbability: 0,
      weatherCode: 0,
      windSpeedMph: 8,
      windDirDeg: 90,
      uvIndex: 5,
      shortForecast: "Clear",
      emoji: "☀️",
    }));
  }

  const nyHour = (iso: string) =>
    Number(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "America/New_York",
        hour: "2-digit",
        hour12: false,
      }).format(new Date(iso)),
    );

  const niceBase = {
    buoy: NICE.buoy.data,
    weather: NICE.weather.data,
    marine: NICE.marine.data,
    water: { overall: "good" as const, advisory: false, sites: [] },
  };

  it("returns [] when hourly data is unavailable", () => {
    expect(computeHourlyScores(snapshot({ ...niceBase, sun: SUN }))).toEqual([]);
  });

  it("bounds the forecast to daylight hours in the local timezone", () => {
    const hrs = computeHourlyScores(
      snapshot({ ...niceBase, city: { flags: ["green"] }, hourly: hourlyDay(), sun: SUN }),
    );
    const hours = hrs.map((h) => nyHour(h.time));
    expect(hrs.length).toBeGreaterThan(8);
    expect(Math.min(...hours)).toBe(6); // sunrise hour (6 AM EDT)
    expect(Math.max(...hours)).toBe(20); // last hour <= sunset (8 PM EDT)
    expect(hours.every((h) => h >= 6 && h <= 20)).toBe(true);
  });

  it("carries day-constant safety caps into every forecast hour", () => {
    const hrs = computeHourlyScores(
      snapshot({ ...niceBase, city: { flags: ["red"] }, hourly: hourlyDay(), sun: SUN }),
    );
    expect(hrs.length).toBeGreaterThan(0);
    expect(hrs.every((h) => h.score <= 40)).toBe(true);
  });

  it("caps a stormy hour to ~15 and flags it as raining", () => {
    const rows = hourlyDay();
    const idx = rows.findIndex((r) => r.time === "2026-06-01T14:00:00.000Z"); // 10 AM EDT
    rows[idx] = {
      ...rows[idx],
      weatherCode: 95,
      shortForecast: "Thunderstorm",
      emoji: "⛈️",
    };
    const hrs = computeHourlyScores(
      snapshot({ ...niceBase, city: { flags: ["green"] }, hourly: rows, sun: SUN }),
    );
    const stormy = hrs.find((h) => new Date(h.time).getUTCHours() === 14)!;
    expect(stormy.score).toBeLessThanOrEqual(15);
    expect(stormy.raining).toBe(true);
    const clear = hrs.find((h) => new Date(h.time).getUTCHours() === 15)!;
    expect(clear.raining).toBe(false);
    expect(clear.score).toBeGreaterThan(25);
  });
});
