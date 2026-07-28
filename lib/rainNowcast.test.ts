import { describe, it, expect } from "vitest";
import { APPROACHING_MAX_MINUTES, RAIN_MM_HR, rainNowcast } from "@/lib/rainNowcast";
import type { PrecipRadarData, SourceStatus, Wrapped } from "@/lib/types";

function radar(
  over: Partial<PrecipRadarData> = {},
  status: SourceStatus = "ok",
): Wrapped<PrecipRadarData> {
  return {
    source: "test",
    status,
    fetchedAt: new Date().toISOString(),
    attribution: "NOAA MRMS (radar observation)",
    data: {
      rainNowMmHr: 0,
      nearestRainKm: null,
      nearestBearingDeg: null,
      coveragePct: 0,
      motion: null,
      etaMinutes: null,
      frameIso: new Date().toISOString(),
      framesUsed: 3,
      frameAgeMinutes: 1,
      ...over,
    },
  };
}

const KM_PER_MI = 1.609344;
const mi = (n: number) => n * KM_PER_MI;

describe("rainNowcast: raining now", () => {
  it("says so plainly when radar sees rain at the beach", () => {
    const r = rainNowcast(radar({ rainNowMmHr: 2.8, coveragePct: 14.1 }));
    expect(r?.kind).toBe("raining");
    expect(r?.text).toBe("Raining at the beach now (radar)");
  });

  it("uses the same 0.5 mm/hr threshold the publishing job uses", () => {
    expect(RAIN_MM_HR).toBe(0.5);
    expect(rainNowcast(radar({ rainNowMmHr: RAIN_MM_HR }))?.kind).toBe("raining");
    // Just below: drizzle/clutter, not rain — and with a dry box, stay silent.
    expect(rainNowcast(radar({ rainNowMmHr: RAIN_MM_HR - 0.01 }))).toBeNull();
  });

  it("outranks an ETA — being rained on beats being about to be", () => {
    const r = rainNowcast(
      radar({ rainNowMmHr: 5, nearestRainKm: 0, etaMinutes: 3, coveragePct: 40 }),
    );
    expect(r?.kind).toBe("raining");
  });
});

describe("rainNowcast: approaching", () => {
  it("names the distance in MILES, the direction, and the ETA", () => {
    const r = rainNowcast(
      radar({
        rainNowMmHr: 0,
        nearestRainKm: mi(18),
        nearestBearingDeg: 315, // NW
        etaMinutes: 25,
        motion: { speedKmh: 45, dirDeg: 135 },
      }),
    );
    expect(r?.kind).toBe("approaching");
    expect(r?.text).toBe("Rain on radar ~18 mi NW — could reach the beach in ~25 min");
    expect(r?.distanceMi).toBe(18);
    expect(r?.etaMinutes).toBe(25);
  });

  it("reproduces the real 2026-07-28 proof case (7 km WNW, 26 min out)", () => {
    // The live MRMS run that validated the advection math: a dry point with
    // rain upstream arriving in 26 min (see scripts/mrms_precip.py).
    const r = rainNowcast(
      radar({
        rainNowMmHr: 0,
        nearestRainKm: 7.0,
        nearestBearingDeg: 299,
        etaMinutes: 26,
        motion: { speedKmh: 43.7, dirDeg: 354 },
      }),
    );
    expect(r?.kind).toBe("approaching");
    expect(r?.etaMinutes).toBe(26);
    expect(r?.text).toMatch(/could reach the beach in ~26 min/);
  });

  it("stops promising arrival past the approaching window", () => {
    const far = rainNowcast(
      radar({
        nearestRainKm: mi(20),
        nearestBearingDeg: 270,
        etaMinutes: APPROACHING_MAX_MINUTES + 5,
        motion: { speedKmh: 20, dirDeg: 90 },
      }),
    );
    expect(far?.kind).toBe("nearby");
    // A real-but-distant arrival must NOT be described as "not headed here" —
    // it IS headed here, just further out than we're willing to promise.
    expect(far?.text).not.toMatch(/not headed here|drifting away/);
  });

  it("never renders a 0-mile distance", () => {
    const r = rainNowcast(
      radar({ nearestRainKm: 0.4, nearestBearingDeg: 90, etaMinutes: 5 }),
    );
    expect(r?.distanceMi).toBe(1);
    expect(r?.text).toMatch(/~1 mi E/);
  });
});

describe("rainNowcast: nearby but not arriving", () => {
  it("says 'drifting away' when the motion carries the cell outward", () => {
    // Rain is due west (270); it's moving west (270) — i.e. further away.
    const r = rainNowcast(
      radar({ nearestRainKm: mi(22), nearestBearingDeg: 270, motion: { speedKmh: 30, dirDeg: 270 } }),
    );
    expect(r?.kind).toBe("nearby");
    expect(r?.text).toBe("Showers on radar ~22 mi W, drifting away");
  });

  it("does NOT say 'drifting away' for a cell moving broadly toward us", () => {
    // Rain due west (270) moving EAST (90) is inbound; with no ETA (its track
    // misses the beach) the honest line is "not headed here", not "away".
    const r = rainNowcast(
      radar({ nearestRainKm: mi(22), nearestBearingDeg: 270, motion: { speedKmh: 30, dirDeg: 90 } }),
    );
    expect(r?.text).toBe("Showers on radar ~22 mi W, not headed here");
  });

  it("falls back to distance-only copy when there's no bearing", () => {
    const r = rainNowcast(radar({ nearestRainKm: mi(12), nearestBearingDeg: null }));
    expect(r?.text).toMatch(/~12 mi away/);
  });
});

describe("rainNowcast: honest nulls", () => {
  it("is silent when the box is dry", () => {
    expect(rainNowcast(radar({ rainNowMmHr: 0, nearestRainKm: null }))).toBeNull();
  });

  it("is silent on a STALE feed even though the data is still attached", () => {
    // The whole authority of this line is that it's an observation of NOW.
    const stale = radar(
      { rainNowMmHr: 8, nearestRainKm: 0, etaMinutes: 2 },
      "stale",
    );
    expect(stale.data).not.toBeNull(); // data present...
    expect(rainNowcast(stale)).toBeNull(); // ...but we still say nothing
  });

  it("is silent on error / missing / null-data feeds", () => {
    expect(rainNowcast(null)).toBeNull();
    expect(rainNowcast(undefined)).toBeNull();
    expect(rainNowcast(radar({}, "error"))).toBeNull();
    expect(rainNowcast(radar({}, "best-effort"))).toBeNull();
    expect(
      rainNowcast({
        source: "test",
        status: "ok",
        fetchedAt: new Date().toISOString(),
        attribution: "t",
        data: null,
      }),
    ).toBeNull();
  });

  it("is silent when the beach is outside radar coverage (null rate, null nearest)", () => {
    expect(rainNowcast(radar({ rainNowMmHr: null, nearestRainKm: null, coveragePct: null }))).toBeNull();
  });

  it("ignores rain far beyond the useful range of the box", () => {
    expect(rainNowcast(radar({ nearestRainKm: mi(50), nearestBearingDeg: 180 }))).toBeNull();
  });
});
