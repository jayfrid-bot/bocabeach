import { describe, it, expect } from "vitest";

import {
  loadBuoyStations,
  loadTideStations,
  nearestBuoys,
  nearestTideStations,
} from "@/lib/resolve/stationRegistry";
import { BOCA_BEACH, BUOY_FIXTURE, TIDE_FIXTURE } from "@/lib/resolve/__fixtures__/registries";

describe("nearestTideStations", () => {
  it("returns the two nearest tide stations to the Boca beach point, nearest first", () => {
    const got = nearestTideStations(TIDE_FIXTURE, BOCA_BEACH.lat, BOCA_BEACH.lon);
    expect(got.map((s) => s.id)).toEqual(["8722816", "8722670"]);
    // Ascending, annotated with a sane distance; the far CA decoy is excluded.
    expect(got[0].distanceMi).toBeLessThan(got[1].distanceMi);
    expect(got[0].distanceMi).toBeCloseTo(0.26, 1);
  });

  it("honors the count argument", () => {
    expect(nearestTideStations(TIDE_FIXTURE, BOCA_BEACH.lat, BOCA_BEACH.lon, 1)).toHaveLength(1);
    expect(nearestTideStations(TIDE_FIXTURE, BOCA_BEACH.lat, BOCA_BEACH.lon, 3)).toHaveLength(3);
  });

  it("returns [] for an empty registry", () => {
    expect(nearestTideStations([], BOCA_BEACH.lat, BOCA_BEACH.lon)).toEqual([]);
  });
});

describe("nearestBuoys", () => {
  it("picks the nearest capable buoy as primary and the nearest distinct wave buoy as fallback", () => {
    // Boca: primary LKWF1 (nearest, water-temp only), wave fallback FWYF1.
    const { primary, fallback } = nearestBuoys(BUOY_FIXTURE, BOCA_BEACH.lat, BOCA_BEACH.lon);
    expect(primary?.id).toBe("LKWF1");
    expect(fallback?.id).toBe("FWYF1");
    expect(primary?.distanceMi).toBeCloseTo(17.69, 1);
    expect(fallback?.distanceMi).toBeCloseTo(53.12, 1);
  });

  it("uses the 2nd-nearest wave buoy as fallback when the primary already has waves", () => {
    const { primary, fallback } = nearestBuoys(
      [
        { id: "A", name: "A", lat: 26.36, lon: -80.07, hasWaves: true, hasWaterTemp: true },
        { id: "B", name: "B", lat: 26.5, lon: -80.05, hasWaves: true },
        { id: "C", name: "C", lat: 26.7, lon: -80.04, hasWaterTemp: true },
      ],
      BOCA_BEACH.lat,
      BOCA_BEACH.lon,
    );
    expect(primary?.id).toBe("A");
    expect(fallback?.id).toBe("B");
  });

  it("returns a primary with no fallback when only one wave/temp buoy qualifies", () => {
    const { primary, fallback } = nearestBuoys(
      [{ id: "A", name: "A", lat: 26.36, lon: -80.07, hasWaterTemp: true }],
      BOCA_BEACH.lat,
      BOCA_BEACH.lon,
    );
    expect(primary?.id).toBe("A");
    expect(fallback).toBeUndefined();
  });

  it("returns {} when nothing qualifies (no waves, no water temp)", () => {
    expect(
      nearestBuoys(
        [{ id: "X", name: "X", lat: 26.36, lon: -80.07 }],
        BOCA_BEACH.lat,
        BOCA_BEACH.lon,
      ),
    ).toEqual({});
    expect(nearestBuoys([], BOCA_BEACH.lat, BOCA_BEACH.lon)).toEqual({});
  });
});

describe("registry loaders", () => {
  it("never throw and return an array even when the snapshot is absent", () => {
    // The committed registries may not exist yet; loaders degrade to [].
    expect(Array.isArray(loadTideStations())).toBe(true);
    expect(Array.isArray(loadBuoyStations())).toBe(true);
  });
});
