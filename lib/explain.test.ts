import { describe, expect, it } from "vitest";
import { explainScore } from "@/lib/explain";
import type { Derived } from "@/lib/score";
import type { ScoreResult, SubScore } from "@/lib/types";

const sub = (
  key: string,
  label: string,
  score: number | null,
  weight: number,
  display?: string,
): SubScore => ({ key, label, score, weight, display });

const baseDerived: Derived = {
  flags: ["green"],
  waterAdvisory: false,
  waterRating: "good",
  noSwimAdvisory: false,
  ripCurrentRisk: "low",
  severeAlert: false,
};

const mkResult = (
  subs: SubScore[],
  caps: string[] = [],
): ScoreResult => ({
  score: 80,
  rawScore: 80,
  rating: "Excellent",
  subScores: subs,
  caps,
});

describe("explainScore", () => {
  it("puts high sub-scores in helping and low ones in hurting; skips middling", () => {
    const d: Derived = { ...baseDerived, airTempF: 84, windSpeedMph: 22, uvIndex: 11 };
    const r = explainScore(
      d,
      mkResult([
        sub("airTemp", "Air temperature", 95, 0.16, "84°F"),
        sub("sky", "Sky", 65, 0.16, "Partly Sunny"), // middling — dropped
        sub("wind", "Wind", 25, 0.13, "22 mph"),
        sub("uv", "UV index", 20, 0.04, "11"),
      ]),
    );
    expect(r.helping.some((x) => x.text.includes("84°F"))).toBe(true);
    expect(r.hurting.some((x) => x.text.includes("22 mph"))).toBe(true);
    expect(r.hurting.some((x) => x.text.toLowerCase().includes("uv"))).toBe(true);
    expect(r.helping.some((x) => x.text.includes("Sky"))).toBe(false);
    expect(r.hurting.some((x) => x.text.includes("Sky"))).toBe(false);
  });

  it("surfaces caps at the top of the hurting list with cap-appropriate emoji", () => {
    const r = explainScore(
      baseDerived,
      mkResult(
        [sub("airTemp", "Air temperature", 95, 0.16, "84°F")],
        ["Heavy seaweed (sargassum) on the beach", "Thunderstorm in the forecast"],
      ),
    );
    expect(r.hurting.length).toBeGreaterThanOrEqual(2);
    expect(r.hurting[0].emoji).toBe("🪸");
    expect(r.hurting[1].emoji).toBe("⛈️");
  });

  it("handles missing values without throwing or inventing reasons", () => {
    const r = explainScore(
      baseDerived,
      mkResult([sub("airTemp", "Air temperature", null, 0.16)]),
    );
    expect(r.helping).toEqual([]);
    expect(r.hurting).toEqual([]);
  });

  it("uses the sand-verdict bands when sand is scorching", () => {
    const d: Derived = { ...baseDerived, sandTempF: 140 };
    const r = explainScore(
      d,
      mkResult([sub("sandTemp", "Sand temperature (barefoot)", 15, 0.08, "~140°F")]),
    );
    const sand = r.hurting.find((x) => x.text.includes("scorching"));
    expect(sand).toBeTruthy();
    expect(sand!.text).toMatch(/burn|shoes|wear/i);
  });

  it("always returns a non-empty summary explaining the score model", () => {
    const r = explainScore(baseDerived, mkResult([]));
    expect(r.summary.length).toBeGreaterThan(30);
    expect(r.summary.toLowerCase()).toMatch(/points/);
  });
});
