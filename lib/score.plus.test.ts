// Beach Day Plus: the scoring engine as a parameter, not a rewrite.
// lib/score.test.ts pins the free score; this file pins everything the profile
// dials add on top of it — and that the default still produces the free score.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCORING,
  anchorCurrentHourScore,
  applyBeachCaps,
  computeHourlyScores,
  computeMultiDayWindows,
  deriveMetrics,
  scoreBeachDay,
  type Derived,
} from "@/lib/score";
import { resolveScoring } from "@/lib/profile/resolve";
import type { ProfileId } from "@/lib/profile/types";
import type {
  AirQualityData,
  BuoyData,
  BusynessData,
  CityOfficialData,
  ClarityData,
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
  ScoringOptions,
  SubKey,
  SunData,
  TideData,
  TrafficData,
  WaterQualityData,
  WaveMode,
  WeatherData,
  Wrapped,
} from "@/lib/types";

const base = (over: Partial<Derived> = {}): Derived => ({
  flags: ["green"],
  waterAdvisory: false,
  waterRating: "good",
  noSwimAdvisory: false,
  ripCurrentRisk: "low",
  severeAlert: false,
  ...over,
});

/** A lovely day: everything scores high, nothing caps. Raw ≈ 97. */
const NICE_DAY = base({
  airTempF: 83,
  waterTempF: 82,
  windSpeedMph: 8,
  waveHeightFt: 1,
  cloudCoverPct: 10,
  precipProbability: 5,
  shortForecast: "Sunny",
  humidityPct: 60,
  dewPointF: 62,
  uvIndex: 6,
  sandTempF: 100,
  sargassumLevel: "none",
  crowdPct: 20,
});

/** A storm day: caps everywhere. */
const STORM_DAY = base({
  airTempF: 76,
  waterTempF: 80,
  windSpeedMph: 24,
  waveHeightFt: 6,
  cloudCoverPct: 95,
  precipProbability: 85,
  shortForecast: "Thunderstorms likely",
  weatherCode: 95,
  humidityPct: 92,
  dewPointF: 76,
  uvIndex: 3,
  sandTempF: 88,
  sargassumLevel: "moderate",
  sargassumCoveragePct: 40,
  crowdPct: 10,
  ripCurrentRisk: "high",
  flags: ["red"],
});

/** A middling day with partial data — the "some feeds are down" shape. */
const THIN_DAY = base({
  airTempF: 90,
  windSpeedMph: 16,
  waveHeightFt: 3,
  cloudCoverPct: 55,
  precipProbability: 30,
  sandTempF: 122,
  crowdPct: 70,
});

const opts = (over: Partial<ScoringOptions>): ScoringOptions => ({
  ...DEFAULT_SCORING,
  ...over,
});
const waveOpts = (waveMode: WaveMode): ScoringOptions =>
  opts({ ideals: { ...DEFAULT_SCORING.ideals, waveMode } });

describe("DEFAULT_SCORING is the free score", () => {
  it("scores three very different days identically with and without options", () => {
    for (const d of [NICE_DAY, STORM_DAY, THIN_DAY]) {
      expect(scoreBeachDay(d, DEFAULT_SCORING)).toEqual(scoreBeachDay(d));
      expect(scoreBeachDay(d, resolveScoring(null))).toEqual(scoreBeachDay(d));
    }
  });

  it("keeps the same ten sub-scores, in the same order — clarity weighs 0", () => {
    const keys = scoreBeachDay(NICE_DAY).subScores.map((s) => s.key);
    expect(keys).toEqual([
      "airTemp",
      "sky",
      "wind",
      "comfort",
      "waterTemp",
      "waves",
      "sargassum",
      "crowds",
      "uv",
      "sandTemp",
    ]);
    expect(DEFAULT_SCORING.weights.clarity).toBe(0);
  });

  it("a clarity reading cannot move the free score", () => {
    const clear = scoreBeachDay({ ...NICE_DAY, clarityPct: 95 });
    const murky = scoreBeachDay({ ...NICE_DAY, clarityPct: 10 });
    expect(clear).toEqual(scoreBeachDay(NICE_DAY));
    expect(murky.score).toBe(clear.score);
    expect(murky.subScores.some((s) => s.key === "clarity")).toBe(false);
  });
});

describe("water clarity as a factor", () => {
  const snorkel = resolveScoring({ profiles: ["snorkel"], heat: "normal", crowds: "normal" });

  it("is a scored slice for snorkeling, labelled in plain English", () => {
    const r = scoreBeachDay({ ...NICE_DAY, clarityPct: 90 }, snorkel);
    const sub = r.subScores.find((s) => s.key === "clarity");
    expect(sub?.label).toBe("Water clarity");
    expect(sub?.score).toBe(90);
    expect(sub?.display).toBe("~90% clear");
  });

  it("murky water costs a snorkeler real points", () => {
    const clear = scoreBeachDay({ ...NICE_DAY, clarityPct: 95 }, snorkel).score;
    const murky = scoreBeachDay({ ...NICE_DAY, clarityPct: 15 }, snorkel).score;
    expect(clear).toBeGreaterThan(murky + 10);
  });

  it("drops out with no reading — the other factors renormalize", () => {
    const noRead = scoreBeachDay(NICE_DAY, snorkel);
    const clarityUnweighted = scoreBeachDay(
      NICE_DAY,
      opts({ ...snorkel, weights: { ...snorkel.weights, clarity: 0 } }),
    );
    expect(noRead.subScores.find((s) => s.key === "clarity")?.score).toBeNull();
    expect(noRead.score).toBe(clarityUnweighted.score);
  });

  it("reads the cam clarity percentage off the snapshot", () => {
    expect(deriveMetrics(snapshot(65)).clarityPct).toBe(65);
    expect(deriveMetrics(snapshot(null)).clarityPct).toBeUndefined();
  });
});

describe("wave curves", () => {
  // With waves as the only available factor, the score IS the wave sub-score.
  const waveAt = (ft: number, mode: WaveMode) =>
    scoreBeachDay(base({ waveHeightFt: ft }), waveOpts(mode)).score;

  it("calm: flat water is perfect and every foot costs (today's curve)", () => {
    expect(waveAt(1, "calm")).toBe(100);
    expect(waveAt(3, "calm")).toBe(50);
    expect(waveAt(5, "calm")).toBe(0);
  });

  it("some: 1-3 ft is perfect, with a gentle falloff either side", () => {
    expect(waveAt(1, "some")).toBe(100);
    expect(waveAt(2, "some")).toBe(100);
    expect(waveAt(3, "some")).toBe(100);
    expect(waveAt(0, "some")).toBe(80);
    expect(waveAt(5, "some")).toBe(60);
    expect(waveAt(8, "some")).toBe(0);
    // Gentler than the calm curve everywhere above the plateau.
    expect(waveAt(4, "some")).toBeGreaterThan(waveAt(4, "calm"));
  });

  it("surf: 2-5 ft is perfect, ankle-slappers ~30, over 7 ft ~40", () => {
    expect(waveAt(2, "surf")).toBe(100);
    expect(waveAt(5, "surf")).toBe(100);
    expect(waveAt(0.5, "surf")).toBe(30);
    expect(waveAt(7, "surf")).toBe(40);
    expect(waveAt(9, "surf")).toBeLessThan(40);
    // The whole point of the flip: a 3 ft day is a bust for swimming, a gift
    // for surfing — and dead flat is the other way round.
    expect(waveAt(3, "surf")).toBeGreaterThan(waveAt(3, "calm"));
    expect(waveAt(0.5, "calm")).toBeGreaterThan(waveAt(0.5, "surf"));
  });
});

describe("cap policies", () => {
  const nice = () => ({ ...NICE_DAY });
  const scoreWith = (d: Derived, policy: ScoringOptions["capPolicy"]) =>
    scoreBeachDay(d, opts({ capPolicy: policy }));

  it("a red flag caps a swimmer, not a sunbather or a surfer", () => {
    const d = { ...nice(), flags: ["red" as const] };
    expect(scoreWith(d, "water").score).toBe(85);
    expect(scoreWith(d, "water").caps.join(" ")).toMatch(/Red flag/);
    expect(scoreWith(d, "shore").score).toBeGreaterThan(85);
    expect(scoreWith(d, "shore").caps).toEqual([]);
    expect(scoreWith(d, "surf").score).toBeGreaterThan(85);
    expect(scoreWith(d, "surf").caps).toEqual([]);
  });

  it("a double red closes the beach for everyone", () => {
    const d = { ...nice(), flags: ["double-red" as const] };
    for (const policy of ["water", "shore", "surf"] as const) {
      const r = scoreWith(d, policy);
      if (policy === "shore") {
        // The sand is still open — but the water is closed, so the safety line
        // (not the score) carries it. Weather caps only for the shore policy.
        expect(r.score).toBeGreaterThan(85);
      } else {
        expect(r.score).toBe(5);
        expect(r.caps.join(" ")).toMatch(/Double red/);
      }
    }
  });

  it("rip current and a surf advisory cap swimmers only", () => {
    const rip = { ...nice(), ripCurrentRisk: "high" as const };
    expect(scoreWith(rip, "water").score).toBe(85);
    expect(scoreWith(rip, "surf").score).toBeGreaterThan(85);
    expect(scoreWith(rip, "shore").score).toBeGreaterThan(85);

    const advisory = { ...nice(), surfAdvisory: true };
    expect(scoreWith(advisory, "water").score).toBe(85);
    expect(scoreWith(advisory, "surf").score).toBeGreaterThan(85);
  });

  it("dirty water and a city no-swim stop swimmers and surfers, not the sand", () => {
    const dirty = { ...nice(), waterAdvisory: true };
    expect(scoreWith(dirty, "water").score).toBe(40);
    expect(scoreWith(dirty, "surf").score).toBe(40);
    expect(scoreWith(dirty, "shore").score).toBeGreaterThan(85);

    const noSwim = { ...nice(), noSwimAdvisory: true };
    expect(scoreWith(noSwim, "water").score).toBe(40);
    expect(scoreWith(noSwim, "surf").score).toBe(40);
    expect(scoreWith(noSwim, "shore").score).toBeGreaterThan(85);
  });

  it("weather caps apply to every policy", () => {
    const cases: [Partial<Derived>, number][] = [
      [{ lightningWithin5mi: true }, 10],
      [{ severeAlert: true }, 15],
      [{ windSpeedMph: 25 }, 15],
      [{ shortForecast: "Thunderstorms", weatherCode: 95, precipProbability: 80 }, 15],
      [{ shortForecast: "Rain", weatherCode: 61, precipProbability: 80 }, 25],
      [{ nowcastRaining: true }, 25],
    ];
    for (const [over, ceiling] of cases) {
      for (const policy of ["water", "shore", "surf"] as const) {
        expect(scoreWith({ ...nice(), ...over }, policy).score).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  it("the seaweed ceiling applies to every policy", () => {
    const weedy = { ...nice(), sargassumLevel: "high" as const, sargassumCoveragePct: 95 };
    for (const policy of ["water", "shore", "surf"] as const) {
      expect(scoreWith(weedy, policy).score).toBeLessThanOrEqual(70);
    }
  });

  it("applyBeachCaps defaults to the swimmer's policy (today's behavior)", () => {
    const d = { ...nice(), flags: ["red" as const] };
    expect(applyBeachCaps(97, d)).toEqual(applyBeachCaps(97, d, "water"));
    expect(applyBeachCaps(97, d).score).toBe(85);
  });
});

describe("presets move a day in the direction they should", () => {
  const resolve = (id: ProfileId) =>
    resolveScoring({ profiles: [id], heat: "normal", crowds: "normal" });

  it("a 3 ft day is better for surfing than for swimming", () => {
    const day = { ...NICE_DAY, waveHeightFt: 3 };
    expect(scoreBeachDay(day, resolve("surf")).score).toBeGreaterThan(
      scoreBeachDay(day, resolve("swim")).score,
    );
  });

  it("glassy 0.5 ft water is better for swimming than for surfing", () => {
    const day = { ...NICE_DAY, waveHeightFt: 0.5 };
    expect(scoreBeachDay(day, resolve("swim")).score).toBeGreaterThan(
      scoreBeachDay(day, resolve("surf")).score,
    );
  });

  it("120°F sand is far worse for a dog than for a sunbather", () => {
    const day = { ...NICE_DAY, sandTempF: 120 };
    expect(scoreBeachDay(day, resolve("dog")).score).toBeLessThan(
      scoreBeachDay(day, resolve("sun")).score,
    );
  });

  it("a hot 92°F day suits sunbathing better than a beach walk", () => {
    const day = { ...NICE_DAY, airTempF: 92, sandTempF: 100 };
    expect(scoreBeachDay(day, resolve("sun")).score).toBeGreaterThan(
      scoreBeachDay(day, resolve("walk")).score,
    );
  });

  it("clear water lifts snorkeling above the everyone score", () => {
    const day = { ...NICE_DAY, clarityPct: 95 };
    const snorkel = scoreBeachDay(day, resolve("snorkel")).score;
    const everyone = scoreBeachDay(day).score;
    expect(snorkel).toBeGreaterThanOrEqual(everyone);
    const murkyDay = { ...NICE_DAY, clarityPct: 15 };
    expect(scoreBeachDay(murkyDay, resolve("snorkel")).score).toBeLessThan(
      scoreBeachDay(murkyDay).score,
    );
  });

  it("chilly 71°F water costs a swimmer more than a dog walker", () => {
    const day = { ...NICE_DAY, waterTempF: 71 };
    const swimLoss = scoreBeachDay(NICE_DAY, resolve("swim")).score - scoreBeachDay(day, resolve("swim")).score;
    const dogLoss = scoreBeachDay(NICE_DAY, resolve("dog")).score - scoreBeachDay(day, resolve("dog")).score;
    expect(swimLoss).toBeGreaterThan(dogLoss);
  });

  it("a busy beach costs more when crowds bother you", () => {
    const day = { ...NICE_DAY, crowdPct: 95 };
    const hate = resolveScoring({ profiles: ["walk"], heat: "normal", crowds: "high" });
    const shrug = resolveScoring({ profiles: ["walk"], heat: "normal", crowds: "low" });
    expect(scoreBeachDay(day, hate).score).toBeLessThan(scoreBeachDay(day, shrug).score);
  });

  it("the heat dial changes which day feels perfect", () => {
    const hotDay = { ...NICE_DAY, airTempF: 92 };
    const likesHeat = resolveScoring({ profiles: ["swim"], heat: "hot", crowds: "normal" });
    const likesCool = resolveScoring({ profiles: ["swim"], heat: "cooler", crowds: "normal" });
    expect(scoreBeachDay(hotDay, likesHeat).score).toBeGreaterThan(
      scoreBeachDay(hotDay, likesCool).score,
    );
  });

  it("every preset still produces a real 0-100 score on every fixture day", () => {
    for (const id of ["swim", "kids", "sun", "snorkel", "dog", "walk", "surf"] as ProfileId[]) {
      for (const day of [NICE_DAY, STORM_DAY, THIN_DAY]) {
        const r = scoreBeachDay(day, resolve(id));
        expect(r.score).toBeGreaterThanOrEqual(0);
        expect(r.score).toBeLessThanOrEqual(100);
        const total = r.subScores.reduce((a, s) => a + s.weight, 0);
        expect(total).toBeGreaterThan(0.9);
        expect(total).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it("never shows a slice that cannot move the score", () => {
    const noWaves = resolveScoring({
      profiles: ["sun"],
      heat: "normal",
      crowds: "normal",
      advanced: { mult: { waves: 0 } },
    });
    const keys = scoreBeachDay(NICE_DAY, noWaves).subScores.map((s) => s.key as SubKey);
    expect(keys).not.toContain("waves");
    expect(keys).not.toContain("clarity");
    expect(keys).toContain("sky");
  });
});

describe("the whole forecast runs on the same options", () => {
  // 2026-07-01, noon in Boca (16:00 UTC).
  const NOW = Date.parse("2026-07-01T16:00:00Z");
  const hours: HourlyMetrics[] = Array.from({ length: 30 }, (_, i) => ({
    time: new Date(Date.parse("2026-07-01T11:00:00Z") + i * 3_600_000).toISOString(),
    airTempF: 84,
    cloudCoverPct: 15,
    precipProbability: 10,
    windSpeedMph: 9,
    uvIndex: 7,
    humidityPct: 62,
    dewPointF: 64,
    soilTempF: 100,
    solarWm2: 700,
    precipIn: 0,
    shortForecast: "Sunny",
    emoji: "☀️",
  }));
  const surf = resolveScoring({ profiles: ["surf"], heat: "normal", crowds: "normal" });
  const s = forecastSnapshot(hours);

  it("hourly scores: the default is today's, a profile changes them", () => {
    const free = computeHourlyScores(s, NOW);
    expect(computeHourlyScores(s, NOW, DEFAULT_SCORING)).toEqual(free);
    const personal = computeHourlyScores(s, NOW, surf);
    expect(personal).toHaveLength(free.length);
    expect(free.length).toBeGreaterThan(0);
    // A 3 ft swell: a bust for swimming, the point of the day for a surfer.
    expect(personal.every((h, i) => h.score > free[i].score)).toBe(true);
  });

  it("multi-day windows: the default is today's, a profile changes them", () => {
    const free = computeMultiDayWindows(s, NOW);
    expect(computeMultiDayWindows(s, NOW, 7, DEFAULT_SCORING)).toEqual(free);
    const personal = computeMultiDayWindows(s, NOW, 7, surf);
    expect(personal[0].peakScore).toBeGreaterThan(Number(free[0].peakScore));
    expect(personal[0].peakBreakdown?.subScores.map((x) => x.key)).toContain("waves");
  });

  it("anchoring still snaps the current hour to whatever headline it is given", () => {
    const free = computeHourlyScores(s, NOW);
    const anchored = anchorCurrentHourScore(free, { score: 42, rating: "Fair" }, NOW, surf);
    const nowHour = anchored.find((h) => {
      const t = Date.parse(h.time);
      return t <= NOW && NOW < t + 3_600_000;
    });
    expect(nowHour?.score).toBe(42);
  });
});

// --- a minimal snapshot, just enough for deriveMetrics ----------------------
function wrap<T>(data: T | null): Wrapped<T> {
  return { source: "test", status: data ? "ok" : "error", fetchedAt: "", attribution: "test", data };
}
function snapshot(clarityPct: number | null): ConditionsSnapshot {
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
    buoy: wrap<BuoyData>(null),
    weather: wrap<WeatherData>(null),
    marine: wrap<MarineData>(null),
    cityOfficial: wrap<CityOfficialData>(null),
    waterQuality: wrap<WaterQualityData>(null),
    nowcast: wrap<NowcastData>(null),
    nws: wrap<NwsData>(null),
    traffic: wrap<TrafficData>(null),
    airQuality: wrap<AirQualityData>(null),
    metno: wrap<MetnoCurrent>(null),
    gfs: wrap<MetnoCurrent>(null),
    lightning: wrap<LightningData>(null),
    goesCloud: wrap<GoesCloudData>(null),
    precipRadar: wrap<PrecipRadarData>(null),
    sargassum: wrap<SargassumData>(null),
    busyness: wrap<BusynessData>(null),
    clarity: wrap<ClarityData>({ level: "clear", pct: clarityPct }),
    forecast: wrap<ForecastDay[]>(null),
    sun: wrap<SunData>(null),
    hourly: wrap<HourlyMetrics[]>(null),
  };
}

/** The same snapshot plus a 3 ft swell, sun times, and a multi-day hourly feed. */
function forecastSnapshot(hours: HourlyMetrics[]): ConditionsSnapshot {
  return {
    ...snapshot(null),
    marine: wrap<MarineData>({ waveHeightFt: 3, seaSurfaceTempF: 82 }),
    sun: wrap<SunData>({
      date: "2026-07-01",
      sunrise: "2026-07-01T10:30:00Z", // 6:30 AM ET
      sunset: "2026-07-02T00:15:00Z", // 8:15 PM ET
    }),
    hourly: wrap<HourlyMetrics[]>(hours),
  };
}
