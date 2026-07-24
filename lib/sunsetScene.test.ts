import { describe, expect, it } from "vitest";
import { skyTier, sunScenePhase } from "@/lib/sunsetScene";

const MIN = 60_000;

describe("skyTier", () => {
  it("maps each score band to its palette", () => {
    expect(skyTier(95)).toBe("vivid");
    expect(skyTier(75)).toBe("vivid");
    expect(skyTier(74)).toBe("warm");
    expect(skyTier(50)).toBe("warm");
    expect(skyTier(49)).toBe("mild");
    expect(skyTier(25)).toBe("mild");
    expect(skyTier(24)).toBe("dud");
    expect(skyTier(0)).toBe("dud");
  });

  it("stays neutral rather than flattering when there's no score", () => {
    expect(skyTier(null)).toBe("unknown");
    expect(skyTier(undefined)).toBe("unknown");
    expect(skyTier(Number.NaN)).toBe("unknown");
  });
});

describe("sunScenePhase", () => {
  const base = {
    nowMs: 0,
    goldenStartMs: 60 * MIN,
    goldenEndMs: 110 * MIN,
    nextEvent: "sunset" as const,
  };

  it("prefers a real solar elevation over the clock", () => {
    // Clock alone would say "day" here; elevation overrules it.
    expect(sunScenePhase({ ...base, sunElevationDeg: 2 })).toBe("golden");
    expect(sunScenePhase({ ...base, sunElevationDeg: 40 })).toBe("day");
    expect(sunScenePhase({ ...base, sunElevationDeg: 12 })).toBe("before");
    expect(sunScenePhase({ ...base, sunElevationDeg: -5 })).toBe("afterglow");
    expect(sunScenePhase({ ...base, sunElevationDeg: -20 })).toBe("night");
  });

  it("is golden inside the window, at either edge", () => {
    expect(sunScenePhase({ ...base, nowMs: 60 * MIN })).toBe("golden");
    expect(sunScenePhase({ ...base, nowMs: 90 * MIN })).toBe("golden");
    expect(sunScenePhase({ ...base, nowMs: 110 * MIN })).toBe("golden");
  });

  it("distinguishes broad daylight from the approach to sunset", () => {
    expect(sunScenePhase({ ...base, nowMs: 0 })).toBe("before"); // 60 min out
    expect(sunScenePhase({ ...base, nowMs: -300 * MIN })).toBe("day"); // 6 h out
    expect(sunScenePhase({ ...base, goldenStartMs: 200 * MIN, nowMs: 0 })).toBe("day");
    expect(sunScenePhase({ ...base, goldenStartMs: 30 * MIN, nowMs: 0 })).toBe("before");
  });

  it("shows an afterglow only just after sunset, then night", () => {
    const night = {
      nowMs: 100 * MIN,
      goldenStartMs: 700 * MIN,
      goldenEndMs: 760 * MIN,
      nextEvent: "sunrise" as const,
    };
    expect(sunScenePhase({ ...night, lastSunsetMs: 80 * MIN })).toBe("afterglow");
    expect(sunScenePhase({ ...night, lastSunsetMs: 40 * MIN })).toBe("night");
    expect(sunScenePhase(night)).toBe("night");
  });
});
