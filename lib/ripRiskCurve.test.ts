import { describe, expect, it } from "vitest";
import { ripRiskCurve, type RipRiskWaveSample } from "@/lib/ripRiskCurve";
import type { TideEvent } from "@/lib/types";

// A South-Florida-ish summer day: sunrise 6 AM EDT, sunset 8 PM EDT.
const SUNRISE = "2026-07-15T10:00:00.000Z";
const SUNSET = "2026-07-16T00:00:00.000Z";
const TZ = "America/New_York";
const LOW_TIDE_ISO = "2026-07-15T16:00:00.000Z"; // mid-afternoon low

function steadyWaves(heightFt: number, periodS: number): RipRiskWaveSample[] {
  // One sample per hour across the whole daylight span so every bucket has a
  // real (non-neutral-fallback) wave reading.
  const out: RipRiskWaveSample[] = [];
  for (let ms = Date.parse(SUNRISE); ms <= Date.parse(SUNSET); ms += 3_600_000) {
    out.push({ time: new Date(ms).toISOString(), waveHeightFt: heightFt, wavePeriodS: periodS });
  }
  return out;
}

const LOW_TIDE_EVENTS: TideEvent[] = [
  { type: "high", time: "2026-07-15T09:30:00.000Z", heightFt: 2.8 },
  { type: "low", time: LOW_TIDE_ISO, heightFt: 0.3 },
  { type: "high", time: "2026-07-15T22:30:00.000Z", heightFt: 2.9 },
];

describe("ripRiskCurve — band anchoring", () => {
  it("a moderate day never reads like a high day under identical modulating inputs", () => {
    const common = {
      sunriseIso: SUNRISE,
      sunsetIso: SUNSET,
      tz: TZ,
      waves: steadyWaves(3, 10),
      tideEvents: LOW_TIDE_EVENTS,
    };
    const moderate = ripRiskCurve({ ...common, officialLevel: "moderate" });
    const high = ripRiskCurve({ ...common, officialLevel: "high" });

    expect(moderate).not.toBeNull();
    expect(high).not.toBeNull();
    expect(moderate!.hours.length).toBe(high!.hours.length);
    expect(moderate!.hours.length).toBeGreaterThan(0);

    for (let i = 0; i < moderate!.hours.length; i++) {
      const m = moderate!.hours[i];
      const h = high!.hours[i];
      expect(m.t).toBe(h.t);
      // The word never contradicts the anchor.
      expect(m.band).toBe("moderate");
      expect(h.band).toBe("high");
      // The number stays inside its own band...
      expect(m.score).toBeGreaterThanOrEqual(30);
      expect(m.score).toBeLessThanOrEqual(65);
      expect(h.score).toBeGreaterThanOrEqual(60);
      expect(h.score).toBeLessThanOrEqual(95);
      // ...and a moderate hour never scores as high as its high-day twin.
      expect(m.score).toBeLessThan(h.score);
    }
  });

  it("a low day stays inside 5-35 even with maximal modulating inputs", () => {
    const curve = ripRiskCurve({
      officialLevel: "low",
      sunriseIso: SUNRISE,
      sunsetIso: SUNSET,
      tz: TZ,
      waves: steadyWaves(6, 16), // big, long-period — near-max wave factor
      tideEvents: LOW_TIDE_EVENTS,
    });
    expect(curve).not.toBeNull();
    for (const h of curve!.hours) {
      expect(h.band).toBe("low");
      expect(h.score).toBeGreaterThanOrEqual(5);
      expect(h.score).toBeLessThanOrEqual(35);
    }
  });
});

describe("ripRiskCurve — tide phase", () => {
  it("bumps risk in the ~2h around low tide relative to an hour far from any low", () => {
    const curve = ripRiskCurve({
      officialLevel: "moderate",
      sunriseIso: SUNRISE,
      sunsetIso: SUNSET,
      tz: TZ,
      tideEvents: LOW_TIDE_EVENTS, // no waves — isolates the tide factor
    });
    expect(curve).not.toBeNull();

    const atLow = curve!.hours.find((h) => h.t === LOW_TIDE_ISO);
    const farFromLow = curve!.hours.find((h) => h.t === SUNRISE); // 6h before the low
    expect(atLow).toBeDefined();
    expect(farFromLow).toBeDefined();
    expect(atLow!.score).toBeGreaterThan(farFromLow!.score);
  });

  it("names the low-tide window in the peakNote when the peak lands near a low", () => {
    const curve = ripRiskCurve({
      officialLevel: "moderate",
      sunriseIso: SUNRISE,
      sunsetIso: SUNSET,
      tz: TZ,
      tideEvents: LOW_TIDE_EVENTS,
    });
    expect(curve).not.toBeNull();
    expect(curve!.peakNote).toMatch(/riskiest/i);
    expect(curve!.peakNote).toMatch(/around low tide/i);
  });
});

describe("ripRiskCurve — wave energy", () => {
  it("long-period swell reads higher risk than short-period chop at equal wave height", () => {
    const shortPeriod = ripRiskCurve({
      officialLevel: "moderate",
      sunriseIso: SUNRISE,
      sunsetIso: SUNSET,
      tz: TZ,
      waves: [{ time: LOW_TIDE_ISO, waveHeightFt: 3, wavePeriodS: 6 }],
    });
    const longPeriod = ripRiskCurve({
      officialLevel: "moderate",
      sunriseIso: SUNRISE,
      sunsetIso: SUNSET,
      tz: TZ,
      waves: [{ time: LOW_TIDE_ISO, waveHeightFt: 3, wavePeriodS: 14 }],
    });
    expect(shortPeriod).not.toBeNull();
    expect(longPeriod).not.toBeNull();

    const shortHour = shortPeriod!.hours.find((h) => h.t === LOW_TIDE_ISO);
    const longHour = longPeriod!.hours.find((h) => h.t === LOW_TIDE_ISO);
    expect(shortHour).toBeDefined();
    expect(longHour).toBeDefined();
    expect(longHour!.score).toBeGreaterThan(shortHour!.score);
  });
});

describe("ripRiskCurve — honest null / degraded modes", () => {
  it("returns null when the official NWS level is unknown (never invents an anchor)", () => {
    const curve = ripRiskCurve({
      officialLevel: "unknown",
      sunriseIso: SUNRISE,
      sunsetIso: SUNSET,
      tz: TZ,
      waves: steadyWaves(3, 10),
      tideEvents: LOW_TIDE_EVENTS,
    });
    expect(curve).toBeNull();
  });

  it("returns null when sunrise/sunset don't form a valid daylight window", () => {
    const curve = ripRiskCurve({
      officialLevel: "moderate",
      sunriseIso: SUNSET, // reversed
      sunsetIso: SUNRISE,
      tz: TZ,
    });
    expect(curve).toBeNull();
  });

  it("is UNSHAPED (official word, no numeric curve) when both waves and tide are missing", () => {
    const curve = ripRiskCurve({
      officialLevel: "moderate",
      sunriseIso: SUNRISE,
      sunsetIso: SUNSET,
      tz: TZ,
      // no waves, no tideEvents
    });
    expect(curve).not.toBeNull();
    // No fabricated flat band-midpoint number — the honest state is the official
    // word with NO hourly curve at all.
    expect(curve!.unshaped).toBe(true);
    expect(curve!.hours).toHaveLength(0);
    expect(curve!.level).toBe("moderate");
    // Not silence — the note is honest about why hourly detail is missing.
    expect(curve!.peakNote.length).toBeGreaterThan(0);
    expect(curve!.peakNote).toMatch(/not available|anchored/i);
    expect(curve!.peakNote).toMatch(/moderate/i);
  });

  it("an empty (but present) waves/tideEvents array is treated the same as absent (unshaped)", () => {
    const curve = ripRiskCurve({
      officialLevel: "high",
      sunriseIso: SUNRISE,
      sunsetIso: SUNSET,
      tz: TZ,
      waves: [],
      tideEvents: [],
    });
    expect(curve).not.toBeNull();
    expect(curve!.unshaped).toBe(true);
    expect(curve!.hours).toHaveLength(0);
    expect(curve!.level).toBe("high");
  });

  it("wave samples with height but NO period are unusable — no numeric curve unless tide shapes it", () => {
    // hasWaves-as-'non-empty' used to be enough; a usable sample needs BOTH
    // height and period. Height-only samples + no tide → unshaped.
    const curve = ripRiskCurve({
      officialLevel: "moderate",
      sunriseIso: SUNRISE,
      sunsetIso: SUNSET,
      tz: TZ,
      waves: [{ time: LOW_TIDE_ISO, waveHeightFt: 4 }], // no wavePeriodS
    });
    expect(curve).not.toBeNull();
    expect(curve!.unshaped).toBe(true);
    expect(curve!.hours).toHaveLength(0);
  });
});

describe("ripRiskCurve — peak attribution (honest peakReason)", () => {
  it("a usable-wave-driven peak (no tide) is worded 'as today's swell peaks'", () => {
    const curve = ripRiskCurve({
      officialLevel: "moderate",
      sunriseIso: SUNRISE,
      sunsetIso: SUNSET,
      tz: TZ,
      // One strong, long-period usable sample mid-afternoon; nothing else.
      waves: [{ time: LOW_TIDE_ISO, waveHeightFt: 6, wavePeriodS: 16 }],
    });
    expect(curve).not.toBeNull();
    expect(curve!.unshaped).toBe(false);
    expect(curve!.peakNote).toMatch(/swell/i);
  });

  it("does NOT claim 'as today's swell peaks' when the peak was driven by tide and waves are unusable", () => {
    // Height-only (unusable) waves + a falling tide whose mid-ebb (not a low)
    // lands in daylight. Before the fix, the mere presence of a waves array made
    // the peak read "as today's swell peaks"; now it must attribute to the tide.
    const curve = ripRiskCurve({
      officialLevel: "moderate",
      sunriseIso: SUNRISE,
      sunsetIso: SUNSET,
      tz: TZ,
      waves: [{ time: SUNRISE, waveHeightFt: 6 }], // height only -> unusable
      tideEvents: [
        { type: "high", time: "2026-07-15T12:00:00.000Z", heightFt: 3.0 },
        { type: "low", time: "2026-07-16T02:00:00.000Z", heightFt: 0.0 }, // low is AFTER sunset
      ],
    });
    expect(curve).not.toBeNull();
    expect(curve!.unshaped).toBe(false);
    expect(curve!.peakNote).not.toMatch(/swell/i);
    expect(curve!.peakNote).toMatch(/tide/i);
  });
});
