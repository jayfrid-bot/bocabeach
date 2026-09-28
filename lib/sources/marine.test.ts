import { describe, expect, it } from "vitest";
import { parseMarineHourly } from "@/lib/sources/marine";

// Open-Meteo marine `hourly` block shape: parallel arrays, GMT times with no
// offset suffix (the fetch URL carries no `timezone=`).
const HOURLY = {
  time: ["2026-07-28T18:00", "2026-07-28T19:00", "2026-07-28T20:00"],
  wave_height: [0.61, 0.73, null],
  wave_period: [8.5, 9.1, null],
  wave_direction: [88, 121, null],
  swell_wave_height: [0.5, 0.6, 0.7],
  swell_wave_period: [11.2, 11.4, 11.6],
  swell_wave_direction: [95, 100, 143],
};

describe("parseMarineHourly", () => {
  it("pins GMT times to absolute UTC and converts height to feet", () => {
    const out = parseMarineHourly(HOURLY)!;
    expect(out).toHaveLength(3);
    expect(out[0].time).toBe("2026-07-28T18:00:00.000Z");
    expect(out[0].waveHeightFt).toBe(2); // 0.61 m
    expect(out[0].wavePeriodS).toBe(8.5);
  });

  it("parses wave_direction into waveDirDeg — the rip curve's shore-incidence input", () => {
    const out = parseMarineHourly(HOURLY)!;
    expect(out[0].waveDirDeg).toBe(88);
    expect(out[1].waveDirDeg).toBe(121);
  });

  it("falls back to swell_wave_direction when the dominant direction is missing", () => {
    const out = parseMarineHourly(HOURLY)!;
    // Hour 3: wave_direction is null, so the swell direction stands in —
    // direction isn't part of the breaker-height physics, so this fallback is
    // harmless (unlike period — see the next test).
    expect(out[2].waveDirDeg).toBe(143);
  });

  // Codex review 2026-09-28 #2: wavePeriodS must be the TOTAL wave_period
  // ONLY — never filled from swell_wave_period, or a consumer pairing it
  // with the TOTAL waveHeightFt would fabricate an amplification the physics
  // doesn't support (a swell-only period does not describe the total height,
  // which includes short-period local wind chop the swell period says
  // nothing about).
  it("does NOT fall back to swell_wave_period when the total wave_period is missing", () => {
    const out = parseMarineHourly(HOURLY)!;
    // Hour 3: wave_period is null. Old (buggy) behavior filled wavePeriodS
    // from swell_wave_period (11.6); it must now stay undefined.
    expect(out[2].wavePeriodS).toBeUndefined();
  });

  it("carries the swell height/period as their own separate fields, matched to each other", () => {
    const out = parseMarineHourly(HOURLY)!;
    expect(out[0].swellHeightFt).toBe(1.6); // 0.5 m
    expect(out[0].swellPeriodS).toBe(11.2);
    expect(out[2].swellHeightFt).toBe(2.3); // 0.7 m
    expect(out[2].swellPeriodS).toBe(11.6);
  });

  it("leaves waveDirDeg undefined when NEITHER direction field is present", () => {
    const out = parseMarineHourly({
      time: ["2026-07-28T18:00"],
      wave_height: [0.61],
      wave_period: [8.5],
    })!;
    expect(out[0].waveDirDeg).toBeUndefined();
    // Downstream that means the incidence multiplier stays 1.0 — see
    // shoreIncidenceFactor in lib/ripRiskCurve.ts.
  });

  it("returns undefined on an empty or missing hourly block", () => {
    expect(parseMarineHourly(null)).toBeUndefined();
    expect(parseMarineHourly({ time: [] })).toBeUndefined();
  });
});
