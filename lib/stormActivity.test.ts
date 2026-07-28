import { describe, it, expect } from "vitest";
import { computeStormActivity, type StormActivityInput } from "@/lib/stormActivity";
import type { LightningData, PrecipRadarData, SourceStatus, Wrapped } from "@/lib/types";

function wrapLightning(
  data: LightningData | null,
  status: SourceStatus = data ? "ok" : "error",
): Wrapped<LightningData> {
  return {
    source: "test",
    status,
    fetchedAt: new Date().toISOString(),
    attribution: "test",
    data,
  };
}

function lightning(over: Partial<LightningData> = {}): LightningData {
  return {
    within10mi: 0,
    within20mi: 0,
    within25mi: 0,
    within50mi: 0,
    totalInArea: 0,
    stormEnergy: 0,
    dataAgeMinutes: 2,
    ...over,
  };
}

function input(over: Partial<StormActivityInput>): StormActivityInput {
  return {
    lightning: wrapLightning(lightning()),
    ...over,
  };
}

describe("computeStormActivity", () => {
  it("worked example: calm day scores 0 / Calm", () => {
    const r = computeStormActivity(
      input({
        lightning: wrapLightning(lightning({ stormEnergy: 0, totalInArea: 0 })),
        precipIn: 0,
        weatherCode: 0,
        precipProbability: 0,
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.score).toBe(0);
    expect(r!.band).toBe("Calm");
  });

  it("worked example: distant storm (~2.2 energy, 15 mi fresh, 0.05 in/hr) is ~43 / Unsettled", () => {
    const r = computeStormActivity(
      input({
        lightning: wrapLightning(
          lightning({
            stormEnergy: 2.2,
            nearestMi: 15,
            nearestMinutesAgo: 5,
            lastMinutesAgo: 5,
          }),
        ),
        precipIn: 0.05,
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.score).toBe(43);
    expect(r!.band).toBe("Unsettled");
  });

  it("worked example: overhead storm (~12 energy, 2 mi fresh, 0.4 in/hr + corroborated code 95) is >=90 / Severe", () => {
    const r = computeStormActivity(
      input({
        lightning: wrapLightning(
          lightning({
            stormEnergy: 12,
            nearestMi: 2,
            nearestMinutesAgo: 3,
            lastMinutesAgo: 3,
          }),
        ),
        precipIn: 0.4,
        weatherCode: 95,
        precipProbability: 80,
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.score).toBeGreaterThanOrEqual(90);
    expect(r!.band).toBe("Severe");
  });

  it("floors the score at 90 when a fresh strike lands within 5 mi, even with a mild raw blend", () => {
    const r = computeStormActivity(
      input({
        lightning: wrapLightning(
          lightning({ stormEnergy: 0.2, nearestMi: 3, nearestMinutesAgo: 10, lastMinutesAgo: 10 }),
        ),
        precipIn: 0,
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.score).toBeGreaterThanOrEqual(90);
    expect(r!.band).toBe("Severe");
  });

  it("does not count proximity when the nearest strike is stale (>20 min old)", () => {
    const r = computeStormActivity(
      input({
        lightning: wrapLightning(
          lightning({ stormEnergy: 0, nearestMi: 1, nearestMinutesAgo: 45, lastMinutesAgo: 45 }),
        ),
        precipIn: 0,
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.parts.proximity).toBe(0);
    expect(r!.score).toBe(0);
    expect(r!.band).toBe("Calm");
  });

  it("returns null when the lightning feed errored and there's no rain signal", () => {
    const r = computeStormActivity(
      input({
        lightning: wrapLightning(null, "error"),
      }),
    );
    expect(r).toBeNull();
  });

  it("returns null when the lightning feed is stale and rain alone would only read Calm", () => {
    const r = computeStormActivity(
      input({
        lightning: wrapLightning(lightning({ stormEnergy: 8, nearestMi: 1, nearestMinutesAgo: 2 }), "stale"),
        precipIn: 0.01, // rain-only score is low (Calm band)
      }),
    );
    expect(r).toBeNull();
  });

  it("still surfaces the metric when the lightning feed is down but rain data alone shows real activity", () => {
    const r = computeStormActivity(
      input({
        lightning: wrapLightning(null, "error"),
        precipIn: 0.4,
        weatherCode: 96,
        precipProbability: 90,
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.parts.strikes).toBeNull();
    expect(r!.parts.proximity).toBeNull();
    expect(r!.parts.rain).not.toBeNull();
    expect(r!.band).not.toBe("Calm");
  });

  it("treats a GLM snapshot older than 30 min as unknown even when the fetch status is ok", () => {
    const r = computeStormActivity(
      input({
        // nearestMi=15 keeps this outside the 5-mi safety-floor radius, so the
        // test isolates the "stale snapshot -> unknown" behavior on its own.
        lightning: wrapLightning(
          lightning({ stormEnergy: 10, nearestMi: 15, nearestMinutesAgo: 5, dataAgeMinutes: 45 }),
        ),
        precipIn: 0.01, // rain-only estimate lands in Calm
      }),
    );
    expect(r).toBeNull();
  });

  it("floors rain at 70 when a corroborated thunderstorm code backs the current hour", () => {
    const r = computeStormActivity(
      input({
        lightning: wrapLightning(lightning()),
        precipIn: 0, // no measurable precip yet
        weatherCode: 99,
        precipProbability: 30,
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.parts.rain).toBe(70);
  });

  it("does not floor rain when the storm code isn't corroborated by precip probability", () => {
    const r = computeStormActivity(
      input({
        lightning: wrapLightning(lightning()),
        precipIn: 0,
        weatherCode: 95,
        precipProbability: 5, // below the 25% corroboration bar
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.parts.rain).toBe(0);
    expect(r!.band).toBe("Calm");
  });
});

// --- Radar-observed rain term (NOAA MRMS) ------------------------------------
// The 0.20 rain weight is unchanged; what changed is what it MEASURES. When a
// fresh radar read exists it replaces the forecast hour's precip, because an
// observation of where the rain physically is beats a model's guess that it
// might be there.

function wrapRadar(
  data: Partial<PrecipRadarData> | null,
  status: SourceStatus = data ? "ok" : "error",
): Wrapped<PrecipRadarData> {
  return {
    source: "test",
    status,
    fetchedAt: new Date().toISOString(),
    attribution: "NOAA MRMS (radar observation)",
    data: data
      ? {
          rainNowMmHr: 0,
          nearestRainKm: null,
          nearestBearingDeg: null,
          coveragePct: 0,
          motion: null,
          etaMinutes: null,
          frameIso: new Date().toISOString(),
          framesUsed: 3,
          frameAgeMinutes: 2,
          ...data,
        }
      : null,
  };
}

describe("computeStormActivity: radar-observed rain", () => {
  it("prefers a fresh radar observation over the forecast hour", () => {
    // Forecast says bone dry; radar sees 6.5 mm/hr falling on the beach.
    const r = computeStormActivity(
      input({
        precipIn: 0,
        precipRadar: wrapRadar({ rainNowMmHr: 6.5, coveragePct: 0 }),
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.parts.rain).toBeCloseTo(75, 5); // the ~0.25 in/hr anchor
    expect(r!.rainFromRadar).toBe(true);
  });

  it("falls back to exactly today's forecast behavior when radar is absent", () => {
    const withoutField = computeStormActivity(input({ precipIn: 0.1 }));
    const withNullRadar = computeStormActivity(
      input({ precipIn: 0.1, precipRadar: wrapRadar(null) }),
    );
    expect(withoutField!.parts.rain).toBe(50);
    expect(withNullRadar!.parts.rain).toBe(50);
    expect(withNullRadar!.rainFromRadar).toBe(false);
  });

  it("ignores a STALE radar feed and uses the forecast instead", () => {
    const r = computeStormActivity(
      input({
        precipIn: 0.1,
        precipRadar: wrapRadar({ rainNowMmHr: 12.5 }, "stale"),
      }),
    );
    expect(r!.parts.rain).toBe(50); // the forecast's 0.1 in/hr, not radar's 100
    expect(r!.rainFromRadar).toBe(false);
  });

  it("ignores a radar frame older than the 25-min gate even when status is ok", () => {
    const r = computeStormActivity(
      input({
        precipIn: 0.1,
        precipRadar: wrapRadar({ rainNowMmHr: 12.5, frameAgeMinutes: 40 }),
      }),
    );
    expect(r!.parts.rain).toBe(50);
    expect(r!.rainFromRadar).toBe(false);
  });

  it("catches a beach sitting in a dry slot inside a wall-to-wall squall", () => {
    // Nothing falling at the beach pixel, but 85% of the box is raining.
    // Coverage must carry the term — a point reading alone would miss this.
    const r = computeStormActivity(
      input({ precipIn: 0, precipRadar: wrapRadar({ rainNowMmHr: 0, coveragePct: 85 }) }),
    );
    expect(r!.parts.rain).toBeCloseTo(100, 5);
  });

  it("takes the max of rate and coverage, not their average", () => {
    // A downpour overhead with clear air around it is still a downpour.
    const r = computeStormActivity(
      input({ precipRadar: wrapRadar({ rainNowMmHr: 12.5, coveragePct: 0 }) }),
    );
    expect(r!.parts.rain).toBeCloseTo(100, 5);
  });

  it("reports an observed-dry beach as 0 rain (radar 0 is a reading, not a gap)", () => {
    const r = computeStormActivity(
      input({
        precipIn: 0.25, // forecast insists it's pouring
        precipRadar: wrapRadar({ rainNowMmHr: 0, coveragePct: 0 }),
      }),
    );
    expect(r!.parts.rain).toBe(0);
    expect(r!.rainFromRadar).toBe(true);
  });

  it("keeps the corroborated-thunderstorm floor on top of the radar term", () => {
    // Radar sees no rain at the beach yet, but a corroborated storm code says
    // there's an active thunderstorm — the 70 floor still applies.
    const r = computeStormActivity(
      input({
        precipIn: 0,
        weatherCode: 95,
        precipProbability: 60,
        precipRadar: wrapRadar({ rainNowMmHr: 0, coveragePct: 0 }),
      }),
    );
    expect(r!.parts.rain).toBe(70);
  });

  it("still returns null when lightning is down and radar rain alone reads Calm", () => {
    // The unknown-lightning honesty rule is untouched by the radar upgrade.
    const r = computeStormActivity(
      input({
        lightning: wrapLightning(null),
        precipRadar: wrapRadar({ rainNowMmHr: 0, coveragePct: 0 }),
      }),
    );
    expect(r).toBeNull();
  });

  it("shows the metric when lightning is down but radar alone proves a storm", () => {
    const r = computeStormActivity(
      input({
        lightning: wrapLightning(null),
        precipRadar: wrapRadar({ rainNowMmHr: 12.5, coveragePct: 90 }),
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.band).not.toBe("Calm");
    expect(r!.rainFromRadar).toBe(true);
  });

  it("does not change the weight of the rain term (still 0.20 of the blend)", () => {
    // Radar-max rain, nothing else: 100 * 0.20 / 1.00 weight sum over the three
    // available parts => the same 20 the forecast path would produce.
    const viaRadar = computeStormActivity(
      input({ precipRadar: wrapRadar({ rainNowMmHr: 12.5 }) }),
    );
    const viaForecast = computeStormActivity(input({ precipIn: 0.5 }));
    expect(viaRadar!.score).toBe(viaForecast!.score);
  });
});
