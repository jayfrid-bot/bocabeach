import { describe, expect, it } from "vitest";
import { explainScore } from "@/lib/explain";
import { DEFAULT_SCORING, scoreBeachDay, type Derived } from "@/lib/score";
import { profileLabel, resolveScoring } from "@/lib/profile/resolve";
import type { ScoreProfile } from "@/lib/profile/types";

const base = (over: Partial<Derived> = {}): Derived => ({
  flags: ["green"],
  waterAdvisory: false,
  waterRating: "good",
  noSwimAdvisory: false,
  ripCurrentRisk: "low",
  severeAlert: false,
  airTempF: 83,
  waterTempF: 82,
  windSpeedMph: 8,
  waveHeightFt: 1,
  cloudCoverPct: 10,
  precipProbability: 5,
  shortForecast: "Sunny",
  humidityPct: 60,
  dewPointF: 62,
  uvIndex: 6,
  sandTempF: 100,
  sargassumLevel: "none",
  crowdPct: 20,
  ...over,
});

const profile = (over: Partial<ScoreProfile>): ScoreProfile => ({
  profiles: ["snorkel"],
  heat: "normal",
  crowds: "normal",
  ...over,
});

const explainFor = (d: Derived, p: ScoreProfile) => {
  const opts = resolveScoring(p);
  return explainScore(d, scoreBeachDay(d, opts), opts, profileLabel(p));
};

describe("explainScore summary", () => {
  const d = base();

  it("is word-for-word the free summary with no options", () => {
    const free = explainScore(d, scoreBeachDay(d)).summary;
    expect(free).toBe(explainScore(d, scoreBeachDay(d), DEFAULT_SCORING).summary);
    expect(free).toMatch(/^We add points for sunshine/);
    expect(free).toMatch(/water-quality advisory hard-caps the whole score\.$/);
  });

  it("names what a profile leads with", () => {
    const s = explainFor({ ...d, clarityPct: 80 }, profile({ profiles: ["snorkel"] })).summary;
    expect(s).toMatch(/^Tuned for snorkeling: /);
    expect(s).toContain("water clarity");
    expect(s).toContain("calm water");
    expect(s).toContain("lead.");
  });

  it("says surf, not calm water, for a surfer", () => {
    const s = explainFor(d, profile({ profiles: ["surf"] })).summary;
    expect(s).toMatch(/^Tuned for surfing: /);
    expect(s).toContain("rideable surf");
    expect(s).not.toContain("calm water");
  });

  it("names both profiles in a blend", () => {
    const s = explainFor(d, profile({ profiles: ["dog", "walk"] })).summary;
    expect(s).toMatch(/^Tuned for dog walks and beach walks: /);
  });

  it("tells the truth about which caps still apply", () => {
    expect(explainFor(d, profile({ profiles: ["sun"] })).summary).toContain("safety line");
    expect(explainFor(d, profile({ profiles: ["surf"] })).summary).toMatch(/not a stop sign/);
    expect(explainFor(d, profile({ profiles: ["swim"] })).summary).toMatch(/flags, and advisories/);
  });

  it("still explains itself with weights but no profile name", () => {
    const s = explainScore(d, scoreBeachDay(d), resolveScoring(profile({ profiles: ["dog"] })));
    expect(s.summary).toMatch(/lead this score\./);
    expect(s.summary).not.toContain("Tuned for");
  });
});

describe("explainScore reasons", () => {
  it("reads out water clarity when the person scores on it", () => {
    const clear = explainFor(base({ clarityPct: 92 }), profile({ profiles: ["snorkel"] }));
    expect(clear.helping.some((r) => /clear/i.test(r.text))).toBe(true);
    const murky = explainFor(base({ clarityPct: 12 }), profile({ profiles: ["snorkel"] }));
    expect(murky.hurting.some((r) => /murky/i.test(r.text))).toBe(true);
  });

  it("never mentions clarity in the free score", () => {
    const d = base({ clarityPct: 12 });
    const r = explainScore(d, scoreBeachDay(d));
    expect([...r.helping, ...r.hurting].some((x) => /clarity|murky/i.test(x.text))).toBe(false);
  });
});
