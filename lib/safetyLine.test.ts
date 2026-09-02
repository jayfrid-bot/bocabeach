import { describe, expect, it } from "vitest";
import { surfConditions, swimSafety } from "@/lib/safetyLine";
import type { Derived } from "@/lib/score";
import type { ConditionsSnapshot, LightningData, Wrapped } from "@/lib/types";

const base = (over: Partial<Derived> = {}): Derived => ({
  flags: ["green"],
  waterAdvisory: false,
  waterRating: "good",
  noSwimAdvisory: false,
  ripCurrentRisk: "low",
  severeAlert: false,
  waveHeightFt: 1,
  ...over,
});

/** Only the field the safety line reads — enough to exercise the distance copy. */
const snapWithStrike = (nearestMi: number) =>
  ({
    lightning: {
      source: "test",
      status: "ok",
      fetchedAt: "",
      attribution: "test",
      data: { nearestMi } as LightningData,
    } as Wrapped<LightningData>,
  }) as unknown as ConditionsSnapshot;

describe("swimSafety", () => {
  it("says safe on a calm, green-flag day, with nothing to add", () => {
    const r = swimSafety(base());
    expect(r.level).toBe("safe");
    expect(r.reasons).toEqual([]);
  });

  it("stay-out on a double red, a red flag, severe weather, or dirty water", () => {
    expect(swimSafety(base({ flags: ["double-red"] })).level).toBe("stay-out");
    expect(swimSafety(base({ flags: ["red"] })).level).toBe("stay-out");
    expect(swimSafety(base({ severeAlert: true })).level).toBe("stay-out");
    expect(swimSafety(base({ waterAdvisory: true })).level).toBe("stay-out");
    expect(swimSafety(base({ noSwimAdvisory: true })).level).toBe("stay-out");
    expect(swimSafety(base({ lightningWithin5mi: true })).level).toBe("stay-out");
  });

  it("reuses the score's wording so nothing is said two ways", () => {
    expect(swimSafety(base({ flags: ["double-red"] })).reasons[0]).toBe(
      "Double red flag — water access closed",
    );
    expect(swimSafety(base({ flags: ["red"] })).reasons[0]).toBe(
      "Red flag — high hazard, swimming discouraged",
    );
    expect(swimSafety(base({ waterAdvisory: true })).reasons[0]).toBe(
      "Water quality advisory in effect",
    );
  });

  it("names the distance when the strike feed knows it", () => {
    const d = base({ lightningWithin5mi: true });
    expect(swimSafety(d).reasons[0]).toBe("Lightning within 5 miles — get out of the water");
    expect(swimSafety(d, snapWithStrike(2.4)).reasons[0]).toBe(
      "Lightning 2.4 miles away — get out of the water",
    );
  });

  it("caution on rip current, big waves, thunder, or a surf advisory", () => {
    expect(swimSafety(base({ ripCurrentRisk: "moderate" })).level).toBe("caution");
    expect(swimSafety(base({ ripCurrentRisk: "high" })).level).toBe("caution");
    expect(swimSafety(base({ waveHeightFt: 5 })).level).toBe("caution");
    expect(swimSafety(base({ surfAdvisory: true })).level).toBe("caution");
    const thunder = swimSafety(base({ weatherCode: 95, precipProbability: 80 }));
    expect(thunder.level).toBe("caution");
    expect(thunder.reasons).toContain("Thunderstorm in the forecast");
  });

  it("4 ft is fine; over 4 ft is a caution, and says the height", () => {
    expect(swimSafety(base({ waveHeightFt: 4 })).level).toBe("safe");
    expect(swimSafety(base({ waveHeightFt: 4.5 })).reasons[0]).toBe("Rough water — 4.5 ft waves");
  });

  it("leads with the reason that decided the call", () => {
    const r = swimSafety(base({ flags: ["red"], ripCurrentRisk: "high", waveHeightFt: 6 }));
    expect(r.level).toBe("stay-out");
    expect(r.reasons[0]).toMatch(/Red flag/);
    expect(r.reasons).toHaveLength(3);
  });
});

describe("surfConditions", () => {
  it("go on an ordinary day", () => {
    const r = surfConditions(base({ waveHeightFt: 3 }));
    expect(r.level).toBe("go");
    expect(r.reasons).toEqual([]);
  });

  it("closed only for a closure: double red, lightning, severe weather", () => {
    expect(surfConditions(base({ flags: ["double-red"] })).level).toBe("closed");
    expect(surfConditions(base({ lightningWithin5mi: true })).level).toBe("closed");
    expect(surfConditions(base({ severeAlert: true })).level).toBe("closed");
  });

  it("experienced only for a red flag, a high rip, a surf advisory, or 6+ ft", () => {
    expect(surfConditions(base({ flags: ["red"] })).level).toBe("experienced");
    expect(surfConditions(base({ ripCurrentRisk: "high" })).level).toBe("experienced");
    expect(surfConditions(base({ surfAdvisory: true })).level).toBe("experienced");
    expect(surfConditions(base({ waveHeightFt: 8 })).level).toBe("experienced");
    expect(surfConditions(base({ waveHeightFt: 6 })).level).toBe("go");
  });

  it("a moderate rip is not a surfer's problem", () => {
    expect(surfConditions(base({ ripCurrentRisk: "moderate" })).level).toBe("go");
  });

  it("dirty water is worth saying, but the call is still the surfer's", () => {
    const r = surfConditions(base({ waterAdvisory: true }));
    expect(r.level).toBe("go");
    expect(r.reasons).toEqual(["Water quality advisory in effect"]);
  });

  it("names big surf with the height", () => {
    expect(surfConditions(base({ waveHeightFt: 8 })).reasons[0]).toBe("Big surf — 8 ft waves");
  });
});
