import { describe, it, expect } from "vitest";
import {
  bestBeachWindow,
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
  HourlyScore,
  LightningData,
  MarineData,
  MetnoCurrent,
  NowcastData,
  NwsData,
  SargassumData,
  SargassumRisk,
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
  sargassum?: SargassumData | null;
  busyness?: BusynessData | null;
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
    nowcast: wrap<NowcastData>(null),
    nws: wrap(over.nws ?? null),
    airQuality: wrap<AirQualityData>(null),
    metno: wrap<MetnoCurrent>(null),
    gfs: wrap<MetnoCurrent>(null),
    lightning: wrap<LightningData>(null),
    sargassum: wrap(over.sargassum ?? null),
    busyness: wrap(over.busyness ?? null),
    forecast: wrap<ForecastDay[]>(null),
    sun: wrap(over.sun ?? null),
    hourly: wrap(over.hourly ?? null),
  };
}

const NICE = snapshot({
  buoy: { waterTempF: 82, windSpeedMph: 8, windDirDeg: 90 },
  weather: {
    airTempF: 84,
    shortForecast: "Sunny",
    precipProbability: 10,
    humidityPct: 60,
    dewPointF: 62,
  },
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
      ["airTemp", "comfort", "crowds", "sandTemp", "sargassum", "sky", "uv", "waterQuality", "waterTemp", "waves", "wind"].sort(),
    );
    const total = subScores.reduce((a, s) => a + s.weight, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it("vetoes a rain/thunder weather code its own precip probability contradicts", () => {
    // 2026-06-12: Open-Meteo gave code 95 (Thunderstorm) at 11 AM & 1 PM ET
    // alongside 1% rain probability and satellite-observed full sun.
    const base = deriveMetrics(snapshot({}));
    const at = (code: number, prob?: number) =>
      rainSeverity({ ...base, weatherCode: code, precipProbability: prob });
    expect(at(95, 1)).toBe("none"); // phantom storm — vetoed
    expect(at(80, 10)).toBe("none"); // phantom shower — vetoed
    expect(at(95, 60)).toBe("thunder"); // corroborated — cap stands
    expect(at(61, 45)).toBe("rain");
    expect(at(95, undefined)).toBe("thunder"); // no probability -> fail safe
  });

  it("observed live rain caps the score even when the forecast code is vetoed", () => {
    // The 2026-06-15 bug: it was raining (nowcast) with lightning nearby, but the
    // hour's code-95 was vetoed by the corroboration rule (precip prob 6%), so the
    // score stayed 77. Observed nowcast rain must cap regardless of the forecast.
    const base = deriveMetrics(snapshot({}));
    const r = scoreBeachDay({
      ...base,
      weatherCode: 95,
      precipProbability: 6, // would be vetoed by rainSeverity
      nowcastRaining: true,
    });
    expect(r.score).toBeLessThanOrEqual(25);
    expect(r.caps.join(" ")).toMatch(/raining right now/i);
  });

  it("nearby lightning bottoms the score as a get-out-of-the-water safety override", () => {
    const base = deriveMetrics(snapshot({}));
    const r = scoreBeachDay({ ...base, lightningWithin10mi: 61, lightningLastMinutesAgo: 4 });
    expect(r.score).toBeLessThanOrEqual(10);
    expect(r.caps.join(" ")).toMatch(/lightning within 10 miles/i);
  });

  it("does not cap for lightning when strikes are absent", () => {
    const base = deriveMetrics(snapshot({}));
    const r = scoreBeachDay({ ...base, lightningWithin10mi: 0 });
    expect(r.caps.join(" ")).not.toMatch(/lightning/i);
  });

  it("scores sand barefoot comfort: cool sand best, scorching sand drags the score", () => {
    const base = deriveMetrics(snapshot({}));
    const at = (f?: number) => scoreBeachDay({ ...base, sandTempF: f });
    const sandSub = (f?: number) => at(f).subScores.find((s) => s.key === "sandTemp")!.score;
    expect(sandSub(90)).toBe(100);
    expect(sandSub(120)).toBeLessThan(70);
    expect(sandSub(140)).toBeLessThan(20);
    expect(sandSub(undefined)).toBeNull(); // unknown sand is excluded, not penalized
    expect(at(90).score).toBeGreaterThan(at(140).score);
  });

  it("scores seaweed (sargassum) as a sub-score: none best, high worst", () => {
    const sg = (level: SargassumRisk) =>
      scoreBeachDay(
        deriveMetrics(snapshot({ sargassum: { level, isMorning: true, cams: [] } })),
      ).subScores.find((s) => s.key === "sargassum")!.score;
    expect(sg("none")).toBe(100);
    expect(sg("low")).toBe(85);
    expect(sg("moderate")).toBe(55);
    expect(sg("high")).toBe(20);
    expect(sg("unknown")).toBeNull(); // no signal -> excluded from the average
  });

  it("refines the seaweed sub-score from coverage % (anchors match the categories)", () => {
    const sg = (coveragePct: number) =>
      scoreBeachDay(
        deriveMetrics(
          snapshot({ sargassum: { level: "moderate", coveragePct, isMorning: true, cams: [] } }),
        ),
      ).subScores.find((s) => s.key === "sargassum")!.score;
    expect(sg(0)).toBe(100);
    expect(sg(10)).toBe(85);
    expect(sg(20)).toBe(70); // interpolated between the 10 and 30 anchors
    expect(sg(30)).toBe(55);
    expect(sg(60)).toBe(20);
  });

  it("scores crowds (emptier is better) and degrades to null when unknown", () => {
    const crowds = (busy: BusynessData | null) =>
      scoreBeachDay(deriveMetrics(snapshot({ busyness: busy }))).subScores.find(
        (s) => s.key === "crowds",
      )!.score;
    const at = (crowdPct: number) =>
      crowds({ level: "moderate", crowdPct } as BusynessData);
    expect(at(0)).toBe(100);
    expect(at(50)).toBe(70);
    expect(at(100)).toBe(25);
    // Falls back to the categorical level when no crowdPct is present.
    expect(crowds({ level: "packed" } as BusynessData)).toBe(crowds({ level: "packed", crowdPct: 95 } as BusynessData));
    expect(crowds(null)).toBeNull();
  });

  it("caps the score at 65 under HIGH sargassum and 85 under MODERATE", () => {
    const withSeaweed = (level: SargassumRisk) =>
      scoreBeachDay(
        deriveMetrics(
          snapshot({
            buoy: NICE.buoy.data,
            weather: NICE.weather.data,
            marine: NICE.marine.data,
            city: { flags: ["green"] },
            water: { overall: "good", advisory: false, sites: [] },
            sargassum: { level, isMorning: true, cams: [] },
          }),
        ),
      );
    const high = withSeaweed("high");
    expect(high.score).toBeLessThanOrEqual(65);
    expect(high.score).toBeGreaterThan(40); // a beach day, not a closure
    expect(high.caps.join(" ")).toMatch(/sargassum|seaweed/i);

    const moderate = withSeaweed("moderate");
    expect(moderate.score).toBeLessThanOrEqual(85);
    expect(moderate.caps.join(" ")).toMatch(/sargassum|seaweed/i);

    // none/low never cap, and don't add a seaweed cap message.
    expect(withSeaweed("none").caps.join(" ")).not.toMatch(/sargassum|seaweed/i);
    expect(withSeaweed("low").caps.join(" ")).not.toMatch(/sargassum|seaweed/i);

    // The CATEGORY trips the cap — a "high" call with a low coverage % still caps at 65.
    const highLowPct = scoreBeachDay(
      deriveMetrics(
        snapshot({
          buoy: NICE.buoy.data,
          weather: NICE.weather.data,
          marine: NICE.marine.data,
          city: { flags: ["green"] },
          water: { overall: "good", advisory: false, sites: [] },
          sargassum: { level: "high", coveragePct: 12, isMorning: true, cams: [] },
        }),
      ),
    );
    expect(highLowPct.score).toBeLessThanOrEqual(65);
    expect(highLowPct.caps.join(" ")).toMatch(/sargassum|seaweed/i);
  });

  it("scores comfort from dew point (mugginess), with a humidity penalty at extremes", () => {
    const comfort = (w: WeatherData) =>
      scoreBeachDay(deriveMetrics(snapshot({ weather: w }))).subScores.find(
        (s) => s.key === "comfort",
      )!.score;
    expect(comfort({ dewPointF: 58 })).toBe(100); // dry & comfortable
    expect(comfort({ dewPointF: 68 })).toBe(60); // sticky
    expect(comfort({ dewPointF: 75 })).toBe(25); // oppressive
    // 65°F dew pt = 75, then -(95-85)*1.5 = -15 for very high humidity
    expect(comfort({ dewPointF: 65, humidityPct: 95 })).toBe(60);
    expect(comfort({})).toBeNull(); // no dew point -> excluded from the average
  });

  it("a muggy dew point drags the Beach Day score below a comfortable one", () => {
    const goodSnap = (dewPointF: number) =>
      snapshot({
        buoy: { waterTempF: 82, windSpeedMph: 8, windDirDeg: 90 },
        weather: { airTempF: 84, shortForecast: "Sunny", precipProbability: 10, dewPointF },
        marine: { waveHeightFt: 2, uvIndex: 7 },
        city: { flags: ["green"] },
        water: { overall: "good", advisory: false, sites: [] },
      });
    expect(computeScore(goodSnap(78)).score).toBeLessThan(computeScore(goodSnap(58)).score);
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

  it("caps the score at 85 under a red flag (still a great beach day)", () => {
    const snap = snapshot({
      buoy: NICE.buoy.data,
      weather: NICE.weather.data,
      marine: NICE.marine.data,
      city: { flags: ["red"] },
      water: { overall: "good", advisory: false, sites: [] },
    });
    const r = scoreBeachDay(deriveMetrics(snap));
    // A rough-surf red flag is a swimmer-safety warning, not a day-killer.
    expect(r.score).toBeLessThanOrEqual(85);
    expect(r.score).toBeGreaterThan(40);
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

  it("caps the score at 85 under a HIGH NWS rip-current risk (still a great beach day)", () => {
    const snap = snapshot({
      buoy: NICE.buoy.data,
      weather: NICE.weather.data,
      marine: NICE.marine.data,
      city: { flags: ["green"] },
      water: { overall: "good", advisory: false, sites: [] },
      nws: { alerts: [], ripCurrentRisk: "high" },
    });
    const r = scoreBeachDay(deriveMetrics(snap));
    // High rip-current risk is a swimmer-safety warning, not a day-killer.
    expect(r.score).toBeLessThanOrEqual(85);
    expect(r.score).toBeGreaterThan(40);
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

  it("scores past hours with the seaweed read in effect then — later reads never rewrite them", () => {
    // 10 AM ET read was high/65%; the 2 PM ET read (current) is moderate/30%.
    // With "now" at 3:30 PM ET, morning hours must keep scoring against high.
    const s = snapshot({
      ...niceBase,
      sun: SUN,
      hourly: hourlyDay(),
      sargassum: {
        level: "moderate",
        coveragePct: 30,
        isMorning: false,
        cams: [],
        todayReads: [
          { hour: 10, level: "high", coveragePct: 65 },
          { hour: 14, level: "moderate", coveragePct: 30 },
        ],
      },
    });
    const now = Date.parse("2026-06-01T19:30:00.000Z"); // 3:30 PM ET
    const scores = computeHourlyScores(s, now);
    const at = (h: number) => scores.find((x) => nyHour(x.time) === h)!;
    // Past morning hour: high seaweed cap (65) held; current hour: moderate (85 cap).
    expect(at(11).score).toBeLessThan(at(16).score);
    expect(at(11).score).toBeLessThanOrEqual(65);
    // Early hours before the first read fall back to the day's first read (high).
    expect(at(8).score).toBeLessThanOrEqual(65);
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

  it("crowds vary by hour: a packed afternoon scores below a quiet morning", () => {
    const busyness = {
      level: "moderate",
      byHour: [
        { hour: 7, level: "quiet", crowdPct: 10, samples: 3 },
        { hour: 15, level: "packed", crowdPct: 95, samples: 3 },
      ],
    } as BusynessData;
    const hrs = computeHourlyScores(
      snapshot({ ...niceBase, city: { flags: ["green"] }, busyness, hourly: hourlyDay(), sun: SUN }),
    );
    const at = (localHour: number) => hrs.find((h) => nyHour(h.time) === localHour)!;
    expect(at(15).score).toBeLessThan(at(7).score);
  });

  it("carries day-constant safety caps into every forecast hour", () => {
    const hrs = computeHourlyScores(
      snapshot({ ...niceBase, city: { flags: ["red"] }, hourly: hourlyDay(), sun: SUN }),
    );
    expect(hrs.length).toBeGreaterThan(0);
    // Red flag caps each hour at 85 (swimmer-safety warning, not a day-killer).
    expect(hrs.every((h) => h.score <= 85)).toBe(true);
  });

  it("carries day-constant HIGH sargassum into every forecast hour (cap 65)", () => {
    const hrs = computeHourlyScores(
      snapshot({
        ...niceBase,
        city: { flags: ["green"] },
        sargassum: { level: "high", isMorning: true, cams: [] },
        hourly: hourlyDay(),
        sun: SUN,
      }),
    );
    expect(hrs.length).toBeGreaterThan(0);
    expect(hrs.every((h) => h.score <= 65)).toBe(true);
  });

  it("caps a stormy hour to ~15 and flags it as raining", () => {
    const rows = hourlyDay();
    const idx = rows.findIndex((r) => r.time === "2026-06-01T14:00:00.000Z"); // 10 AM EDT
    rows[idx] = {
      ...rows[idx],
      weatherCode: 95,
      precipProbability: 80, // corroborated — a real storm, not a phantom code
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

describe("bestBeachWindow", () => {
  const h = (hour: number, score: number): HourlyScore => ({
    time: `2026-06-03T${String(hour).padStart(2, "0")}:00:00Z`,
    score,
    rating: "x",
    emoji: "",
    raining: false,
  });

  it("finds the longest contiguous run within 8 of the day's peak", () => {
    const w = bestBeachWindow([
      h(8, 40),
      h(9, 55),
      h(10, 80),
      h(11, 82),
      h(12, 78),
      h(13, 50),
      h(14, 84),
    ])!;
    expect(w.startIso).toBe("2026-06-03T10:00:00Z");
    expect(w.endIso).toBe("2026-06-03T13:00:00.000Z"); // last hour (12:00) + 1h
    expect(w.score).toBe(82);
  });

  it("returns null with no hours", () => {
    expect(bestBeachWindow([])).toBeNull();
  });
});
