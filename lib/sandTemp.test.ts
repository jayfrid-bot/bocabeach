import { describe, expect, it } from "vitest";
import {
  afternoonBoostFactor,
  currentSandRangeF,
  currentSandTempF,
  estimateSandRangeF,
  estimateSandTempF,
  hoursFromSolarNoon,
  sandVerdict,
} from "@/lib/sandTemp";

describe("estimateSandTempF", () => {
  it("returns undefined without a ground-surface basis", () => {
    expect(estimateSandTempF({ solarWm2: 900 })).toBeUndefined();
  });

  it("adds the full boost in calm full sun", () => {
    expect(estimateSandTempF({ soilTempF: 80, solarWm2: 1000, windSpeedMph: 0 })).toBe(135);
  });

  it("adds no boost at night (zero radiation)", () => {
    expect(estimateSandTempF({ soilTempF: 80, solarWm2: 0, windSpeedMph: 0 })).toBe(80);
  });

  it("scales the boost concavely with partial sun (sqrt, not linear)", () => {
    // 50% sun → ~71% of the full boost: dry sand heats fast even at moderate sun.
    expect(estimateSandTempF({ soilTempF: 80, solarWm2: 500, windSpeedMph: 0 })).toBe(119);
  });

  it("damps the boost in wind but keeps a floor", () => {
    const calm = estimateSandTempF({ soilTempF: 80, solarWm2: 1000, windSpeedMph: 0 })!;
    const breezy = estimateSandTempF({ soilTempF: 80, solarWm2: 1000, windSpeedMph: 15 })!;
    const gale = estimateSandTempF({ soilTempF: 80, solarWm2: 1000, windSpeedMph: 40 })!;
    expect(breezy).toBeLessThan(calm);
    expect(gale).toBe(Math.round(80 + 55 * 0.6)); // wind floor, not zero
  });

  it("collapses the boost after recent rain", () => {
    const dry = estimateSandTempF({ soilTempF: 100, solarWm2: 900, windSpeedMph: 5 })!;
    const wet = estimateSandTempF({ soilTempF: 100, solarWm2: 900, windSpeedMph: 5, recentRainIn: 0.2 })!;
    expect(wet).toBeLessThan(dry);
    expect(wet - 100).toBeLessThanOrEqual(14);
  });

  it("clamps radiation above full sun", () => {
    expect(estimateSandTempF({ soilTempF: 80, solarWm2: 2000, windSpeedMph: 0 })).toBe(135);
  });
});

describe("estimateSandRangeF", () => {
  it("matches the 2026-06-11 IR ground truth: ~130 near the surf, ~140 by the dunes", () => {
    // Measured ~2 PM: soil 98F, ~980 W/m2 full sun, 11 mph sea breeze.
    const r = estimateSandRangeF({ soilTempF: 98, solarWm2: 980, windSpeedMph: 11 })!;
    expect(r.dunesF).toBeGreaterThanOrEqual(133);
    expect(r.dunesF).toBeLessThanOrEqual(140);
    expect(r.surfF).toBeGreaterThanOrEqual(119);
    expect(r.surfF).toBeLessThanOrEqual(128);
    expect(r.surfF).toBeLessThan(r.dunesF); // wet surf sand cooler than dry dunes
  });


  it("matches the 2026-06-15 IR ground truth: 129-135°F on a hot-soil afternoon", () => {
    // Measured ~1 PM: soil 109F (hotter baseline than 6/11), 820 W/m2, 10 mph.
    // The ground-damp factor keeps the model from double-counting solar
    // heating that the modeled soil temp already absorbs.
    const r = estimateSandRangeF({ soilTempF: 109, solarWm2: 820, windSpeedMph: 10 })!;
    expect(r.dunesF).toBeGreaterThanOrEqual(130);
    expect(r.dunesF).toBeLessThanOrEqual(140);
    expect(r.surfF).toBeGreaterThanOrEqual(125);
    expect(r.surfF).toBeLessThanOrEqual(133);
  });

  it("matches the 2026-06-23 IR ground truth: 113°F surf / 124°F dunes (low morning sun)", () => {
    // Measured ~9:54 AM: soil 91F, 380 W/m2 (moderate morning sun), 2 mph. The
    // concave solar response captures dry sand running hot even below 40% sun.
    const r = estimateSandRangeF({ soilTempF: 91, solarWm2: 380, windSpeedMph: 2 })!;
    expect(r.surfF).toBeGreaterThanOrEqual(110);
    expect(r.surfF).toBeLessThanOrEqual(116);
    expect(r.dunesF).toBeGreaterThanOrEqual(120);
    expect(r.dunesF).toBeLessThanOrEqual(127);
  });

  it("collapses to the ground temp at night (both ends equal)", () => {
    const r = estimateSandRangeF({ soilTempF: 80, solarWm2: 0 })!;
    expect(r.surfF).toBe(80);
    expect(r.dunesF).toBe(80);
  });

  it("matches the 2026-07-06 IR ground truth: ~96°F under a solid overcast deck", () => {
    // Measured ~4-5 PM, twice an hour apart: soil 94F, ~320 W/m2, ~100% cloud →
    // 96F. Solid overcast passes no direct beam, so the sand sits at ground
    // temp; the undamped model read ~121F.
    const r = estimateSandRangeF({
      soilTempF: 94,
      solarWm2: 320,
      windSpeedMph: 2,
      cloudCoverPct: 100,
    })!;
    expect(r.dunesF).toBeGreaterThanOrEqual(94);
    expect(r.dunesF).toBeLessThanOrEqual(99);
    expect(r.surfF).toBeGreaterThanOrEqual(94);
    expect(r.surfF).toBeLessThanOrEqual(r.dunesF);
  });

  it("broken clouds do NOT damp the boost (6/23 stayed hot under 63% cover)", () => {
    // Direct beam still lands between broken clouds — damping starts only past 70%.
    const clear = estimateSandRangeF({ soilTempF: 91, solarWm2: 380, windSpeedMph: 2 })!;
    const broken = estimateSandRangeF({
      soilTempF: 91,
      solarWm2: 380,
      windSpeedMph: 2,
      cloudCoverPct: 63,
    })!;
    expect(broken.dunesF).toBe(clear.dunesF);
    // …and the damping ramps between: 85% cover cuts some but not all of it.
    const partly = estimateSandRangeF({
      soilTempF: 91,
      solarWm2: 380,
      windSpeedMph: 2,
      cloudCoverPct: 85,
    })!;
    expect(partly.dunesF).toBeLessThan(clear.dunesF);
    expect(partly.dunesF).toBeGreaterThan(94);
  });
});

describe("sandVerdict", () => {
  it("maps the barefoot-comfort bands", () => {
    expect(sandVerdict(85).label).toBe("Barefoot fine");
    expect(sandVerdict(100).label).toBe("Warm");
    expect(sandVerdict(120).label).toBe("Hot");
    expect(sandVerdict(135).label).toBe("Scorching");
  });
});

describe("current sand value: card and score agree", () => {
  // The metric card (range) and the score (single dunes value) must read the
  // SAME hour bucket, so the dunes end of the range equals the scored value.
  const hours = Array.from({ length: 6 }, (_, i) => ({
    time: new Date(Date.parse("2026-06-17T15:00:00Z") + i * 3600_000).toISOString(),
    soilTempF: 90 + i,
    solarWm2: 800,
    windSpeedMph: 8,
    precipIn: 0,
  }));
  const now = Date.parse("2026-06-17T16:30:00Z"); // inside the 16:00 bucket

  it("range dunes end equals the single scored value", () => {
    const single = currentSandTempF(hours, now);
    const range = currentSandRangeF(hours, now);
    expect(range).not.toBeUndefined();
    expect(range!.dunesF).toBe(single);
    expect(range!.surfF).toBeLessThanOrEqual(range!.dunesF); // surf never hotter than dunes
  });

  it("returns undefined together when no bucket is near now", () => {
    const far = Date.parse("2026-06-20T16:30:00Z");
    expect(currentSandTempF(hours, far)).toBeUndefined();
    expect(currentSandRangeF(hours, far)).toBeUndefined();
  });
});

describe("evening radiative cooling (accuracy tune, 2026-07-17)", () => {
  // The model floors at soil temp, but 19 paired IR readings showed a +2°F
  // systematic OVER-read after ~5:20 PM (hAN >= 4), where real dry sand runs a
  // couple degrees BELOW the soil model. A small evening deficit corrects it.
  const base = { soilTempF: 92, solarWm2: 300, windSpeedMph: 8 } as const;

  it("subtracts nothing before ~3.8h past solar noon (midday untouched)", () => {
    const noon = estimateSandTempF({ ...base, hoursFromSolarNoon: 0 })!;
    const early = estimateSandTempF({ ...base, hoursFromSolarNoon: 3.8 })!;
    // Same boost factor region → the cooling term hasn't started; the only
    // difference would be the afternoon decay, so compare against no-hAN.
    const noHan = estimateSandTempF(base)!;
    expect(noon).toBe(noHan); // hAN 0 → decay 1.0, cooling 0
    expect(early).toBeLessThanOrEqual(noHan); // decay may bite, cooling still 0
  });

  it("dips the estimate BELOW soil deep in the evening (was floored at soil)", () => {
    // 7:57 PM-ish (hAN 6.5): boost is near zero, cooling ~2.2 → below soil.
    const est = estimateSandTempF({ soilTempF: 90, solarWm2: 284, windSpeedMph: 9, hoursFromSolarNoon: 6.5 })!;
    expect(est).toBeLessThan(90);
    expect(est).toBeGreaterThanOrEqual(86); // ~2-3° below, not a cliff
  });

  it("cools more the closer to sunset (monotonic through the evening)", () => {
    const at = (h: number) => estimateSandTempF({ soilTempF: 90, solarWm2: 250, windSpeedMph: 9, hoursFromSolarNoon: h })!;
    expect(at(6.5)).toBeLessThanOrEqual(at(5.0));
    expect(at(5.0)).toBeLessThanOrEqual(at(3.8));
  });

  it("cools surf and dune sand equally (both radiate to the sky)", () => {
    const noCool = estimateSandRangeF({ soilTempF: 90, solarWm2: 250, windSpeedMph: 9, hoursFromSolarNoon: 0 })!;
    const cooled = estimateSandRangeF({ soilTempF: 90, solarWm2: 250, windSpeedMph: 9, hoursFromSolarNoon: 6.5 })!;
    expect(cooled.dunesF).toBeLessThan(noCool.dunesF);
    expect(cooled.surfF).toBeLessThan(noCool.surfF);
  });
});

describe("afternoon decay (2026-07-16 field session)", () => {
  describe("afternoonBoostFactor", () => {
    it("is full (1.0) through the morning and the first ~1.4h past solar noon", () => {
      expect(afternoonBoostFactor(-3.5)).toBe(1); // 9:54 AM: +33 boost measured
      expect(afternoonBoostFactor(0)).toBe(1); // solar noon
      expect(afternoonBoostFactor(0.9)).toBe(1); // 2:20 PM: still +30 measured
      expect(afternoonBoostFactor(1.4)).toBe(1);
    });

    it("eases down a GRADUAL slope — ~4 PM still substantial, no cliff", () => {
      expect(afternoonBoostFactor(2.6)).toBeGreaterThan(0.5); // ~4 PM: still hot (warns)
      expect(afternoonBoostFactor(2.6)).toBeLessThan(0.8);
      expect(afternoonBoostFactor(3.6)).toBeLessThan(0.35); // ~5 PM: mostly gone
    });

    it("reaches a near-zero floor by ~4.4h past noon and stays there", () => {
      expect(afternoonBoostFactor(4.4)).toBeCloseTo(0.03, 2);
      expect(afternoonBoostFactor(5.9)).toBeCloseTo(0.03, 2); // 7:23 PM: dead
    });

    it("decreases monotonically through the afternoon", () => {
      let prev = 1;
      for (let h = 2.4; h <= 6; h += 0.2) {
        const f = afternoonBoostFactor(h);
        expect(f).toBeLessThanOrEqual(prev + 1e-9);
        prev = f;
      }
    });
  });

  describe("hoursFromSolarNoon (Boca lon -80.07)", () => {
    const LON = -80.07;
    it("is ~0 at local solar noon (~17:24 UTC in mid-July)", () => {
      expect(hoursFromSolarNoon(LON, new Date("2026-07-16T17:24:00Z"))).toBeCloseTo(0, 1);
    });
    it("is negative in the morning, positive in the evening", () => {
      expect(hoursFromSolarNoon(LON, new Date("2026-07-16T13:54:00Z"))).toBeLessThan(-2); // 9:54 AM
      expect(hoursFromSolarNoon(LON, new Date("2026-07-16T23:23:00Z"))).toBeGreaterThan(5); // 7:23 PM
    });
  });

  describe("boost vs the measured field points", () => {
    // The discriminator the session proved: identical low sun, opposite boost.
    it("keeps full boost for a LOW morning sun but kills it for the SAME low evening sun", () => {
      // 9:54 AM, soil 91, 380 W/m², 2 mph → +33 measured (elev ~43°)
      const morning = estimateSandTempF({
        soilTempF: 91,
        solarWm2: 380,
        windSpeedMph: 2,
        hoursFromSolarNoon: -3.5,
      })!;
      // 5:01 PM, soil 100, 664 W/m² (HIGHER sun-hour GHI) → +1 measured (elev ~41°)
      const evening = estimateSandTempF({
        soilTempF: 100,
        solarWm2: 664,
        windSpeedMph: 9,
        hoursFromSolarNoon: 3.6,
      })!;
      expect(morning - 91).toBeGreaterThan(25); // big morning boost
      expect(evening - 100).toBeLessThan(6); // near-zero evening boost
    });

    it("the 7:23 PM full-sun case lands ~soil, not scorching (was +23°F over)", () => {
      // soil 90, 283 W/m², full sun, 6h past noon → 91 measured; old model said 114
      const withDecay = estimateSandTempF({
        soilTempF: 90,
        solarWm2: 283,
        windSpeedMph: 11,
        hoursFromSolarNoon: 5.9,
      })!;
      const withoutDecay = estimateSandTempF({
        soilTempF: 90,
        solarWm2: 283,
        windSpeedMph: 11,
      })!;
      expect(withDecay).toBeLessThanOrEqual(93);
      expect(withoutDecay).toBeGreaterThan(105); // the bug this fixes
    });

    it("leaves the midday calibration untouched (no hoursFromSolarNoon → full boost)", () => {
      // 1 PM 7/14: soil 105, 965 W/m², 11 mph → 138 (unchanged; decay term absent)
      const noon = estimateSandTempF({ soilTempF: 105, solarWm2: 965, windSpeedMph: 11 })!;
      const noonWithFactor = estimateSandTempF({
        soilTempF: 105,
        solarWm2: 965,
        windSpeedMph: 11,
        hoursFromSolarNoon: -0.4,
      })!;
      expect(noonWithFactor).toBe(noon); // factor 1.0 at h=-0.4
      expect(noon).toBeGreaterThan(130);
    });
  });
});
