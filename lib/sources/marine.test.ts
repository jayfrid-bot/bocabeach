import { describe, expect, it } from "vitest";
import { parseMarineHourly } from "@/lib/sources/marine";

// Open-Meteo marine `hourly` block shape: parallel arrays, GMT times with no
// offset suffix (the fetch URL carries no `timezone=`).
const HOURLY = {
  time: ["2026-07-28T18:00", "2026-07-28T19:00", "2026-07-28T20:00"],
  wave_height: [0.61, 0.73, null],
  wave_period: [8.5, 9.1, null],
  wave_direction: [88, 121, null],
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
    // Hour 3: wave_direction is null, so the swell direction stands in — same
    // preference order the period already used.
    expect(out[2].waveDirDeg).toBe(143);
    expect(out[2].wavePeriodS).toBe(11.6);
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
