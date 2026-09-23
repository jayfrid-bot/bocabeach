import { describe, expect, it } from "vitest";
import { haversineMiles } from "@/lib/util";
import { distanceToBeachMi, nearestShorePoint } from "@/lib/location/shoreDistance";

// A simple north-south shore segment for segment-math tests, well away from
// any real config data.
const SHORE: [number, number][] = [
  [26.40, -80.07],
  [26.30, -80.08],
];

describe("distanceToBeachMi / nearestShorePoint", () => {
  it("falls back to the pin when the beach has no shore", () => {
    const beach = { lat: 26.35, lon: -80.07 };
    const d = distanceToBeachMi(26.36, -80.08, beach);
    expect(d).toBeCloseTo(haversineMiles(26.36, -80.08, 26.35, -80.07), 6);
    expect(nearestShorePoint(26.36, -80.08, beach)).toEqual({ lat: 26.35, lon: -80.07 });
  });

  it("falls back to the pin when shore has fewer than 2 points", () => {
    const beach = { lat: 26.35, lon: -80.07, shore: [[26.35, -80.07]] as [number, number][] };
    const d = distanceToBeachMi(26.36, -80.08, beach);
    expect(d).toBeCloseTo(haversineMiles(26.36, -80.08, 26.35, -80.07), 6);
  });

  it("clamps to the northern endpoint for a point beyond it", () => {
    const beach = { lat: 26.35, lon: -80.075, shore: SHORE };
    const point = nearestShorePoint(26.45, -80.06, beach);
    expect(point).toEqual({ lat: 26.40, lon: -80.07 });
    expect(distanceToBeachMi(26.45, -80.06, beach)).toBeCloseTo(
      haversineMiles(26.45, -80.06, 26.40, -80.07),
      6,
    );
  });

  it("clamps to the southern endpoint for a point beyond it", () => {
    const beach = { lat: 26.35, lon: -80.075, shore: SHORE };
    const point = nearestShorePoint(26.20, -80.09, beach);
    expect(point).toEqual({ lat: 26.30, lon: -80.08 });
  });

  it("finds a perpendicular foot strictly between the endpoints for a point abeam the middle", () => {
    const beach = { lat: 26.35, lon: -80.075, shore: SHORE };
    // Roughly abeam the segment's midpoint, well inland (west) of it.
    const point = nearestShorePoint(26.35, -80.2, beach);
    expect(point.lat).toBeGreaterThan(26.30);
    expect(point.lat).toBeLessThan(26.40);
    // The perpendicular foot must be at least as close as either endpoint.
    const dFoot = distanceToBeachMi(26.35, -80.2, beach);
    const dNorth = haversineMiles(26.35, -80.2, 26.40, -80.07);
    const dSouth = haversineMiles(26.35, -80.2, 26.30, -80.08);
    expect(dFoot).toBeLessThanOrEqual(dNorth);
    expect(dFoot).toBeLessThanOrEqual(dSouth);
  });

  it("is ~0 for a point sitting right on the shore line", () => {
    const beach = { lat: 26.35, lon: -80.075, shore: SHORE };
    // Midpoint of the segment.
    const d = distanceToBeachMi(26.35, -80.075, beach);
    expect(d).toBeLessThan(0.05);
  });

  it("picks the closest of several segments (multi-point polyline)", () => {
    const beach = {
      lat: 26.35,
      lon: -80.075,
      shore: [
        [26.40, -80.07],
        [26.35, -80.075],
        [26.30, -80.08],
      ] as [number, number][],
    };
    // Close to the middle vertex, should resolve near there regardless of
    // which of the two segments is checked first.
    const d = distanceToBeachMi(26.35, -80.076, beach);
    expect(d).toBeLessThan(0.1);
  });
});
