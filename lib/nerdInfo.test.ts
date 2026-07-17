import { describe, it, expect } from "vitest";
import { buildNerdInfo, SCORE_WEIGHTS_PCT, type NerdContext } from "@/lib/nerdInfo";
import type { ConditionsSnapshot, Wrapped } from "@/lib/types";
import type { Derived } from "@/lib/score";

// A source wrapper whose only load-bearing field here is `.source` (+ optional
// `.data`) — the builders read those for attributions/computations.
function wrap<T>(source: string, data: T | null = null): Wrapped<T> {
  return { source, status: "ok", fetchedAt: "2026-07-16T12:00:00Z", attribution: source, data };
}

// A minimal-but-real snapshot: every source the builders actually touch, with
// the same `.source` strings the real source modules emit (see lib/sources/*).
const snap = {
  weather: wrap("NWS api.weather.gov"),
  metno: wrap("MET Norway"),
  hourly: wrap("Open-Meteo (hourly)"),
  gfs: wrap("NOAA GFS (via Open-Meteo)"),
  buoy: wrap("NOAA NDBC (LKWF1)"),
  marine: wrap("Open-Meteo Marine"),
  goesCloud: wrap("NOAA GOES-19 ABI Clear Sky Mask (satellite-observed cloud)"),
  busyness: wrap("Beach cams + Gemini vision"),
  waterQuality: wrap("FL Healthy Beaches (Palm Beach County)"),
  nws: wrap("NWS (alerts + Surf Zone Forecast)", { alerts: [], ripCurrentRisk: "moderate" as const }),
  sargassum: wrap("Beach cams + Gemini vision"),
  traffic: wrap("HERE Traffic", { level: "moderate" as const, congestion: 45, segments: 8 }),
} as unknown as ConditionsSnapshot;

const d: Derived = {
  airTempF: 84,
  waterTempF: 87,
  windSpeedMph: 9,
  windDirDeg: 90,
  waveHeightFt: 1.5,
  precipProbability: 10,
  uvIndex: 9,
  cloudCoverPct: 30,
  humidityPct: 88,
  dewPointF: 72,
  crowdPct: 40,
  sargassumLevel: "low",
  sargassumCoveragePct: 20,
  flags: ["green"],
  waterAdvisory: false,
  waterRating: "good",
  noSwimAdvisory: false,
  ripCurrentRisk: "moderate",
  severeAlert: false,
};

const ctx: NerdContext = { d, snap };

describe("nerdInfo registry quotes the REAL score.ts constants", () => {
  it("water temp: 9% weight, plateau 77–90°F, live number plugged in", () => {
    const info = buildNerdInfo("waterTemp", ctx);
    expect(info.weightPct).toBe(9);
    expect(info.formula).toContain("77");
    expect(info.formula).toContain("90");
    // 87°F is inside 77–90 → 100/100 → 100 × 9% = 9.0 pts
    expect(info.computation.join(" ")).toContain("87");
    expect(info.computation.join(" ")).toContain("9.0 pts");
  });

  it("uv: 4% weight matches score.ts, curve breakpoint quoted", () => {
    const info = buildNerdInfo("uv", ctx);
    expect(info.weightPct).toBe(SCORE_WEIGHTS_PCT.uv);
    expect(info.weightPct).toBe(4);
    expect(info.formula).toContain("8"); // uvScore = 100 − max(0, UV − 8) × 12
  });

  it("air temp: 16% weight, plateau 78–88°F", () => {
    const info = buildNerdInfo("airTemp", ctx);
    expect(info.weightPct).toBe(16);
    expect(info.formula).toContain("78");
    expect(info.formula).toContain("88");
  });

  it("wind: 13% weight, plateau 5–13 mph sweet spot", () => {
    const info = buildNerdInfo("wind", ctx);
    expect(info.weightPct).toBe(13);
    expect(info.formula).toContain("5");
    expect(info.formula).toContain("13");
    // 9 mph is inside 5–13 → 100/100
    expect(info.computation.join(" ")).toContain("100/100");
  });

  it("seaweed: 7% weight, coverage-curve anchors quoted", () => {
    const info = buildNerdInfo("seaweed", ctx);
    expect(info.weightPct).toBe(7);
    expect(info.formula).toContain("85");
    expect(info.formula).toContain("55");
  });

  it("comfort/dew point: 8% weight, ≤60°F baseline quoted", () => {
    const info = buildNerdInfo("dewPoint", ctx);
    expect(info.weightPct).toBe(8);
    expect(info.formula).toContain("60");
    // RH 88 > 85 → the extra Comfort penalty branch fires
    expect(info.computation.join(" ")).toContain(">85");
  });

  it("water quality: 6% weight, good=100 mapping", () => {
    const info = buildNerdInfo("waterQuality", ctx);
    expect(info.weightPct).toBe(6);
    expect(info.computation.join(" ")).toContain("100");
  });

  it("pulls live per-beach source labels (buoy id) into attributions", () => {
    const info = buildNerdInfo("waterTemp", ctx);
    expect(info.sources.some((s) => s.includes("NOAA NDBC (LKWF1)"))).toBe(true);
    expect(info.sources.some((s) => s.includes("Open-Meteo Marine"))).toBe(true);
  });
});

describe("non-scored cards report null weight and what they feed", () => {
  it("humidity: null weight, feeds Comfort, penalty shown when RH>85", () => {
    const info = buildNerdInfo("humidity", ctx);
    expect(info.weightPct).toBeNull();
    expect(info.formula).toContain("Comfort");
    expect(info.computation.join(" ")).toContain("penalty");
  });

  it("cloud cover: null weight, feeds Sky", () => {
    const info = buildNerdInfo("cloudCover", ctx);
    expect(info.weightPct).toBeNull();
    expect(info.formula).toContain("Sky");
  });

  it("rain chance: null weight, only caps when coded/observed", () => {
    const info = buildNerdInfo("rainChance", ctx);
    expect(info.weightPct).toBeNull();
    expect((info.notes ?? "").toLowerCase()).toContain("chance");
  });

  it("rip current: null weight, moderate → cap at 92", () => {
    const info = buildNerdInfo("ripCurrent", ctx);
    expect(info.weightPct).toBeNull();
    expect(info.computation.join(" ")).toContain("92");
  });

  it("traffic: null weight, explicitly not scored", () => {
    const info = buildNerdInfo("traffic", ctx);
    expect(info.weightPct).toBeNull();
    expect(info.formula.toLowerCase()).toContain("not");
    expect(info.sources).toContain("HERE Traffic");
  });
});

describe("display weights mirror the score.ts sub-score weights", () => {
  it("the 11 sub-score weights still sum to 100%", () => {
    const sum = Object.values(SCORE_WEIGHTS_PCT).reduce((a, b) => a + b, 0);
    expect(sum).toBe(100);
  });
});
