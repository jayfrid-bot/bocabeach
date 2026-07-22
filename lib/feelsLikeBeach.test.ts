import { describe, expect, it } from "vitest";
import {
  feelsLikeBand,
  feelsLikeBandInfo,
  feelsLikeBeach,
  heatIndexF,
  sandRadiantF,
  solarRadiantF,
  windCoolingF,
} from "@/lib/feelsLikeBeach";

describe("heatIndexF", () => {
  it("matches the classic NWS anchor: 90°F / 70% RH → ~105-106°F", () => {
    // The textbook NWS heat-index table entry for 90°F/70% RH is 105-106°F.
    expect(heatIndexF(90, 70)).toBeCloseTo(105.9, 0);
  });

  it("uses the low-temp fallback (simple Steadman estimate) under the 80°F handoff", () => {
    // 75°F/50% RH: (simple + T)/2 stays under 80, so the full Rothfusz
    // regression never engages — the result should be close to air temp, not
    // the wild swings the full regression produces outside its fit region.
    const hi = heatIndexF(75, 50);
    expect(hi).toBeGreaterThan(70);
    expect(hi).toBeLessThan(80);
  });

  it("rises with humidity at a fixed temperature", () => {
    const dry = heatIndexF(92, 40);
    const humid = heatIndexF(92, 85);
    expect(humid).toBeGreaterThan(dry);
  });

  it("applies the low-RH correction (regression alone runs hot in dry air)", () => {
    const corrected = heatIndexF(100, 10);
    // Sanity: still plausible (not runaway), and below what the uncorrected
    // polynomial alone would produce at such low RH.
    expect(corrected).toBeGreaterThan(90);
    expect(corrected).toBeLessThan(110);
  });
});

describe("solarRadiantF", () => {
  it("is at its max in full overhead sun with zero cloud", () => {
    expect(solarRadiantF({ cloudCoverPct: 0, sunElevationDeg: 90 })).toBeCloseTo(8, 5);
  });

  it("is zero under full overcast", () => {
    expect(solarRadiantF({ cloudCoverPct: 100, sunElevationDeg: 90 })).toBe(0);
  });

  it("is zero at night via sun elevation <= 0", () => {
    expect(solarRadiantF({ cloudCoverPct: 0, sunElevationDeg: 0 })).toBe(0);
    expect(solarRadiantF({ cloudCoverPct: 0, sunElevationDeg: -10 })).toBe(0);
  });

  it("is zero at night via the explicit isDaytime flag, even with clear sky data", () => {
    expect(solarRadiantF({ cloudCoverPct: 0, sunElevationDeg: 45, isDaytime: false })).toBe(0);
  });

  it("is zero at night via a zero solarWm2 fallback when no other day/night signal exists", () => {
    expect(solarRadiantF({ cloudCoverPct: 0, solarWm2: 0 })).toBe(0);
  });

  it("scales down with partial cloud", () => {
    const clear = solarRadiantF({ cloudCoverPct: 0, sunElevationDeg: 90 });
    const partly = solarRadiantF({ cloudCoverPct: 50, sunElevationDeg: 90 });
    expect(partly).toBeCloseTo(clear / 2, 5);
  });

  it("scales down with a low sun elevation", () => {
    const overhead = solarRadiantF({ cloudCoverPct: 0, sunElevationDeg: 90 });
    const low = solarRadiantF({ cloudCoverPct: 0, sunElevationDeg: 10 });
    expect(low).toBeLessThan(overhead);
    expect(low).toBeGreaterThan(0);
  });

  // --- honesty: never fabricate a full-sun load from missing inputs ----------

  it("OMITS the term (0) when there's no daytime, elevation, or irradiance signal at all", () => {
    // Previously this assumed full overhead sun (+8°F even at night whenever
    // isDaytime wasn't explicitly false). With nothing telling us the sun is up
    // OR how strong it is, the honest contribution is zero.
    expect(solarRadiantF({})).toBe(0);
    expect(solarRadiantF({ cloudCoverPct: 0 })).toBe(0);
  });

  it("known daytime but no cloud/irradiance value still omits (needs something to scale)", () => {
    expect(solarRadiantF({ isDaytime: true })).toBe(0);
  });

  it("applies a cloud-damped term once we positively know it's daytime and have a cloud reading", () => {
    expect(solarRadiantF({ isDaytime: true, cloudCoverPct: 0 })).toBeCloseTo(8, 5);
    expect(solarRadiantF({ isDaytime: true, cloudCoverPct: 50 })).toBeCloseTo(4, 5);
  });

  it("uses modeled irradiance as the daytime strength signal when present", () => {
    // 500 W/m² of ~1000 full-sun → half strength; clear sky → 8 * 0.5 = 4.
    expect(solarRadiantF({ solarWm2: 500, cloudCoverPct: 0 })).toBeCloseTo(4, 5);
  });
});

describe("sandRadiantF", () => {
  it("is zero without both sand and air temps", () => {
    expect(sandRadiantF(undefined, 90)).toBe(0);
    expect(sandRadiantF(140, undefined)).toBe(0);
  });

  it("is zero (not negative) when sand is at or below air temp", () => {
    expect(sandRadiantF(85, 90)).toBe(0);
    expect(sandRadiantF(90, 90)).toBe(0);
  });

  it("grows with the sand-minus-air gap", () => {
    const modest = sandRadiantF(120, 90); // 30° gap
    const bigger = sandRadiantF(140, 90); // 50° gap
    expect(bigger).toBeGreaterThan(modest);
  });

  it("clamps at the 4°F ceiling for an extreme gap", () => {
    expect(sandRadiantF(180, 70)).toBe(4);
  });
});

describe("windCoolingF", () => {
  it("is zero at or below the 5 mph free threshold", () => {
    expect(windCoolingF(0, 50)).toBe(0);
    expect(windCoolingF(5, 50)).toBe(0);
  });

  it("subtracts ~0.35°F per mph above 5 mph", () => {
    expect(windCoolingF(15, 50)).toBeCloseTo(10 * 0.35, 5);
  });

  it("caps at 7°F even in a gale", () => {
    expect(windCoolingF(40, 50)).toBe(7);
  });

  it("is halved when humidity is above 70%", () => {
    const dry = windCoolingF(15, 60);
    const humid = windCoolingF(15, 85);
    expect(humid).toBeCloseTo(dry / 2, 5);
  });
});

describe("feelsLikeBand", () => {
  it("matches the documented boundaries exactly", () => {
    expect(feelsLikeBand(87)).toBe("pleasant");
    expect(feelsLikeBand(88)).toBe("warm");
    expect(feelsLikeBand(95)).toBe("warm");
    expect(feelsLikeBand(96)).toBe("hot");
    expect(feelsLikeBand(103)).toBe("hot");
    expect(feelsLikeBand(104)).toBe("scorching");
  });
});

describe("feelsLikeBandInfo", () => {
  it("returns distinct tone colors for each band", () => {
    const bands = ["pleasant", "warm", "hot", "scorching"] as const;
    const colors = new Set(bands.map((b) => feelsLikeBandInfo(b).color));
    expect(colors.size).toBe(4);
  });
});

describe("feelsLikeBeach", () => {
  const base = { airTempF: 90, humidityPct: 70 };

  it("returns undefined without air temp", () => {
    expect(feelsLikeBeach({ humidityPct: 70 })).toBeUndefined();
  });

  it("returns undefined without humidity", () => {
    expect(feelsLikeBeach({ airTempF: 90 })).toBeUndefined();
  });

  it("with the sun term zeroed (night) and no sand/wind, reduces to the plain heat index", () => {
    // Explicit night via isDaytime:false forces the solar term to 0.
    const r = feelsLikeBeach({ ...base, isDaytime: false })!;
    expect(r).toBeDefined();
    expect(r.tempF).toBe(Math.round(heatIndexF(90, 70)));
  });

  it("with NO daytime/elevation/irradiance signal, adds no sun (omits it) — no fabricated +8°F", () => {
    // Even a clear-sky cloud reading alone is not enough to assume the sun is
    // up: without a daytime/strength signal the solar term is omitted, so the
    // number reduces to the plain heat index and carries no sun driver.
    const r = feelsLikeBeach({ ...base, cloudCoverPct: 0 })!;
    expect(r.tempF).toBe(Math.round(heatIndexF(90, 70)));
    expect(r.drivers.some((d) => d.includes("sun"))).toBe(false);
  });

  it("the sun term moves the number up", () => {
    const shaded = feelsLikeBeach({ ...base, cloudCoverPct: 100, sunElevationDeg: 90 })!;
    const sunny = feelsLikeBeach({ ...base, cloudCoverPct: 0, sunElevationDeg: 90 })!;
    expect(sunny.tempF).toBeGreaterThan(shaded.tempF);
    expect(sunny.drivers.some((d) => /sun \+\d+°/.test(d))).toBe(true);
  });

  it("the sand term moves the number up", () => {
    const noSand = feelsLikeBeach({ ...base })!;
    const hotSand = feelsLikeBeach({ ...base, sandTempF: 145 })!;
    expect(hotSand.tempF).toBeGreaterThan(noSand.tempF);
    expect(hotSand.drivers.some((d) => /sand \+\d+°/.test(d))).toBe(true);
  });

  it("the wind term moves the number down", () => {
    const calm = feelsLikeBeach({ ...base, windSpeedMph: 0 })!;
    const breezy = feelsLikeBeach({ ...base, windSpeedMph: 20 })!;
    expect(breezy.tempF).toBeLessThan(calm.tempF);
    expect(breezy.drivers.some((d) => /(breeze|wind) −\d+°/.test(d))).toBe(true);
  });

  it("night is valid: the sun term drops out but the result is still defined", () => {
    const day = feelsLikeBeach({ ...base, cloudCoverPct: 0, sunElevationDeg: 60 })!;
    const night = feelsLikeBeach({ ...base, cloudCoverPct: 0, sunElevationDeg: -5 })!;
    expect(night).toBeDefined();
    expect(night.tempF).toBeLessThan(day.tempF);
    expect(night.drivers.some((d) => d.includes("sun"))).toBe(false);
  });

  it("night via isDaytime:false also drops the sun term", () => {
    const night = feelsLikeBeach({ ...base, cloudCoverPct: 0, isDaytime: false })!;
    expect(night).toBeDefined();
    expect(night.drivers.some((d) => d.includes("sun"))).toBe(false);
  });

  it("matches the spec's worked driver example: a 20 mph breeze reads ~steady breeze −5°", () => {
    // 20 mph, humidity <=70 → excess 15 * 0.35 = 5.25 → rounds to 5, "steady
    // breeze" tier (2-6°F).
    const r = feelsLikeBeach({ airTempF: 90, humidityPct: 60, windSpeedMph: 20 })!;
    expect(r.drivers).toContain("steady breeze −5°");
  });

  it("orders drivers by descending magnitude", () => {
    const r = feelsLikeBeach({
      ...base,
      cloudCoverPct: 0,
      sunElevationDeg: 90, // solar ≈ +8
      sandTempF: 130, // sand ≈ +2.4
      windSpeedMph: 8, // wind ≈ −1.05
    })!;
    expect(r.drivers.length).toBeGreaterThanOrEqual(2);
    // First driver should be the sun (largest magnitude).
    expect(r.drivers[0]).toMatch(/^blazing sun/);
  });

  it("produces bands consistent with feelsLikeBand for the composite tempF", () => {
    const r = feelsLikeBeach({ airTempF: 95, humidityPct: 80, cloudCoverPct: 0, sunElevationDeg: 90 })!;
    expect(r.band).toBe(feelsLikeBand(r.tempF));
  });
});
