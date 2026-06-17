// Pure nearest-neighbor ranking for the resolver: given an origin and a list of
// lat/lon-bearing registry items, sort by great-circle distance and flag when
// the top two are too close to call (ambiguous).

import { bearingDeg, haversineMiles } from "@/lib/util";

/** A registry item carrying coordinates (tide/buoy/beach station, etc.). */
export interface LatLon {
  lat: number;
  lon: number;
}

/** An input item annotated with its distance/bearing from the origin. */
export type Ranked<T> = T & { distanceMi: number; bearingDeg: number };

export interface RankResult<T> {
  /** Items sorted ascending by distance, each annotated with distance + bearing. */
  ranked: Ranked<T>[];
  /** True when the two nearest items are within `tieMiles` of each other. */
  ambiguous: boolean;
}

/** Default mileage gap below which the two nearest items are "too close to call". */
const DEFAULT_TIE_MILES = 5;

/**
 * Rank `items` by great-circle distance from `origin`, ascending. Each result
 * carries `distanceMi` and `bearingDeg` (origin -> item). `ambiguous` is true
 * when the closest two items are within `opts.tieMiles` (default 5) of each
 * other — a signal for the caller to offer a pick-list instead of auto-choosing.
 */
export function rankByDistance<T extends LatLon>(
  origin: LatLon,
  items: T[],
  opts: { tieMiles?: number } = {},
): RankResult<T> {
  const tieMiles = opts.tieMiles ?? DEFAULT_TIE_MILES;
  const ranked = items
    .map((item) => ({
      ...item,
      distanceMi: haversineMiles(origin.lat, origin.lon, item.lat, item.lon),
      bearingDeg: bearingDeg(origin.lat, origin.lon, item.lat, item.lon),
    }))
    .sort((a, b) => a.distanceMi - b.distanceMi);

  const ambiguous =
    ranked.length >= 2 && ranked[1].distanceMi - ranked[0].distanceMi <= tieMiles;

  return { ranked, ambiguous };
}
