import { describe, expect, it } from "vitest";
import { PRESETS, PROFILE_IDS, isProfileId, profileChip } from "@/lib/profile/presets";
import { DEFAULT_SCORING } from "@/lib/score";
import type { PresetId } from "@/lib/profile/types";
import type { SubKey } from "@/lib/types";

const ALL = Object.keys(PRESETS) as PresetId[];
const KEYS = Object.keys(DEFAULT_SCORING.weights) as SubKey[];

describe("profile presets", () => {
  it("has all eight columns from the roadmap table", () => {
    expect(ALL.sort()).toEqual(
      ["everyone", "swim", "kids", "sun", "snorkel", "dog", "walk", "surf"].sort(),
    );
    expect(PROFILE_IDS).toHaveLength(7);
    expect(PROFILE_IDS).not.toContain("everyone");
  });

  it("every preset's weights sum to 1", () => {
    for (const id of ALL) {
      const total = KEYS.reduce((a, k) => a + PRESETS[id].weights[k], 0);
      expect(Math.abs(total - 1), `${id} sums to ${total}`).toBeLessThan(1e-9);
    }
  });

  it("every preset weights every factor (no missing keys, none negative)", () => {
    for (const id of ALL) {
      for (const key of KEYS) {
        expect(typeof PRESETS[id].weights[key], `${id}.${key}`).toBe("number");
        expect(PRESETS[id].weights[key]).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("'everyone' IS the free score — same weights as DEFAULT_SCORING", () => {
    expect(PRESETS.everyone.weights).toEqual(DEFAULT_SCORING.weights);
    expect(PRESETS.everyone.ideals).toEqual(DEFAULT_SCORING.ideals);
    expect(PRESETS.everyone.capPolicy).toBe(DEFAULT_SCORING.capPolicy);
  });

  it("only snorkeling cares about water clarity", () => {
    for (const id of ALL) {
      if (id === "snorkel") expect(PRESETS[id].weights.clarity).toBeCloseTo(0.2, 10);
      else expect(PRESETS[id].weights.clarity).toBe(0);
    }
  });

  it("puts each profile in the right cap policy", () => {
    expect(PRESETS.surf.capPolicy).toBe("surf");
    for (const id of ["swim", "kids", "snorkel"] as PresetId[]) {
      expect(PRESETS[id].capPolicy).toBe("water");
    }
    for (const id of ["sun", "dog", "walk"] as PresetId[]) {
      expect(PRESETS[id].capPolicy).toBe("shore");
    }
  });

  it("only surfing wants waves; the ideal bands run cool-to-hot as the table says", () => {
    expect(PRESETS.surf.ideals.waveMode).toBe("surf");
    for (const id of ALL.filter((i) => i !== "surf")) {
      expect(PRESETS[id].ideals.waveMode).toBe("calm");
    }
    // Walking wants it coolest, sunbathing hottest.
    expect(PRESETS.walk.ideals.airPlateau[0]).toBeLessThan(PRESETS.dog.ideals.airPlateau[0]);
    expect(PRESETS.dog.ideals.airPlateau[0]).toBeLessThan(PRESETS.sun.ideals.airPlateau[0]);
  });

  it("names profiles for copy and for chips", () => {
    expect(PRESETS.snorkel.label).toBe("snorkeling");
    expect(profileChip("snorkel")).toBe("Snorkeling");
    expect(isProfileId("surf")).toBe(true);
    expect(isProfileId("everyone")).toBe(false); // not pickable
    expect(isProfileId("nonsense")).toBe(false);
    expect(isProfileId(undefined)).toBe(false);
  });
});
