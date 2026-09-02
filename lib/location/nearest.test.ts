import { describe, expect, it } from "vitest";
import { listLocations, toPublicLocation } from "@/config/locations";
import { nearestServedBeach, rankBeaches, isWithinMi } from "@/lib/location/nearest";
import type { LocationPublic } from "@/lib/types";

const BEACHES: LocationPublic[] = listLocations().map(toPublicLocation);

// A point inside Boca Raton, near (but not exactly on) the town's own coords.
const BOCA_COORD = { lat: 26.35, lon: -80.07 };

describe("nearestServedBeach", () => {
  it("picks the closest of the real served beaches for a Boca coordinate", () => {
    expect(BEACHES.length).toBeGreaterThan(30);
    const result = nearestServedBeach(BOCA_COORD.lat, BOCA_COORD.lon, BEACHES);
    expect(result).not.toBeNull();
    expect(result!.beach.slug).toBe("boca-raton");
    expect(result!.distanceMi).toBeGreaterThanOrEqual(0);
    expect(result!.distanceMi).toBeLessThan(5);
  });

  it("returns null for an empty list", () => {
    expect(nearestServedBeach(26.35, -80.07, [])).toBeNull();
  });

  it("picks the single nearest of a small synthetic set, regardless of input order", () => {
    const synthetic: LocationPublic[] = [
      { slug: "far", name: "Far", region: "", lat: 40, lon: -74, timezone: "UTC" },
      { slug: "near", name: "Near", region: "", lat: 26.36, lon: -80.07, timezone: "UTC" },
      { slug: "mid", name: "Mid", region: "", lat: 27, lon: -80, timezone: "UTC" },
    ];
    const result = nearestServedBeach(26.3587, -80.0686, synthetic);
    expect(result?.beach.slug).toBe("near");
  });
});

describe("rankBeaches", () => {
  it("sorts nearest-first and carries a distance + bearing per beach", () => {
    const ranked = rankBeaches(BOCA_COORD.lat, BOCA_COORD.lon, BEACHES);
    expect(ranked).toHaveLength(BEACHES.length);
    expect(ranked[0].beach.slug).toBe("boca-raton");
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i].distanceMi).toBeGreaterThanOrEqual(ranked[i - 1].distanceMi);
    }
    for (const r of ranked) {
      expect(r.bearingDeg).toBeGreaterThanOrEqual(0);
      expect(r.bearingDeg).toBeLessThan(360);
    }
  });

  it("bearing sanity: a beach due north reads ~0deg, one due east reads ~90deg", () => {
    const origin = { lat: 26.0, lon: -80.0 };
    const synthetic: LocationPublic[] = [
      { slug: "north", name: "North", region: "", lat: 27.0, lon: -80.0, timezone: "UTC" },
      { slug: "east", name: "East", region: "", lat: 26.0, lon: -79.0, timezone: "UTC" },
    ];
    const ranked = rankBeaches(origin.lat, origin.lon, synthetic);
    const north = ranked.find((r) => r.beach.slug === "north")!;
    const east = ranked.find((r) => r.beach.slug === "east")!;
    expect(north.bearingDeg).toBeCloseTo(0, 0);
    expect(east.bearingDeg).toBeCloseTo(90, 0);
  });

  it("returns an empty array for an empty beach list", () => {
    expect(rankBeaches(26.35, -80.07, [])).toEqual([]);
  });
});

describe("isWithinMi", () => {
  it("is inclusive at the radius boundary", () => {
    expect(isWithinMi(2, 2)).toBe(true);
    expect(isWithinMi(2.01, 2)).toBe(false);
    expect(isWithinMi(0, 2)).toBe(true);
  });
});
