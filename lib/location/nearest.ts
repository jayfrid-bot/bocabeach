// Pure distance/ranking helpers over the served beach list. No fetch, no
// browser globals — safe to unit test directly.

import { haversineMiles, bearingDeg } from "@/lib/util";
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
    const distanceMi = haversineMiles(lat, lon, beach.lat, beach.lon);
    if (!best || distanceMi < best.distanceMi) best = { beach, distanceMi };
  }
  return best;
}

/** Every beach ranked nearest-first, each with its distance + bearing from (lat, lon). */
export function rankBeaches(lat: number, lon: number, beaches: LocationPublic[]): RankedBeach[] {
  return beaches
    .map((beach) => ({
      beach,
      distanceMi: haversineMiles(lat, lon, beach.lat, beach.lon),
      bearingDeg: bearingDeg(lat, lon, beach.lat, beach.lon),
    }))
    .sort((a, b) => a.distanceMi - b.distanceMi);
}

/** Whether a distance falls within a given radius (inclusive), in miles. */
export function isWithinMi(distanceMi: number, radius: number): boolean {
  return distanceMi <= radius;
}
