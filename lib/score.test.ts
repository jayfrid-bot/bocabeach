import { describe, it, expect } from "vitest";
import {
  anchorCurrentHourScore,
  bestBeachWindow,
  computeHourlyScores,
  computeMultiDayWindows,
  computeScore,
  deriveMetrics,
  median,
  rainSeverity,
  scoreBeachDay,
} from "@/lib/score";
import type {
  AirQualityData,
  BuoyData,
  BusynessData,
  CityOfficialData,
  ConditionsSnapshot,
  FlagColor,
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
  TrafficData,
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
  nowcast?: NowcastData | null;
  /** Pass a pre-wrapped lightning result to exercise the freshness gate
   * (status + lastMinutesAgo); plain data wraps to status "ok". */
  lightning?: LightningData | Wrapped<LightningData> | null;
}): ConditionsSnapshot {
  const lightning =
    over.lightning && "status" in over.lightning
      ? (over.lightning as Wrapped<LightningData>)
      : wrap<LightningData>((over.lightning as LightningData | null) ?? null);
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
    nowcast: wrap(over.nowcast ?? null),
    nws: wrap(over.nws ?? null),
    traffic: wrap<TrafficData>(null),
    airQuality: wrap<AirQualityData>(null),
    metno: wrap<MetnoCurrent>(null),
    gfs: wrap<MetnoCurrent>(null),
    lightning,
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
    // A vetoed code-95 (thunderstorm) IS a storm signal, so observed rain
    // alongside it upgrades to the tougher thunder tier (<=15), not plain rain.
    expect(r.score).toBeLessThanOrEqual(15);
    expect(r.caps.join(" ")).toMatch(/thunder|raining/i);
  });

  it("a thunder signal alongside observed rain caps to 15, not 25", () => {
    // Use the nice base so a real sub-score exists (rawScore well above any cap),
    // isolating the difference to the cap tier itself.
    const base = deriveMetrics(NICE);
    // Plain observed rain, no storm corroboration -> the 25 rain ceiling.
    const plain = scoreBeachDay({ ...base, nowcastRaining: true });
    expect(plain.score).toBeLessThanOrEqual(25);
    expect(plain.score).toBeGreaterThan(15);
    expect(plain.caps.join(" ")).toMatch(/raining right now/i);
    expect(plain.caps.join(" ")).not.toMatch(/thunder/i);
    // Observed rain + a corroborating storm signal (text) -> the tougher 15 cap.
    const stormy = scoreBeachDay({
      ...base,
      nowcastRaining: true,
      shortForecast: "Thunderstorm",
    });
    expect(stormy.score).toBeLessThanOrEqual(15);
    expect(stormy.caps.join(" ")).toMatch(/thunder/i);
  });

  describe("nowcast rain corroboration (phantom-shower veto)", () => {
    // Start of the CURRENT hour so currentHourOf() finds the bucket.
    const hourStart = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString();
    const RAINING = { state: "raining" as const, text: "Raining — easing in ~14 min" };

    it("vetoes a phantom nowcast shower under a verifiably clear sky (2026-07-15)", () => {
      // Real incident: minutely model said "raining" while code 0 / 2% prob /
      // 16% cloud consensus / 0.00" measured — a sunny day capped at 25.
      const s = snapshot({
        ...{},
        weather: { airTempF: 88, shortForecast: "Clear", precipProbability: 6, cloudCoverPct: 16 },
        hourly: [{ time: hourStart, weatherCode: 0, precipProbability: 2, precipIn: 0, cloudCoverPct: 0 }],
        nowcast: RAINING,
      });
      expect(deriveMetrics(s).nowcastRaining).toBe(false);
      expect(computeScore(s).caps.join(" ")).not.toMatch(/raining right now/i);
    });

    it("keeps the cap when a storm code corroborates — even a prob-vetoed code 95 (2026-06-15)", () => {
      // The regression this gate must NOT reintroduce: real rain + code 95 whose
      // own 6% prob vetoes it as a standalone cap. The code still corroborates
      // the independent nowcast signal, so observed rain caps the day.
      const s = snapshot({
        weather: { airTempF: 85, precipProbability: 6 },
        hourly: [{ time: hourStart, weatherCode: 95, precipProbability: 6, cloudCoverPct: 40 }],
        nowcast: RAINING,
      });
      expect(deriveMetrics(s).nowcastRaining).toBe(true);
      // The snapshot path applies the plain observed-rain ceiling (25); the
      // tougher 15 thunder tier lives in the hourly path where the code rides
      // along. What matters here: the corroborated rain still CAPS the day.
      expect(computeScore(s).score).toBeLessThanOrEqual(25);
      expect(computeScore(s).caps.join(" ")).toMatch(/raining right now/i);
    });

    it("keeps the cap under a heavily clouded sky (rain needs clouds — 90% corroborates)", () => {
      const s = snapshot({
        weather: { airTempF: 85, precipProbability: 10, cloudCoverPct: 90 },
        nowcast: RAINING,
      });
      expect(deriveMetrics(s).nowcastRaining).toBe(true);
    });

    it("fails safe: with every corroborating signal unknown, the nowcast still counts", () => {
      // No weather, no hourly, no lightning — only positive evidence of a clear
      // sky may veto; total ignorance must not.
      const s = snapshot({ nowcast: RAINING });
      expect(deriveMetrics(s).nowcastRaining).toBe(true);
    });
  });

  it("nearby lightning bottoms the score as a get-out-of-the-water safety override", () => {
    const base = deriveMetrics(snapshot({}));
    const r = scoreBeachDay({ ...base, lightningWithin5mi: true, lightningLastMinutesAgo: 4 });
    expect(r.score).toBeLessThanOrEqual(10);
    expect(r.caps.join(" ")).toMatch(/lightning within 5 miles/i);
  });

  it("does not cap for lightning when no strike is within 5 mi", () => {
    const base = deriveMetrics(snapshot({}));
    const r = scoreBeachDay({ ...base, lightningWithin5mi: false });
    expect(r.caps.join(" ")).not.toMatch(/lightning/i);
  });

  it("caps only on a fresh strike within 5 mi (not stale, errored, or farther than 5 mi)", () => {
    const niceBase = {
      buoy: NICE.buoy.data,
      weather: NICE.weather.data,
      marine: NICE.marine.data,
      city: { flags: ["green"] as FlagColor[] },
      water: { overall: "good" as const, advisory: false, sites: [] },
    };
    const ld = (over: Partial<LightningData>): LightningData => ({
      windowMinutes: 30,
      nearestMi: 3, // closest strike within 5 mi by default
      within10mi: 5,
      within25mi: 5,
      within50mi: 5,
      totalInArea: 5,
      ...over,
    });
    // Feed errored (status !== "ok") even though strikes are present -> no cap.
    const errored = scoreBeachDay(
      deriveMetrics(
        snapshot({
          ...niceBase,
          lightning: { ...wrap(ld({ lastMinutesAgo: 4 })), status: "error" },
        }),
      ),
    );
    expect(errored.caps.join(" ")).not.toMatch(/lightning/i);
    expect(errored.score).toBeGreaterThan(40);
    // Feed OK but the most recent strike is older than 30 min -> stale, no cap.
    const stale = scoreBeachDay(
      deriveMetrics(snapshot({ ...niceBase, lightning: ld({ lastMinutesAgo: 45 }) })),
    );
    expect(stale.caps.join(" ")).not.toMatch(/lightning/i);
    expect(stale.score).toBeGreaterThan(40);
    // Feed OK and recent, but the closest strike is 8 mi away (> 5 mi) -> no cap.
    const farOff = scoreBeachDay(
      deriveMetrics(snapshot({ ...niceBase, lightning: ld({ lastMinutesAgo: 4, nearestMi: 8 }) })),
    );
    expect(farOff.caps.join(" ")).not.toMatch(/lightning/i);
    expect(farOff.score).toBeGreaterThan(40);
    // Feed OK, fresh, and a strike within 5 mi -> get-out-of-the-water cap.
    const fresh = scoreBeachDay(
      deriveMetrics(snapshot({ ...niceBase, lightning: ld({ lastMinutesAgo: 4 }) })),
    );
    expect(fresh.score).toBeLessThanOrEqual(10);
    expect(fresh.caps.join(" ")).toMatch(/lightning within 5 miles/i);
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
    // Night gate (lib/sources/busyness.ts summarizeBusyness): data is present
    // but degraded to "unknown" with no crowdPct — must drop out, not score a
    // stale/dark cam read as if it were a real "packed" or "empty" beach.
    expect(crowds({ level: "unknown" } as BusynessData)).toBeNull();
  });

  it("seaweed ceiling slides with coverage %, not the category alone", () => {
    // NOTE: the ceiling formula: c < 50 -> no ceiling at all; 50 <= c < 90 ->
    // Math.round(100 - (c - 50) * 0.75) (65% -> 89, 75% -> 81, 85% -> 74);
    // c >= 90 -> flat 70 (the owner explicitly wants 90-100% capped at 70, never
    // lower, so a full blanket doesn't read as an outright closure).
    const withSeaweed = (sargassum: SargassumData) =>
      scoreBeachDay(
        deriveMetrics(
          snapshot({
            buoy: NICE.buoy.data,
            weather: NICE.weather.data,
            marine: NICE.marine.data,
            city: { flags: ["green"] },
            water: { overall: "good", advisory: false, sites: [] },
            sargassum,
          }),
        ),
      );

    // (a) A barely-high day (65% coverage) gets a much gentler ceiling (89) than
    // the old flat 65 — it binds only if the raw score would otherwise exceed 89.
    const barelyHigh = withSeaweed({ level: "high", coveragePct: 65, isMorning: true, cams: [] });
    expect(barelyHigh.score).toBeLessThanOrEqual(89);
    expect(barelyHigh.score).toBeGreaterThan(65); // NOT pinned to the old hard cap

    // (b) A fully (or near-fully) blanketed beach hits the flat floor: 70, from
    // 90% coverage all the way through 100% — never below 70.
    const fullyBlanketed = withSeaweed({ level: "high", coveragePct: 100, isMorning: true, cams: [] });
    expect(fullyBlanketed.score).toBeLessThanOrEqual(70);
    expect(fullyBlanketed.score).toBeGreaterThan(40); // still not a closure
    expect(fullyBlanketed.caps.join(" ")).toMatch(/seaweed/i);

    const almostFull = withSeaweed({ level: "high", coveragePct: 90, isMorning: true, cams: [] });
    expect(almostFull.score).toBeLessThanOrEqual(70);

    // (c) A level-only "moderate" call (no coveragePct) falls back to 40%
    // coverage — under the 50% threshold, so NO ceiling / cap message at all.
    const moderateLevelOnly = withSeaweed({ level: "moderate", isMorning: true, cams: [] });
    expect(moderateLevelOnly.caps.join(" ")).not.toMatch(/sargassum|seaweed/i);

    // none/low never cap, and don't add a seaweed cap message.
    expect(withSeaweed({ level: "none", isMorning: true, cams: [] }).caps.join(" ")).not.toMatch(
      /sargassum|seaweed/i,
    );
    expect(withSeaweed({ level: "low", isMorning: true, cams: [] }).caps.join(" ")).not.toMatch(
      /sargassum|seaweed/i,
    );

    // (d) "High" with NO coveragePct falls back to 70% -> ceiling
    // round(100 - (70-50)*0.75) = 85.
    const highNoPct = withSeaweed({ level: "high", isMorning: true, cams: [] });
    expect(highNoPct.score).toBeLessThanOrEqual(85);
    expect(highNoPct.caps.join(" ")).toMatch(/seaweed/i);

    // Low coverage under a "high" category call no longer trips any ceiling —
    // coverage, not category, governs now.
    const highLowPct = withSeaweed({ level: "high", coveragePct: 12, isMorning: true, cams: [] });
    expect(highLowPct.caps.join(" ")).not.toMatch(/sargassum|seaweed/i);
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

  it("caps the score to <= 15 for each life-threatening *-Warning event", () => {
    const withWarning = (event: string) =>
      scoreBeachDay(
        deriveMetrics(
          snapshot({
            buoy: NICE.buoy.data,
            weather: NICE.weather.data,
            marine: NICE.marine.data,
            city: { flags: ["green"] },
            water: { overall: "good", advisory: false, sites: [] },
            // severity "Minor" so the cap rides on the event NAME, not the tier.
            nws: { alerts: [{ event, severity: "Minor" }], ripCurrentRisk: "unknown" },
          }),
        ),
      );
    for (const event of ["Tornado Warning", "Flash Flood Warning", "Coastal Flood Warning"]) {
      const r = withWarning(event);
      expect(r.score).toBeLessThanOrEqual(15);
      expect(r.caps.join(" ")).toMatch(/severe weather/i);
    }
  });

  it("caps the score at 92 under a MODERATE NWS rip-current risk", () => {
    const snap = snapshot({
      buoy: NICE.buoy.data,
      weather: NICE.weather.data,
      marine: NICE.marine.data,
      city: { flags: ["green"] },
      water: { overall: "good", advisory: false, sites: [] },
      nws: { alerts: [], ripCurrentRisk: "moderate" },
    });
    const r = scoreBeachDay(deriveMetrics(snap));
    expect(r.score).toBeLessThanOrEqual(92);
    expect(r.score).toBeGreaterThan(40); // still a good beach day
    expect(r.caps.join(" ")).toContain("Moderate rip current risk (NWS)");
  });

  it("soft-caps the score at 85 under a high-surf / coastal-flood ADVISORY", () => {
    const snap = snapshot({
      buoy: NICE.buoy.data,
      weather: NICE.weather.data,
      marine: NICE.marine.data,
      city: { flags: ["green"] },
      water: { overall: "good", advisory: false, sites: [] },
      // ADVISORY tier (not a *-Warning): a soft swim cap, not a day-killer.
      nws: { alerts: [{ event: "Coastal Flood Advisory", severity: "Moderate" }], ripCurrentRisk: "unknown" },
    });
    const r = scoreBeachDay(deriveMetrics(snap));
    expect(r.score).toBeLessThanOrEqual(85);
    expect(r.score).toBeGreaterThan(40);
    expect(r.caps.join(" ")).toContain(
      "High surf or coastal-flood advisory — swimming discouraged",
    );
    // An advisory is NOT a severe-warning closure.
    expect(r.caps.join(" ")).not.toMatch(/severe weather/i);
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

  it("flags a total data outage with dataAvailable=false instead of a confident 0", () => {
    // Empty snapshot: every source is null, so no sub-score is available.
    const out = computeScore(snapshot({}));
    expect(out.subScores.every((s) => s.score == null)).toBe(true);
    expect(out.dataAvailable).toBe(false);
    expect(out.score).toBe(0); // 0 here means "unknown", not "confidently bad"
    expect(out.caps).toHaveLength(0); // nothing to cap when there's no data
    // A normal score keeps dataAvailable truthy (omitted or true).
    expect(computeScore(NICE).dataAvailable).not.toBe(false);
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

describe("median", () => {
  it("rounds an even-count midpoint to a whole number (no .5 leak)", () => {
    // (70 + 71) / 2 = 70.5 — must round to 71, not surface a fractional metric.
    expect(median(70, 71)).toBe(71);
  });

  it("takes the middle value for an odd count and ignores non-finite inputs", () => {
    expect(median(70, 72, 74)).toBe(72);
    expect(median(undefined, 80)).toBe(80); // single voice -> that value
    expect(median(undefined, undefined)).toBeUndefined(); // no voices -> undefined
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
    // Past morning hour: high/65% seaweed ceiling (round(100-(65-50)*0.75)=89)
    // held; current hour is moderate/30% — under the 50% threshold, no ceiling.
    expect(at(11).score).toBeLessThan(at(16).score);
    expect(at(11).score).toBeLessThanOrEqual(89);
    // Early hours before the first read fall back to the day's first read (high/65%).
    expect(at(8).score).toBeLessThanOrEqual(89);
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

  it("applies day-constant safety caps to all of TODAY's forecast hours", () => {
    const now = Date.parse("2026-06-01T15:00:00.000Z"); // 11 AM EDT on the fixture day
    const hrs = computeHourlyScores(
      snapshot({ ...niceBase, city: { flags: ["red"] }, hourly: hourlyDay(), sun: SUN }),
      now,
    );
    expect(hrs.length).toBeGreaterThan(0);
    // Red flag caps each of today's hours at 85 (swimmer-safety warning, not a day-killer).
    expect(hrs.every((h) => h.score <= 85)).toBe(true);
  });

  it("applies HIGH sargassum (level-only fallback ceiling 85) to all of TODAY's forecast hours", () => {
    // Seaweed is a today-only observation — it caps today's hours, never future
    // days (see the multi-day test: the week must not flat-line at the cap).
    // Level-only "high" (no coveragePct) falls back to 70% coverage ->
    // ceiling = round(100 - (70-50)*0.75) = 85.
    const now = Date.parse("2026-06-01T15:00:00.000Z"); // 11 AM EDT on the fixture day
    const hrs = computeHourlyScores(
      snapshot({
        ...niceBase,
        city: { flags: ["green"] },
        sargassum: { level: "high", isMorning: true, cams: [] },
        hourly: hourlyDay(),
        sun: SUN,
      }),
      now,
    );
    expect(hrs.length).toBeGreaterThan(0);
    expect(hrs.every((h) => h.score <= 85)).toBe(true);
  });

  it("copies observed lightning/rain into the CURRENT-hour bucket only", () => {
    // now = 11 AM EDT (inside the 15:00Z bucket) — a daylight hour.
    const now = Date.parse("2026-06-01T15:00:00.000Z");
    const s = snapshot({
      ...niceBase,
      city: { flags: ["green"] },
      hourly: hourlyDay(),
      sun: SUN,
      // Observed "now" signals: it's raining and lightning is fresh & nearby.
      nowcast: { state: "raining", text: "Raining now" },
      lightning: {
        windowMinutes: 30,
        nearestMi: 3,
        within10mi: 7,
        within25mi: 7,
        within50mi: 7,
        totalInArea: 7,
        lastMinutesAgo: 3,
      },
    });
    const hrs = computeHourlyScores(s, now);
    const at = (utcHour: number) => hrs.find((h) => new Date(h.time).getUTCHours() === utcHour)!;
    // The current hour (15:00Z) inherits the observed signals -> get-out cap.
    expect(at(15).score).toBeLessThanOrEqual(10);
    // A later, forecast-only hour (16:00Z) is clear and uncapped by those signals.
    expect(at(16).score).toBeGreaterThan(25);
    // (The hourly `raining` flag tracks the forecast code, not the nowcast, so
    // both hours read clear there — the scoping shows up purely in the score.)
    expect(at(16).raining).toBe(false);
  });

  it("scopes 'now' signals to the bucket that CONTAINS now, not the nearest-start one", () => {
    // now = 15:50Z sits inside the 15:00Z bucket, but is only 10 min from the
    // 16:00Z bucket's start vs 50 min from 15:00Z's. A nearest-START selector
    // would wrongly tag 16:00Z as current; containment must pick 15:00Z.
    const now = Date.parse("2026-06-01T15:50:00.000Z");
    const s = snapshot({
      ...niceBase,
      city: { flags: ["green"] },
      hourly: hourlyDay(),
      sun: SUN,
      lightning: {
        windowMinutes: 30,
        nearestMi: 3,
        within10mi: 7,
        within25mi: 7,
        within50mi: 7,
        totalInArea: 7,
        lastMinutesAgo: 3,
      },
    });
    const hrs = computeHourlyScores(s, now);
    const at = (utcHour: number) => hrs.find((h) => new Date(h.time).getUTCHours() === utcHour)!;
    // The CONTAINING bucket (15:00Z) takes the lightning cap...
    expect(at(15).score).toBeLessThanOrEqual(10);
    // ...and the nearer-by-start bucket (16:00Z) does not.
    expect(at(16).score).toBeGreaterThan(25);
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

describe("computeMultiDayWindows", () => {
  // Boca: sunrise ~6:27 AM EDT (10:27Z), sunset ~8:08 PM EDT (00:08Z next day).
  const SUN: SunData = {
    date: "2026-06-01",
    sunrise: "2026-06-01T10:27:00.000Z",
    sunset: "2026-06-02T00:08:00.000Z",
  };
  const niceBase = {
    buoy: NICE.buoy.data,
    weather: NICE.weather.data,
    marine: NICE.marine.data,
    water: { overall: "good" as const, advisory: false, sites: [] },
  };
  // 72h of clear, pleasant weather from 2026-06-01T00:00Z → spans several local days.
  function hourly72(): HourlyMetrics[] {
    const start = Date.parse("2026-06-01T00:00:00.000Z");
    return Array.from({ length: 72 }, (_, i) => ({
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
  const s = snapshot({ ...niceBase, city: { flags: ["green"] }, hourly: hourly72(), sun: SUN });
  const now = Date.parse("2026-06-01T12:00:00.000Z"); // 8 AM EDT on 06-01

  it("returns one entry per upcoming local day, today first, dropping past days", () => {
    const days = computeMultiDayWindows(s, now);
    expect(days.length).toBeGreaterThanOrEqual(2);
    expect(days[0].dow).toBe("Today");
    expect(days[0].date).toBe("2026-06-01");
    // The early-UTC hours that fall on 05-31 local must not produce a past day.
    expect(days.every((d) => d.date >= "2026-06-01")).toBe(true);
    // Future days carry a weekday label, not "Today".
    expect(days.slice(1).every((d) => d.dow !== "Today")).toBe(true);
    // Dates are unique and ascending.
    const dates = days.map((d) => d.date);
    expect(new Set(dates).size).toBe(dates.length);
    expect([...dates].sort()).toEqual(dates);
  });

  it("gives each day a peak score and a daylight best window", () => {
    const days = computeMultiDayWindows(s, now);
    const sunsetH = nyHour(SUN.sunset!); // 20 (8 PM EDT)
    for (const d of days) {
      expect(d.peakScore).not.toBeNull();
      expect(d.peakScore!).toBeGreaterThan(0);
      expect(d.peakScore!).toBeLessThanOrEqual(100);
      if (d.best) {
        expect(nyHour(d.best.startIso)).toBeGreaterThanOrEqual(6); // not pre-sunrise
        expect(nyHour(d.best.endIso)).toBeLessThanOrEqual(sunsetH); // never past sunset, into the dark
        expect(d.peakScore).toBe(d.best.score); // the chip never claims a higher score than the window shown
      }
    }
    // A clear, pleasant future day yields a strong full-day window.
    const future = days.find((d) => d.dow !== "Today")!;
    expect(future.best).not.toBeNull();
    expect(future.peakScore!).toBeGreaterThan(70);
  });

  it("carries a peakBreakdown whose score matches the day's own peakScore, with non-empty consistent-weight subScores", () => {
    const days = computeMultiDayWindows(s, now);
    for (const d of days) {
      expect(d.peakBreakdown).toBeDefined();
      const b = d.peakBreakdown!;
      // The breakdown is computed on computeMultiDayWindows's own output — not
      // any later anchor bump applied elsewhere (lib/conditions.ts) — so it must
      // agree with this function's own peakScore.
      expect(b.score).toBe(d.peakScore);
      expect(b.rating).toBeTruthy();
      expect(b.subScores.length).toBeGreaterThan(0);
      // Weights are the same fixed set scoreBeachDay always assigns.
      const totalWeight = b.subScores.reduce((a, x) => a + x.weight, 0);
      expect(totalWeight).toBeCloseTo(1, 5);
      for (const sc of b.subScores) {
        expect(sc.weight).toBeGreaterThan(0);
        expect(typeof sc.label).toBe("string");
      }
      expect(Array.isArray(b.caps)).toBe(true);
      expect(typeof b.time).toBe("string");
    }
  });

  it("future days exclude today-only seaweed signal from the breakdown (unknown, not carried forward)", () => {
    const withSignals = snapshot({
      ...niceBase,
      city: { flags: ["green"] },
      hourly: hourly72(),
      sun: SUN,
      sargassum: { level: "low", coveragePct: 10, isMorning: true, cams: [] },
    });
    const days = computeMultiDayWindows(withSignals, now);
    const today = days[0];
    expect(today.dow).toBe("Today");
    const todaySeaweed = today.peakBreakdown!.subScores.find((x) => x.key === "sargassum");
    expect(todaySeaweed?.score).not.toBeNull(); // today knows the seaweed read

    const future = days.find((d) => d.dow !== "Today")!;
    const futureSeaweed = future.peakBreakdown!.subScores.find((x) => x.key === "sargassum");
    // Future days score with today-only seaweed unknown (excluded from the
    // average, not carried forward) — the sub-score is present but null.
    expect(futureSeaweed?.score).toBeNull();
  });

  it("respects maxDays and returns [] with no hourly data", () => {
    expect(computeMultiDayWindows(s, now, 1).length).toBe(1);
    expect(computeMultiDayWindows(snapshot({ ...niceBase, sun: SUN }), now)).toEqual([]);
  });

  it("a current severe alert caps TODAY only — it never flat-lines the rest of the week", () => {
    const withWarning = snapshot({
      ...niceBase,
      city: { flags: ["green"] },
      hourly: hourly72(),
      sun: SUN,
      nws: { alerts: [{ event: "Tsunami Warning", severity: "Extreme" }], ripCurrentRisk: "low" },
    });
    const days = computeMultiDayWindows(withWarning, now);
    expect(days[0].dow).toBe("Today");
    expect(days[0].peakScore!).toBeLessThanOrEqual(20); // today is hard-capped by the warning
    const future = days.find((d) => d.dow !== "Today")!;
    expect(future.peakScore!).toBeGreaterThan(70); // future days are unaffected
  });

  it("heavy seaweed caps TODAY only — future days score with seaweed unknown", () => {
    // The cams observe TODAY's beach; we know nothing about next week's seaweed,
    // so today's seaweed ceiling must not flat-line the whole forecast.
    // coveragePct 80 -> ceiling = round(100 - (80-50)*0.75) = 78.
    const withSeaweed = snapshot({
      ...niceBase,
      city: { flags: ["green"] },
      hourly: hourly72(),
      sun: SUN,
      sargassum: { level: "high", coveragePct: 80, isMorning: false, cams: [] },
    });
    const days = computeMultiDayWindows(withSeaweed, now);
    expect(days[0].dow).toBe("Today");
    expect(days[0].peakScore!).toBeLessThanOrEqual(78); // today wears the ceiling
    for (const d of days.filter((x) => x.dow !== "Today")) {
      expect(d.peakScore!).toBeGreaterThan(78); // the week is NOT pinned to the ceiling
    }
  });
});

describe("anchorCurrentHourScore", () => {
  const H = (time: string, score: number): HourlyScore => ({
    time,
    score,
    rating: "Fair",
    emoji: "",
    raining: false,
  });

  it("snaps the bucket containing now to the headline score + rating, leaving others", () => {
    const hourly = [
      H("2026-06-25T13:00:00.000Z", 70),
      H("2026-06-25T14:00:00.000Z", 76),
      H("2026-06-25T15:00:00.000Z", 75),
    ];
    const out = anchorCurrentHourScore(
      hourly,
      { score: 84, rating: "Excellent" },
      Date.parse("2026-06-25T14:30:00.000Z"),
    );
    expect(out[1].score).toBe(84); // the 14:00 bucket contains 14:30
    expect(out[1].rating).toBe("Excellent");
    expect(out[0].score).toBe(70); // neighbours untouched
    expect(out[2].score).toBe(75);
    expect(hourly[1].score).toBe(76); // input not mutated
  });

  it("returns the array unchanged when no bucket contains now (e.g. before sunrise)", () => {
    const hourly = [H("2026-06-25T13:00:00.000Z", 70)];
    const out = anchorCurrentHourScore(
      hourly,
      { score: 84, rating: "Excellent" },
      Date.parse("2026-06-25T20:00:00.000Z"),
    );
    expect(out).toBe(hourly);
  });
});
