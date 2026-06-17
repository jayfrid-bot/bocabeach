import { describe, it, expect } from "vitest";
import { rankByDistance } from "@/lib/resolve/rank";
import {
  BOCA_BEACH,
  TIDE_FIXTURE,
  BUOY_FIXTURE,
} from "@/lib/resolve/__fixtures__/registries";

describe("rankByDistance", () => {
  it("sorts ascending by distance from the origin", () => {
    const { ranked } = rankByDistance(BOCA_BEACH, TIDE_FIXTURE);
    expect(ranked.map((r) => r.id)).toEqual([
      "8722816", // Boca Raton ~0.26mi
      "8722670", // Lake Worth Pier ~17.7mi
      "8723214", // Virginia Key ~43.7mi
      "9410230", // La Jolla, CA — far decoy, last
    ]);
    // distances are monotonically non-decreasing
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i].distanceMi).toBeGreaterThanOrEqual(ranked[i - 1].distanceMi);
    }
  });

  it("annotates each item with distanceMi and bearingDeg", () => {
    const { ranked } = rankByDistance(BOCA_BEACH, TIDE_FIXTURE);
    const nearest = ranked[0];
    expect(nearest.id).toBe("8722816");
    expect(nearest.distanceMi).toBeCloseTo(0.26, 1);
    // Lake Worth Pier sits north and slightly east of the Boca point -> NNE.
    const lwp = ranked.find((r) => r.id === "8722670")!;
    expect(lwp.bearingDeg).toBeGreaterThan(0);
    expect(lwp.bearingDeg).toBeLessThan(22.5);
    // never selects the far California decoy as nearest
    expect(ranked.at(-1)!.id).toBe("9410230");
    expect(ranked.at(-1)!.distanceMi).toBeGreaterThan(2000);
  });

  it("flags ambiguity when the top two are within the default tie window (5mi)", () => {
    // Two stations both ~0.x mi from origin, within 5 mi of each other.
    const close = [
      { id: "a", lat: 26.3587, lon: -80.0686 },
      { id: "b", lat: 26.36, lon: -80.07 },
      { id: "c", lat: 27.0, lon: -80.5 },
    ];
    const { ranked, ambiguous } = rankByDistance(BOCA_BEACH, close);
    expect(ranked[0].id).toBe("a");
    expect(ambiguous).toBe(true);
  });

  it("is not ambiguous when the nearest is a clear winner", () => {
    // Boca tide stations: nearest ~0.26mi, second ~17.7mi -> gap >> 5mi.
    const { ambiguous } = rankByDistance(BOCA_BEACH, TIDE_FIXTURE);
    expect(ambiguous).toBe(false);
  });

  it("honors a custom tieMiles threshold", () => {
    // ~17.4mi gap between the two nearest tide stations.
    expect(rankByDistance(BOCA_BEACH, TIDE_FIXTURE, { tieMiles: 1 }).ambiguous).toBe(false);
    expect(rankByDistance(BOCA_BEACH, TIDE_FIXTURE, { tieMiles: 20 }).ambiguous).toBe(true);
  });

  it("treats fewer than two items as unambiguous", () => {
    expect(rankByDistance(BOCA_BEACH, []).ambiguous).toBe(false);
    expect(rankByDistance(BOCA_BEACH, [TIDE_FIXTURE[0]]).ambiguous).toBe(false);
  });

  it("does not mutate the input array order", () => {
    const input = [...BUOY_FIXTURE];
    const firstId = input[0].id;
    rankByDistance(BOCA_BEACH, input);
    expect(input[0].id).toBe(firstId);
  });

  it("preserves the item's own fields on the ranked output (generic over T)", () => {
    const { ranked } = rankByDistance(BOCA_BEACH, BUOY_FIXTURE);
    const lkwf1 = ranked.find((r) => r.id === "LKWF1")!;
    // original capability flags survive alongside the injected distance/bearing
    expect(lkwf1.hasWaves).toBe(false);
    expect(lkwf1.hasWaterTemp).toBe(true);
    expect(typeof lkwf1.distanceMi).toBe("number");
    expect(typeof lkwf1.bearingDeg).toBe("number");
  });
});
