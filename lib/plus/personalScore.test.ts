import { describe, expect, it } from "vitest";
import { computeHourlyScores, computeMultiDayWindows, computeScore, DEFAULT_SCORING } from "@/lib/score";
import { resolveScoring } from "@/lib/profile/resolve";
import { computePersonalScore } from "@/lib/plus/personalScore";
import type { ConditionsResponse, ConditionsSnapshot, HourlyMetrics, Wrapped } from "@/lib/types";
import type { ScoreProfile } from "@/lib/profile/types";

// Noon in Florida, which is the middle of a daylight window and inside an
// hourly bucket — so the now-anchor and the today-peak reconciliation both have
// something to act on.
const NOW = Date.parse("2026-09-02T16:00:00Z");
const TZ = "America/New_York";

function wrap<T>(data: T | null): Wrapped<T> {
  return { source: "test", status: data ? "ok" : "error", fetchedAt: "2026-09-02T16:00:00Z", attribution: "test", data };
}

/** Hourly buckets across today's daylight, all identical, all mediocre. */
function hours(over: Partial<HourlyMetrics> = {}): HourlyMetrics[] {
  const out: HourlyMetrics[] = [];
  for (let h = 10; h <= 24; h++) {
    out.push({
      time: new Date(Date.parse("2026-09-02T00:00:00Z") + h * 3_600_000).toISOString(),
      airTempF: 72,
      cloudCoverPct: 85,
      precipProbability: 30,
      weatherCode: 3,
      windSpeedMph: 16,
      uvIndex: 4,
      humidityPct: 80,
      dewPointF: 68,
      soilTempF: 80,
      solarWm2: 300,
      precipIn: 0,
      shortForecast: "Cloudy",
      emoji: "☁️",
      ...over,
    });
  }
  return out;
}

/** A clear, warm, calm day — with clear water, which only a snorkeler is
 *  scored on (clarity carries weight 0 in every other column). */
function snapshot(clarityPct: number | null = 92): ConditionsSnapshot {
  return {
    location: { slug: "boca-raton", name: "Boca Raton", region: "FL", lat: 26.36, lon: -80.07, timezone: TZ },
    generatedAt: "2026-09-02T16:00:00Z",
    tides: wrap(null),
    buoy: wrap({ waterTempF: 84, windSpeedMph: 7, windDirDeg: 90 }),
    weather: wrap({
      airTempF: 84,
      shortForecast: "Sunny",
      precipProbability: 5,
      humidityPct: 58,
      dewPointF: 61,
      isDaytime: true,
    }),
    marine: wrap({ waveHeightFt: 1, uvIndex: 7 }),
    cityOfficial: wrap({ flags: ["green"] }),
    waterQuality: wrap({ overall: "good", advisory: false, sites: [] }),
    nowcast: wrap(null),
    nws: wrap(null),
    traffic: wrap(null),
    airQuality: wrap(null),
    metno: wrap(null),
    gfs: wrap(null),
    lightning: wrap(null),
    goesCloud: wrap(null),
    precipRadar: wrap(null),
    sargassum: wrap(null),
    busyness: wrap(null),
    clarity: wrap(clarityPct == null ? null : { level: "clear", pct: clarityPct }),
    forecast: wrap(null),
    sun: wrap({
      date: "2026-09-02",
      sunrise: "2026-09-02T10:50:00Z",
      sunset: "2026-09-02T23:35:00Z",
    }),
    hourly: wrap(hours()),
  } as unknown as ConditionsSnapshot;
}

/** The response as the server builds it, so the mirror can be compared to it. */
function response(snap: ConditionsSnapshot): ConditionsResponse {
  return {
    snapshot: snap,
    score: computeScore(snap, DEFAULT_SCORING, NOW),
    hourlyScores: computeHourlyScores(snap, NOW),
    multiDayWindows: computeMultiDayWindows(snap, NOW),
    cams: [],
  };
}

const SNORKEL: ScoreProfile = { profiles: ["snorkel"], heat: "normal", crowds: "normal" };

describe("computePersonalScore mirrors the server pipeline", () => {
  it("with the default options it reproduces the shared headline exactly", () => {
    const snap = snapshot();
    const out = computePersonalScore(response(snap), DEFAULT_SCORING, NOW);
    expect(out.score).toEqual(computeScore(snap, DEFAULT_SCORING, NOW));
  });

  it("anchors the current hour to the headline, the way the chart's now-dot needs", () => {
    const out = computePersonalScore(response(snapshot()), DEFAULT_SCORING, NOW);
    const nowDot = out.hourlyScores.find((h) => {
      const t = Date.parse(h.time);
      return t <= NOW && NOW < t + 3_600_000;
    });
    expect(nowDot).toBeDefined();
    expect(nowDot?.score).toBe(out.score.score);
    expect(nowDot?.rating).toBe(out.score.rating);
  });

  it("leaves the raw forecast curve un-anchored for window analysis", () => {
    const out = computePersonalScore(response(snapshot()), DEFAULT_SCORING, NOW);
    expect(out.hourlyScores).not.toBe(out.hourlyForecast);
    const rawNow = out.hourlyForecast.find((h) => {
      const t = Date.parse(h.time);
      return t <= NOW && NOW < t + 3_600_000;
    });
    // The fixture's hourly buckets are deliberately duller than the live
    // consensus, so the two genuinely differ here.
    expect(rawNow?.score).toBeLessThan(out.score.score);
  });

  it("never advertises a today peak below the anchored now-dot", () => {
    const out = computePersonalScore(response(snapshot()), DEFAULT_SCORING, NOW);
    const today = out.multiDayWindows[0];
    const nowDot = out.hourlyScores.find((h) => {
      const t = Date.parse(h.time);
      return t <= NOW && NOW < t + 3_600_000;
    });
    expect(today.dow).toBe("Today");
    expect(nowDot).toBeDefined();
    expect(today.peakScore).toBeGreaterThanOrEqual(nowDot!.score);
    expect(today.peakScore).toBe(out.score.score);
  });
});

describe("the profile actually changes the number", () => {
  it("water clarity moves a snorkeler's number and never moves everyone else's", () => {
    // The honest claim is not "a snorkeler scores differently than the shared
    // number" — on a given fixture the profile's other shifts (its stricter wind
    // ideal, for one) can cancel the clarity credit to the same integer. The claim
    // is that clarity is a live input for the snorkeler and inert for everyone.
    const clear = response(snapshot(92));
    const murky = response(snapshot(20));
    expect(murky.score.score).toBe(clear.score.score); // weight 0 in the shared score
    const snorkelClear = computePersonalScore(clear, resolveScoring(SNORKEL), NOW);
    const snorkelMurky = computePersonalScore(murky, resolveScoring(SNORKEL), NOW);
    expect(snorkelMurky.score.score).toBeLessThan(snorkelClear.score.score);
  });

  it("gives a snorkeler a clarity slice that the shared score does not have", () => {
    const res = response(snapshot(92));
    const personal = computePersonalScore(res, resolveScoring(SNORKEL), NOW);
    expect(personal.score.subScores.some((s) => s.key === "clarity")).toBe(true);
    expect(res.score.subScores.some((s) => s.key === "clarity")).toBe(false);
  });

  it("leaves clarity unscored at a beach with no cam read", () => {
    // The factor is still listed (the profile asked for it) but carries no
    // number, so the engine renormalizes the rest around it — same as every
    // other missing input.
    const res = response(snapshot(null));
    const personal = computePersonalScore(res, resolveScoring(SNORKEL), NOW);
    const clarity = personal.score.subScores.find((s) => s.key === "clarity");
    expect(clarity?.score ?? null).toBeNull();
  });

  it("re-ranks the day's outlook on the personal curve", () => {
    const res = response(snapshot(92));
    const personal = computePersonalScore(res, resolveScoring(SNORKEL), NOW);
    expect(personal.multiDayWindows.length).toBeGreaterThan(0);
    expect(personal.multiDayWindows[0].peakScore).not.toBe(res.multiDayWindows[0].peakScore);
  });

  it("does not mutate the response it was handed", () => {
    const res = response(snapshot(92));
    const before = JSON.stringify(res.multiDayWindows);
    computePersonalScore(res, resolveScoring(SNORKEL), NOW);
    expect(JSON.stringify(res.multiDayWindows)).toBe(before);
  });
});

describe("degraded data", () => {
  it("returns empty curves rather than throwing when there are no hours", () => {
    const snap = snapshot();
    const bare = { ...snap, hourly: wrap(null), sun: wrap(null) } as unknown as ConditionsSnapshot;
    const out = computePersonalScore(response(bare), resolveScoring(SNORKEL), NOW);
    expect(out.hourlyScores).toEqual([]);
    expect(out.multiDayWindows).toEqual([]);
    expect(out.score.score).toBeGreaterThanOrEqual(0);
  });
});
