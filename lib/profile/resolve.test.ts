import { describe, expect, it } from "vitest";
import { profileLabel, resolveScoring } from "@/lib/profile/resolve";
import { PRESETS } from "@/lib/profile/presets";
import { DEFAULT_SCORING } from "@/lib/score";
import type { ScoreProfile } from "@/lib/profile/types";
import type { SubKey } from "@/lib/types";

const KEYS = Object.keys(DEFAULT_SCORING.weights) as SubKey[];
const sum = (w: Record<SubKey, number>) => KEYS.reduce((a, k) => a + w[k], 0);

const profile = (over: Partial<ScoreProfile> = {}): ScoreProfile => ({
  profiles: ["swim"],
  heat: "normal",
  crowds: "normal",
  ...over,
});

describe("resolveScoring", () => {
  it("no profile → the free score, exactly", () => {
    expect(resolveScoring(null)).toEqual(DEFAULT_SCORING);
  });

  it("an empty or unknown profile list falls back to the free score", () => {
    expect(resolveScoring(profile({ profiles: [] }))).toEqual(DEFAULT_SCORING);
    expect(
      resolveScoring(profile({ profiles: ["nonsense" as unknown as "swim"] })),
    ).toEqual(DEFAULT_SCORING);
  });

  it("one profile resolves to that preset's weights, ideals, and cap policy", () => {
    const r = resolveScoring(profile({ profiles: ["snorkel"] }));
    for (const key of KEYS) expect(r.weights[key]).toBeCloseTo(PRESETS.snorkel.weights[key], 10);
    expect(r.ideals).toEqual(PRESETS.snorkel.ideals);
    expect(r.capPolicy).toBe("water");
  });

  it("always renormalizes to a weight total of 1", () => {
    const cases: ScoreProfile[] = [
      profile({ profiles: ["surf"] }),
      profile({ profiles: ["dog", "walk"], heat: "cooler", crowds: "high" }),
      profile({ profiles: ["kids"], advanced: { mult: { crowds: 3, uv: 0, waves: 0.5 } } }),
    ];
    for (const p of cases) expect(Math.abs(sum(resolveScoring(p).weights) - 1)).toBeLessThan(1e-9);
  });

  it("two profiles average their vectors and their ideals", () => {
    const r = resolveScoring(profile({ profiles: ["swim", "surf"] }));
    for (const key of KEYS) {
      const expected = (PRESETS.swim.weights[key] + PRESETS.surf.weights[key]) / 2;
      expect(r.weights[key]).toBeCloseTo(expected, 10);
    }
    // swim air 78-88, surf air 70-90 → 74-89.
    expect(r.ideals.airPlateau).toEqual([74, 89]);
    // Waves can't be averaged: the stronger appetite wins.
    expect(r.ideals.waveMode).toBe("surf");
    // And a surfer in the blend takes the surf cap policy.
    expect(r.capPolicy).toBe("surf");
  });

  it("cap policy: surf wins over water, water over shore", () => {
    expect(resolveScoring(profile({ profiles: ["walk", "surf"] })).capPolicy).toBe("surf");
    expect(resolveScoring(profile({ profiles: ["walk", "kids"] })).capPolicy).toBe("water");
    expect(resolveScoring(profile({ profiles: ["dog", "sun"] })).capPolicy).toBe("shore");
  });

  it("heat slides the ideal air band 5°F and the water band 2°F", () => {
    const hot = resolveScoring(profile({ heat: "hot" }));
    const cool = resolveScoring(profile({ heat: "cooler" }));
    expect(hot.ideals.airPlateau).toEqual([83, 93]);
    expect(hot.ideals.waterPlateau).toEqual([79, 92]);
    expect(cool.ideals.airPlateau).toEqual([73, 83]);
    expect(cool.ideals.waterPlateau).toEqual([75, 88]);
    // Normal leaves the preset alone.
    expect(resolveScoring(profile()).ideals.airPlateau).toEqual(PRESETS.swim.ideals.airPlateau);
  });

  it("crowd sensitivity scales only the crowd factor, up and down", () => {
    const base = resolveScoring(profile()).weights;
    const high = resolveScoring(profile({ crowds: "high" })).weights;
    const low = resolveScoring(profile({ crowds: "low" })).weights;
    expect(high.crowds).toBeGreaterThan(base.crowds);
    expect(low.crowds).toBeLessThan(base.crowds);
    // 0.04 × 2.4 = 0.096, renormalized over a 1.056 total.
    expect(high.crowds).toBeCloseTo(0.096 / 1.056, 10);
    expect(low.crowds).toBeCloseTo(0.016 / 0.976, 10);
    // Everything else keeps its share relative to the others.
    expect(high.waves / high.airTemp).toBeCloseTo(base.waves / base.airTemp, 10);
  });

  it("advanced multipliers scale a factor, and 0 removes it", () => {
    const r = resolveScoring(profile({ advanced: { mult: { waves: 0, sky: 3 } } }));
    expect(r.weights.waves).toBe(0);
    expect(r.weights.sky).toBeGreaterThan(PRESETS.swim.weights.sky);
    expect(Math.abs(sum(r.weights) - 1)).toBeLessThan(1e-9);
  });

  it("advanced ideals override the profile and the heat setting", () => {
    const r = resolveScoring(
      profile({
        heat: "hot",
        advanced: { airIdeal: [60, 70], waterIdeal: [70, 75], wavePref: "some" },
      }),
    );
    expect(r.ideals.airPlateau).toEqual([60, 70]);
    expect(r.ideals.waterPlateau).toEqual([70, 75]);
    expect(r.ideals.waveMode).toBe("some");
  });

  it("zeroing every factor falls back to the profile's own weights", () => {
    const mult = Object.fromEntries(KEYS.map((k) => [k, 0]));
    const r = resolveScoring(profile({ advanced: { mult } }));
    expect(Math.abs(sum(r.weights) - 1)).toBeLessThan(1e-9);
    expect(r.weights.waves).toBeCloseTo(PRESETS.swim.weights.waves, 10);
  });

  it("never mutates the presets or the default options", () => {
    const before = JSON.stringify({ presets: PRESETS, def: DEFAULT_SCORING });
    resolveScoring(profile({ profiles: ["surf", "swim"], heat: "hot", crowds: "high" }));
    expect(JSON.stringify({ presets: PRESETS, def: DEFAULT_SCORING })).toBe(before);
  });
});

describe("profileLabel", () => {
  it("names one profile, two profiles, and no profile", () => {
    expect(profileLabel(profile({ profiles: ["snorkel"] }))).toBe("snorkeling");
    expect(profileLabel(profile({ profiles: ["swim", "snorkel"] }))).toBe(
      "swimming and snorkeling",
    );
    expect(profileLabel(null)).toBe("everyone");
    expect(profileLabel(profile({ profiles: [] }))).toBe("everyone");
  });
});
