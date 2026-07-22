import { describe, expect, it } from "vitest";
import {
  manOWarRisk,
  seaLiceRisk,
  marineStinger,
  type HourlyWindSample,
} from "@/lib/marineStinger";
import type { StingerSightings } from "@/lib/sources/stingerSightings";

// Due-east-facing SE-Florida Atlantic beach: onshore = wind FROM the east.
const COAST_NORMAL_DEG = 90;

const NOW = new Date("2026-01-15T18:00:00.000Z"); // mid-January -> in-season
const SUMMER_NOW = new Date("2026-07-15T18:00:00.000Z"); // mid-July -> off-season
const DECEMBER_NOW = new Date("2026-12-10T18:00:00.000Z");

/** `hours` trailing hourly samples ending at `now`, all identical speed/dir —
 *  a clean "sustained" wind for testing the wind-forcing curve in isolation. */
function steadyWind(now: Date, hours: number, speedMph: number, dirDeg: number): HourlyWindSample[] {
  const out: HourlyWindSample[] = [];
  for (let h = 0; h < hours; h++) {
    out.push({
      time: new Date(now.getTime() - h * 3_600_000).toISOString(),
      windSpeedMph: speedMph,
      windDirDeg: dirDeg,
    });
  }
  return out;
}

const EASTERLY_20MPH = (now: Date) => steadyWind(now, 36, 20, 90); // straight onshore, strong
const WESTERLY_20MPH = (now: Date) => steadyWind(now, 36, 20, 270); // straight offshore

function sighting(overrides: Partial<StingerSightings> = {}): StingerSightings {
  return { count: 1, mostRecentIso: "2026-01-14", nearestKm: 20, withinDays: 14, ...overrides };
}

describe("manOWarRisk — wind + season", () => {
  it("sustained strong easterly in winter (in-season, wind-only) reads elevated", () => {
    const r = manOWarRisk({
      hourlyWind: EASTERLY_20MPH(NOW),
      coastNormalDeg: COAST_NORMAL_DEG,
      month: 1,
      sightings: null,
      now: NOW,
    });
    expect(r).not.toBeNull();
    expect(r!.level).toBe("elevated");
    expect(r!.confidence).toBe("wind-only");
    expect(r!.note).toMatch(/onshore/i);
    expect(r!.note).toMatch(/next day/i);
  });

  it("the identical wind in summer (off-season) reads lower and the note is softer", () => {
    const winter = manOWarRisk({
      hourlyWind: EASTERLY_20MPH(NOW),
      coastNormalDeg: COAST_NORMAL_DEG,
      month: 1,
      sightings: null,
      now: NOW,
    })!;
    const summer = manOWarRisk({
      hourlyWind: EASTERLY_20MPH(SUMMER_NOW),
      coastNormalDeg: COAST_NORMAL_DEG,
      month: 7,
      sightings: null,
      now: SUMMER_NOW,
    })!;
    expect(summer.score).toBeLessThan(winter.score);
    // "elevated" in winter should not still be "elevated" (or higher) in summer.
    expect(["low", "possible"]).toContain(summer.level);
    expect(summer.note).toMatch(/season/i);
    expect(winter.note).not.toMatch(/season/i); // in-season note has no hedge
  });

  it("a westerly (offshore) wind reads low regardless of speed", () => {
    const r = manOWarRisk({
      hourlyWind: WESTERLY_20MPH(NOW),
      coastNormalDeg: COAST_NORMAL_DEG,
      month: 1,
      sightings: null,
      now: NOW,
    });
    expect(r).not.toBeNull();
    expect(r!.level).toBe("low");
    expect(r!.score).toBe(0);
  });

  it("returns null with less than 24h of trailing wind coverage", () => {
    const r = manOWarRisk({
      hourlyWind: steadyWind(NOW, 10, 20, 90), // only 10 trailing hours
      coastNormalDeg: COAST_NORMAL_DEG,
      month: 1,
      sightings: null,
      now: NOW,
    });
    expect(r).toBeNull();
  });

  it("returns null with no wind samples at all", () => {
    expect(
      manOWarRisk({
        hourlyWind: [],
        coastNormalDeg: COAST_NORMAL_DEG,
        month: 1,
        sightings: null,
        now: NOW,
      }),
    ).toBeNull();
  });
});

describe("manOWarRisk — sightings gate", () => {
  const base = {
    hourlyWind: EASTERLY_20MPH(NOW),
    coastNormalDeg: COAST_NORMAL_DEG,
    month: 1,
    now: NOW,
  };

  it("a recent nearby sighting boosts confidence to 'observed' and raises the level/score", () => {
    const windOnly = manOWarRisk({ ...base, sightings: null })!;
    const observed = manOWarRisk({ ...base, sightings: sighting() })!;
    expect(observed.confidence).toBe("observed");
    expect(observed.score).toBeGreaterThan(windOnly.score);
    expect(LEVEL_RANK(observed.level)).toBeGreaterThanOrEqual(LEVEL_RANK(windOnly.level));
    expect(observed.note).toMatch(/reported nearby/i);
  });

  it("a checked-and-empty sightings feed lowers confidence to 'low' and damps the score", () => {
    const windOnly = manOWarRisk({ ...base, sightings: null })!;
    const zero = manOWarRisk({
      ...base,
      sightings: { count: 0, withinDays: 14 },
    })!;
    expect(zero.confidence).toBe("low");
    expect(zero.score).toBeLessThan(windOnly.score);
    expect(zero.note).toMatch(/no man-o'-war reported/i);
  });

  it("a null sightings feed (unreachable) reads 'wind-only', distinct wording from checked-zero", () => {
    const nullFeed = manOWarRisk({ ...base, sightings: null })!;
    const checkedZero = manOWarRisk({ ...base, sightings: { count: 0, withinDays: 14 } })!;
    expect(nullFeed.confidence).toBe("wind-only");
    expect(nullFeed.note).not.toEqual(checkedZero.note);
    expect(nullFeed.note).toMatch(/unavailable/i);
  });

  it("a stale (>7 day) sighting does NOT qualify as 'observed' — treated as checked-and-clear", () => {
    const r = manOWarRisk({
      ...base,
      sightings: sighting({ mostRecentIso: "2025-12-01" }),
    })!;
    expect(r.confidence).toBe("low");
  });

  it("a distant (>100km) sighting does NOT qualify as 'observed'", () => {
    const r = manOWarRisk({
      ...base,
      sightings: sighting({ nearestKm: 250 }),
    })!;
    expect(r.confidence).toBe("low");
  });

  it("wind-only NEVER reaches 'high' even with an extreme sustained onshore gale", () => {
    const r = manOWarRisk({
      hourlyWind: steadyWind(NOW, 36, 45, 90), // very strong, straight onshore
      coastNormalDeg: COAST_NORMAL_DEG,
      month: 1,
      sightings: null,
      now: NOW,
    })!;
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.level).not.toBe("high");
    expect(r.confidence).toBe("wind-only");
  });

  it("checked-and-clear NEVER reaches 'elevated' or 'high' even with an extreme gale", () => {
    const r = manOWarRisk({
      hourlyWind: steadyWind(NOW, 36, 45, 90),
      coastNormalDeg: COAST_NORMAL_DEG,
      month: 1,
      sightings: { count: 0, withinDays: 14 },
      now: NOW,
    })!;
    expect(["low", "possible"]).toContain(r.level);
  });

  it("an observed, confirmed sighting CAN reach 'high' with strong sustained wind", () => {
    const r = manOWarRisk({
      hourlyWind: steadyWind(NOW, 36, 30, 90),
      coastNormalDeg: COAST_NORMAL_DEG,
      month: 1,
      sightings: sighting(),
      now: NOW,
    })!;
    expect(r.level).toBe("high");
  });
});

function LEVEL_RANK(l: string): number {
  return ["low", "possible", "elevated", "high"].indexOf(l);
}

describe("seaLiceRisk — purely climatological", () => {
  it("May + warm water reads elevated", () => {
    const r = seaLiceRisk({ month: 5, waterTempF: 80 });
    expect(r).not.toBeNull();
    expect(r!.level).toBe("elevated");
    expect(r!.note).toMatch(/seasonal likelihood/i);
    expect(r!.note).not.toMatch(/forecast for/i);
  });

  it("June (peak) without a water temp reading still reads at least 'possible'", () => {
    const r = seaLiceRisk({ month: 6 });
    expect(r).not.toBeNull();
    expect(r!.level).toBe("possible");
  });

  it("December is outside the plausible window entirely -> null", () => {
    expect(seaLiceRisk({ month: 12, waterTempF: 82 })).toBeNull();
  });

  it("January is outside the window -> null", () => {
    expect(seaLiceRisk({ month: 1 })).toBeNull();
  });

  it("in-window but non-peak, non-warm (e.g. March, cool water) reads 'low', not null", () => {
    const r = seaLiceRisk({ month: 3, waterTempF: 72 });
    expect(r).not.toBeNull();
    expect(r!.level).toBe("low");
  });

  it("August warm water (in window, not peak) reads 'possible' from warmth alone", () => {
    const r = seaLiceRisk({ month: 8, waterTempF: 84 });
    expect(r!.level).toBe("possible");
  });
});

describe("marineStinger — combined advisory", () => {
  it("returns null only when BOTH sub-advisories have nothing to say", () => {
    const r = marineStinger({
      hourlyWind: WESTERLY_20MPH(DECEMBER_NOW), // man-o'-war -> "low" (not null) though
      coastNormalDeg: COAST_NORMAL_DEG,
      month: 12,
      sightings: null,
      now: DECEMBER_NOW,
      // no waterTempF, month 12 -> seaLice null
    });
    // manOWar is non-null ("low"), so the combined result must still surface it.
    expect(r).not.toBeNull();
    expect(r!.manOWar).not.toBeNull();
    expect(r!.seaLice).toBeNull();
  });

  it("both sub-advisories are independent and can disagree in direction", () => {
    // Peak sea-lice season (June) but man-o'-war season is Nov-Apr, so a June
    // reading should show strong sea lice and a heavily tapered man-o'-war.
    const juneNow = new Date("2026-06-10T18:00:00.000Z");
    const r = marineStinger({
      hourlyWind: EASTERLY_20MPH(juneNow),
      coastNormalDeg: COAST_NORMAL_DEG,
      month: 6,
      sightings: null,
      waterTempF: 82,
      now: juneNow,
    })!;
    expect(r.seaLice!.level).toBe("elevated");
    expect(["low", "possible"]).toContain(r.manOWar!.level);
  });

  it("returns null when wind history is insufficient AND sea lice is out of season", () => {
    const r = marineStinger({
      hourlyWind: steadyWind(DECEMBER_NOW, 5, 20, 90), // too little history -> manOWar null
      coastNormalDeg: COAST_NORMAL_DEG,
      month: 12, // sea lice out of season -> null
      sightings: null,
      now: DECEMBER_NOW,
    });
    expect(r).toBeNull();
  });
});
