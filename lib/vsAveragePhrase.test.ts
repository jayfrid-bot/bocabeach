import { describe, it, expect } from "vitest";
import {
  busynessVsAvgPhrase,
  seaweedVsAvgPhrase,
  roundToNearest5,
  TYPICAL_BAND_PCT,
} from "@/lib/vsAveragePhrase";

describe("roundToNearest5", () => {
  it("rounds displayed deltas to the nearest 5", () => {
    expect(roundToNearest5(8.19)).toBe(10);
    expect(roundToNearest5(12)).toBe(10);
    expect(roundToNearest5(13)).toBe(15);
    expect(roundToNearest5(2)).toBe(0);
  });
});

describe("busynessVsAvgPhrase", () => {
  const P = (deltaPct: number | null, extra: Record<string, unknown> = {}) =>
    busynessVsAvgPhrase({ deltaPct, weekday: "Tuesday", ...extra });

  it("widens the typical band to ±10% on the RAW delta", () => {
    expect(TYPICAL_BAND_PCT).toBe(10);
    expect(P(8.19)).toEqual({ text: "about typical for a Tuesday", tone: "typical" });
    expect(P(-9.9)).toEqual({ text: "about typical for a Tuesday", tone: "typical" });
    expect(P(10)).toEqual({ text: "about typical for a Tuesday", tone: "typical" });
  });

  it("rounds a busier delta to the nearest 5%", () => {
    // 22.3 → 20; 12.4 (>10 band) → 10.
    expect(P(22.3)).toEqual({ text: "≈20% busier than the average Tuesday", tone: "busier" });
    expect(P(12.4)).toEqual({ text: "≈10% busier than the average Tuesday", tone: "busier" });
  });

  it("rounds a quieter delta to the nearest 5% (emerald)", () => {
    expect(P(-27)).toEqual({ text: "≈25% quieter than the average Tuesday", tone: "quieter" });
  });

  it("names the unit on the deltaPts fallback and never renders +0", () => {
    expect(P(null, { deltaPts: 12.2 })).toEqual({
      text: "≈12 points fuller than usual",
      tone: "busier",
    });
    expect(P(null, { deltaPts: -12 })).toEqual({
      text: "≈12 points emptier than usual",
      tone: "quieter",
    });
    // A deltaPts that rounds to 0 reads as typical, never "+0".
    expect(P(null, { deltaPts: 0.2 })).toEqual({
      text: "about typical for a Tuesday",
      tone: "typical",
    });
  });

  it("returns null when there's nothing to say", () => {
    expect(P(null)).toBeNull();
  });
});

describe("seaweedVsAvgPhrase", () => {
  it("returns '' until there's data", () => {
    expect(seaweedVsAvgPhrase()).toBe("");
    expect(seaweedVsAvgPhrase({ deltaPct: null })).toBe("");
  });

  it("treats ±10% as typical and rounds the rest to the nearest 5%", () => {
    expect(seaweedVsAvgPhrase({ deltaPct: 8.19 })).toBe(" · typical seaweed for this beach");
    expect(seaweedVsAvgPhrase({ deltaPct: 22.3 })).toBe(" · ≈20% more seaweed than average");
    expect(seaweedVsAvgPhrase({ deltaPct: -33 })).toBe(" · ≈35% less seaweed than average");
  });

  it("names the unit on the deltaPts fallback and never renders +0", () => {
    expect(seaweedVsAvgPhrase({ deltaPct: null, deltaPts: 12 })).toBe(
      " · ≈12 points more coverage than usual",
    );
    expect(seaweedVsAvgPhrase({ deltaPct: null, deltaPts: -12 })).toBe(
      " · ≈12 points less coverage than usual",
    );
    expect(seaweedVsAvgPhrase({ deltaPct: null, deltaPts: 0.3 })).toBe(
      " · typical seaweed for this beach",
    );
  });
});
