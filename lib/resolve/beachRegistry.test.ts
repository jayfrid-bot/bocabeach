import { describe, expect, it } from "vitest";

import { BEACH_FIXTURE, BOCA_BEACH } from "./__fixtures__/registries";
import {
  loadBeachRegistry,
  matchBeachByName,
  nearestBeaches,
} from "./beachRegistry";

describe("nearestBeaches", () => {
  it("returns Red Reef Park first from the Boca point", () => {
    const out = nearestBeaches(BEACH_FIXTURE, {
      lat: BOCA_BEACH.lat,
      lon: BOCA_BEACH.lon,
    });
    expect(out[0].name).toBe("Red Reef Park");
    expect(out[0].distanceMi).toBe(0);
  });

  it("excludes the inland coastalConfirmed:false entry", () => {
    const out = nearestBeaches(BEACH_FIXTURE, {
      lat: BOCA_BEACH.lat,
      lon: BOCA_BEACH.lon,
      maxMiles: 5000, // wide enough to reach MN/CA if not gated
    });
    expect(out.map((b) => b.name)).not.toContain("Lake Calhoun Beach");
  });

  it("is sorted ascending by distance and respects maxMiles + limit", () => {
    const out = nearestBeaches(BEACH_FIXTURE, {
      lat: BOCA_BEACH.lat,
      lon: BOCA_BEACH.lon,
      maxMiles: 30,
    });
    // Within 30mi of Boca: Red Reef (0), South Beach Park (~0.9), Fort
    // Lauderdale (~15). Miami "South Beach" (~40) and CA/MN are out of range.
    expect(out.map((b) => b.name)).toEqual([
      "Red Reef Park",
      "South Beach Park",
      "Fort Lauderdale Beach",
    ]);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].distanceMi).toBeGreaterThanOrEqual(out[i - 1].distanceMi);
    }
    expect(out[0]).toHaveProperty("bearingDeg");
  });

  it("honors the limit", () => {
    const out = nearestBeaches(BEACH_FIXTURE, {
      lat: BOCA_BEACH.lat,
      lon: BOCA_BEACH.lon,
      maxMiles: 5000,
      limit: 2,
    });
    expect(out).toHaveLength(2);
    expect(out[0].name).toBe("Red Reef Park");
  });
});

describe("matchBeachByName", () => {
  it('finds the Miami "South Beach" entry case-insensitively', () => {
    const hits = matchBeachByName(BEACH_FIXTURE, "south beach");
    const names = hits.map((b) => b.name);
    expect(names).toContain("South Beach");
    // Token match also pulls "South Beach Park"; the Miami exact name is present.
    const miami = hits.find((b) => b.name === "South Beach");
    expect(miami?.state).toBe("FL");
    expect(miami?.lat).toBeCloseTo(25.7826, 3);
  });

  it("matches across states and returns [] for a blank query", () => {
    expect(matchBeachByName(BEACH_FIXTURE, "santa monica")[0].state).toBe("CA");
    expect(matchBeachByName(BEACH_FIXTURE, "   ")).toEqual([]);
  });
});

describe("loadBeachRegistry", () => {
  it("returns [] when the registry file is absent (no throw)", () => {
    // A missing/unreadable registry must degrade to an empty array, not throw.
    expect(loadBeachRegistry("data/registry/__does_not_exist__.json")).toEqual([]);
  });

  it("loads the built registry from disk when present", () => {
    // The committed registry snapshot should parse to a non-empty array of
    // valid entries (US beaches with coords + state).
    const reg = loadBeachRegistry();
    expect(Array.isArray(reg)).toBe(true);
    expect(reg.length).toBeGreaterThan(0);
    expect(reg.every((b) => typeof b.name === "string" && Number.isFinite(b.lat))).toBe(true);
  });
});
