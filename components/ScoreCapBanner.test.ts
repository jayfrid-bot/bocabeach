import { describe, it, expect } from "vitest";
import { capState } from "@/components/ScoreCapBanner";
import type { ScoreResult } from "@/lib/types";

const base = (over: Partial<ScoreResult>): ScoreResult => ({
  score: 74, rawScore: 74, rating: "Good", subScores: [], caps: [], dataAvailable: true, ...over,
});

describe("capState", () => {
  it("hidden when no cap", () => {
    expect(capState(base({}))).toEqual({ show: false, safety: false });
  });
  it("hidden when caps present but score not actually lowered", () => {
    // e.g. an advisory cap at 40 but the weighted score was already 30
    expect(capState(base({ caps: ["Rain in the forecast"], score: 30, rawScore: 30 })).show).toBe(false);
  });
  it("hidden during a total data outage", () => {
    expect(capState(base({ caps: ["Lightning within 5 miles — get out of the water"], score: 10, rawScore: 80, dataAvailable: false })).show).toBe(false);
  });
  it("safety tone for a get-out-of-the-water cap", () => {
    expect(capState(base({ caps: ["Lightning within 5 miles — get out of the water"], score: 10, rawScore: 80 }))).toEqual({ show: true, safety: true });
  });
  it("safety tone for flags, advisories, rip, surf, severe", () => {
    for (const c of ["Double red flag — water access closed", "Water quality advisory in effect", "High rip current risk (NWS)", "High surf or coastal-flood advisory — swimming discouraged", "Severe weather warning in effect"]) {
      expect(capState(base({ caps: [c], score: 15, rawScore: 70 })).safety).toBe(true);
    }
  });
  it("quiet (non-safety) tone for weather-quality caps", () => {
    for (const c of ["High wind — over 20 mph", "Heavy seaweed — ~75% of the beach covered", "Rain in the forecast"]) {
      const s = capState(base({ caps: [c], score: 15, rawScore: 70 }));
      expect(s.show).toBe(true);
      expect(s.safety).toBe(false);
    }
  });
});
