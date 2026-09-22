// Data-coverage honesty: a beach missing most of its factors (most beaches
// have no cams — see the PROBLEM note in the task that added this) must say
// so and can't read "Excellent"/"Absolutely!" on mostly-missing information.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCORING,
  LIMITED_DATA_CAP,
  computeHourlyScores,
  scoreBeachDay,
  type Derived,
} from "@/lib/score";
import { PRESETS } from "@/lib/profile/presets";
import { SCORE_BANDS, scoreBand } from "@/lib/scoreBands";
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
  SunData,
  TideData,
  TrafficData,
  WaterQualityData,
  WeatherData,
  Wrapped,
} from "@/lib/types";

function opts(over: Partial<ScoringOptions>): ScoringOptions {
  return { ...DEFAULT_SCORING, ...over };
}

const base = (over: Partial<Derived> = {}): Derived => ({
  flags: ["green"],
  waterAdvisory: false,
  waterRating: "good",
  noSwimAdvisory: false,
  ripCurrentRisk: "low",
  severeAlert: false,
  ...over,
});

/** Every factor Everyone's / most profiles weight, reporting. */
const FULL_DAY = base({
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
  sargassumCoveragePct: 0,
  crowdPct: 20,
});

// A beach with no cams: only air/sky/wind/comfort/water/waves/uv/sand
// report — no crowds, no seaweed, no clarity, exactly the 36-of-39-beaches
// shape described in the task. Under Everyone's weights that's 88% complete
// ("full"); under a profile that also weights clarity (snorkel) it drops
// well under 85%.
const NO_CAMS_DAY = base({
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
  // sargassumLevel, crowdPct, clarityPct all left undefined.
});

// A beach reporting almost nothing — only air temp and wind. Everyone's
// weights: (16+13)/100 = 29% complete → limited.
const BARE_DAY = base({ airTempF: 83, windSpeedMph: 8 });

describe("completeness math", () => {
  it("Everyone's profile: a full day is 1.0 / full, uncapped", () => {
    const r = scoreBeachDay(FULL_DAY, DEFAULT_SCORING);
    expect(r.completeness).toBe(1);
    expect(r.dataCoverage).toBe("full");
    expect(r.missingFactors).toEqual([]);
    expect(r.caps.some((c) => /limited data/i.test(c))).toBe(false);
  });

  it("Everyone's profile: no cams (missing crowds+seaweed) is 0.88 / full — clarity weighs 0", () => {
    const r = scoreBeachDay(NO_CAMS_DAY, DEFAULT_SCORING);
    expect(r.completeness).toBe(0.88);
    expect(r.dataCoverage).toBe("full");
    expect(r.missingFactors!.sort()).toEqual(["crowds", "sargassum"]);
  });

  it("Everyone's profile: only air+wind reporting is 0.29 / limited, capped, with a cap string", () => {
    const r = scoreBeachDay(BARE_DAY, DEFAULT_SCORING);
    expect(r.completeness).toBe(0.29);
    expect(r.dataCoverage).toBe("limited");
    expect(r.score).toBeLessThanOrEqual(LIMITED_DATA_CAP);
    expect(r.missingFactors!.length).toBe(8);
    expect(r.caps.some((c) => /limited data.*8 factors unavailable/i.test(c))).toBe(true);
  });

  it("a personal profile (snorkel, which weights clarity) sees the SAME no-cams day as partial", () => {
    const snorkel = opts({
      weights: PRESETS.snorkel.weights,
      ideals: PRESETS.snorkel.ideals,
      capPolicy: PRESETS.snorkel.capPolicy,
    });
    const r = scoreBeachDay(NO_CAMS_DAY, snorkel);
    // snorkel weights: crowds 2 + sargassum 8 + clarity 20 = 30% missing → 0.70.
    expect(r.completeness).toBe(0.7);
    expect(r.dataCoverage).toBe("partial");
    expect(r.missingFactors!.sort()).toEqual(["clarity", "crowds", "sargassum"]);
    // partial never gets the numeric cap or its cap string — label only.
    expect(r.caps.some((c) => /limited data/i.test(c))).toBe(false);
  });
});

describe("provenance-weighted credit (model-only readings count as half)", () => {
  it("Everyone's profile: no-cams day with model-only waves drops from full to partial", () => {
    const modelWaves: Derived = { ...NO_CAMS_DAY, waveHeightSource: { kind: "model" } };
    const r = scoreBeachDay(modelWaves, DEFAULT_SCORING);
    // waves weighs 0.14; half credit removes another 0.07 from the 0.88 the
    // plain NO_CAMS_DAY case gets (see test above) → 0.81.
    expect(r.completeness).toBe(0.81);
    expect(r.dataCoverage).toBe("partial");
    expect(r.estimatedFactors).toEqual(["waves"]);
    expect(r.missingFactors!.sort()).toEqual(["crowds", "sargassum"]);
  });

  it("an observed (buoy) wave reading keeps full credit, unlike a model one", () => {
    const buoyWaves: Derived = { ...NO_CAMS_DAY, waveHeightSource: { kind: "buoy", stationId: "FWYF1" } };
    const r = scoreBeachDay(buoyWaves, DEFAULT_SCORING);
    expect(r.completeness).toBe(0.88);
    expect(r.dataCoverage).toBe("full");
    expect(r.estimatedFactors).toEqual([]);
  });
});

describe("classification uses the unrounded ratio, not the rounded display value", () => {
  const halfOpts = (weights: Partial<Record<import("@/lib/types").SubKey, number>>) =>
    opts({
      weights: {
        airTemp: 0,
        sky: 0,
        wind: 0,
        comfort: 0,
        waterTemp: 0,
        waves: 0,
        sargassum: 0,
        crowds: 0,
        uv: 0,
        sandTemp: 0,
        clarity: 0,
        ...weights,
      },
    });

  it("0.596 (rounds to display 0.60, at the partial floor) still classifies limited", () => {
    const r = scoreBeachDay(
      base({ airTempF: 83 }),
      halfOpts({ airTemp: 596, sky: 404 }),
    );
    expect(r.completeness).toBe(0.6); // rounded display value
    expect(r.dataCoverage).toBe("limited"); // unrounded 0.596 < 0.60
  });

  it("0.846 (rounds to display 0.85, at the full floor) still classifies partial", () => {
    const r = scoreBeachDay(
      base({ airTempF: 83 }),
      halfOpts({ airTemp: 846, sky: 154 }),
    );
    expect(r.completeness).toBe(0.85); // rounded display value
    expect(r.dataCoverage).toBe("partial"); // unrounded 0.846 < 0.85
  });
});

describe("data-coverage cap sits below the second-best band (band-edge assertion)", () => {
  it("LIMITED_DATA_CAP is one under the 'Yes — good beach day' band floor", () => {
    const yesBand = SCORE_BANDS.find((b) => b.verdict === "Yes — good beach day")!;
    expect(LIMITED_DATA_CAP).toBe(yesBand.min - 1);
    expect(scoreBand(LIMITED_DATA_CAP).verdict).not.toBe("Yes — good beach day");
    expect(scoreBand(LIMITED_DATA_CAP).verdict).not.toBe("Absolutely!");
    expect(scoreBand(LIMITED_DATA_CAP + 1).verdict).toBe("Yes — good beach day");
  });

  it("a limited day never reaches the Excellent/Good rating even with a perfect raw score", () => {
    // FULL_DAY minus everything but the two factors BARE_DAY has, but with
    // ideal readings, so the raw weighted score would otherwise be ~100.
    const r = scoreBeachDay(base({ airTempF: 83, windSpeedMph: 8 }), DEFAULT_SCORING);
    expect(r.rawScore).toBeGreaterThan(90);
    expect(r.score).toBeLessThanOrEqual(LIMITED_DATA_CAP);
    expect(r.rating).not.toBe("Excellent");
    expect(r.rating).not.toBe("Good");
  });
});

function wrap<T>(data: T | null): Wrapped<T> {
  return {
    source: "test",
    status: data ? "ok" : "error",
    fetchedAt: new Date().toISOString(),
    attribution: "test",
    data,
  };
}

describe("hourly buckets agree with the headline (same rule, same cap)", () => {
  it("scoreAllHours/computeHourlyScores caps a limited hour exactly like scoreBeachDay does", () => {
    const SUN: SunData = {
      date: "2026-06-01",
      sunrise: "2026-06-01T10:27:00.000Z",
      sunset: "2026-06-02T00:08:00.000Z",
    };
    const hourly: HourlyMetrics[] = Array.from({ length: 3 }, (_, i) => ({
      time: new Date(Date.parse("2026-06-01T12:00:00.000Z") + i * 3_600_000).toISOString(),
      // Only air temp + wind report per hour — same bare shape as BARE_DAY —
      // no cloud/precip/UV/soil, and the snapshot below carries no
      // marine/buoy/water/busyness/sargassum data either.
      airTempF: 83,
      windSpeedMph: 8,
    }));
    const snap: ConditionsSnapshot = {
      location: { slug: "boca-raton", name: "Boca Raton", region: "FL", lat: 26.36, lon: -80.07, timezone: "America/New_York" },
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
      clarity: wrap<ClarityData>(null),
      forecast: wrap<ForecastDay[]>(null),
      sun: wrap(SUN),
      hourly: wrap(hourly),
    };
    const now = Date.parse("2026-06-01T12:30:00.000Z");
    const hrs = computeHourlyScores(snap, now, DEFAULT_SCORING);
    expect(hrs.length).toBeGreaterThan(0);
    for (const h of hrs) {
      expect(h.score).toBeLessThanOrEqual(LIMITED_DATA_CAP);
    }
  });
});
