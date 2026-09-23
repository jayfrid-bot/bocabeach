// Pure distance/ranking helpers over the served beach list. No fetch, no
// browser globals — safe to unit test directly.

import { bearingDeg } from "@/lib/util";
import { distanceToBeachMi, nearestShorePoint } from "@/lib/location/shoreDistance";
import type { LocationPublic } from "@/lib/types";

export interface NearestBeach {
  beach: LocationPublic;
  distanceMi: number;
}

export interface RankedBeach {
  beach: LocationPublic;
  distanceMi: number;
  /** Compass bearing FROM the fix TO the beach (deg, 0=N, 90=E). */
  bearingDeg: number;
}

/** The single closest beach to (lat, lon), or null when `beaches` is empty. */
export function nearestServedBeach(
  lat: number,
  lon: number,
  beaches: LocationPublic[],
): NearestBeach | null {
  let best: NearestBeach | null = null;
  for (const beach of beaches) {
    const distanceMi = distanceToBeachMi(lat, lon, beach);
    if (!best || distanceMi < best.distanceMi) best = { beach, distanceMi };
  }
  return best;
}

/** Every beach ranked nearest-first, each with its distance + bearing from (lat, lon).
 *  Distance is to the closest point on the beach's shoreline (falling back to
 *  its pin when it has none); the bearing points the same way — toward that
 *  nearest point on the sand, not always toward one fixed pin. */
export function rankBeaches(lat: number, lon: number, beaches: LocationPublic[]): RankedBeach[] {
  return beaches
    .map((beach) => {
      const target = nearestShorePoint(lat, lon, beach);
      return {
        beach,
        distanceMi: distanceToBeachMi(lat, lon, beach),
        bearingDeg: bearingDeg(lat, lon, target.lat, target.lon),
      };
    })
    .sort((a, b) => a.distanceMi - b.distanceMi);
}

/** Whether a distance falls within a given radius (inclusive), in miles. */
export function isWithinMi(distanceMi: number, radius: number): boolean {
  return distanceMi <= radius;
}
