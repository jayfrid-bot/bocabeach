// Distance to a BEACH, modeled as a shoreline stretch rather than one pin.
//
// A single lat/lon pin works for a beach town with a short waterfront, but
// Boca Raton's public beaches run ~3 miles of coast (Spanish River Park down
// to South Inlet Park). Measuring straight-line distance to one pin near the
// middle of that stretch sends anyone south of it to the next town's pin,
// even though Boca's own sand is closer. `shore` (config/locations.ts) is an
// optional north-to-south polyline along the public beach; when present,
// distance is measured to the closest point on that line instead of to the
// pin. Pure — no fetch, no browser globals — safe to unit test directly.
//
// Deliberately narrow: this only answers "how far is this fix from the
// beach's sand," for nearest-beach ranking and "am I at the beach" arrival
// checks. It does NOT touch the hazard "where you stand vs. the beach" pin
// comparison (lib/hazards/pointVsBeach.ts / assess.ts) — that keeps
// measuring against the data anchor (lat/lon), because that comparison is
// about the beach's WEATHER DATA anchor (where the radar/lightning read is
// centered), not about which stretch of sand is nearest.

import { haversineMiles } from "@/lib/util";

export interface ShoreBeach {
  lat: number;
  lon: number;
  /** North-to-south polyline of [lat, lon] pairs along the public beach. */
  shore?: [number, number][];
}

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

/**
 * The closest point on one shore segment (a→b) to (lat, lon), found by
 * projecting into a local equirectangular frame (longitude scaled by
 * cos(latitude) so the two axes are comparable in distance), clamping the
 * projection to the segment so the closest point never falls past either
 * end, then converting back to lat/lon. The segment is short enough (a few
 * miles) that this flat-Earth projection introduces negligible error; the
 * actual distance is always finished with `haversineMiles`, the same
 * formula/Earth radius used everywhere else in the app.
 */
function closestPointOnSegment(
  lat: number,
  lon: number,
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): { lat: number; lon: number } {
  // Scale longitude by cos(latitude) at the segment's own start so both axes
  // read in comparable (roughly equal-distance-per-unit) terms.
  const cos = Math.cos((aLat * Math.PI) / 180) || 1e-9;
  const ax = aLon * cos;
  const ay = aLat;
  const bx = bLon * cos;
  const by = bLat;
  const px = lon * cos;
  const py = lat;

  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const lenSq = abx * abx + aby * aby;
  const t = lenSq > 0 ? clamp((apx * abx + apy * aby) / lenSq, 0, 1) : 0;

  const cx = ax + t * abx;
  const cy = ay + t * aby;
  return { lat: cy, lon: cx / cos };
}

/**
 * The point on `beach`'s shoreline closest to (lat, lon) — or the beach's own
 * pin when it has no `shore` (or fewer than 2 points to make a segment from).
 * Used both for distance and, elsewhere, as the target for a bearing (aiming
 * "toward the beach" should point at the nearest stretch of sand, not always
 * at one fixed pin some miles up or down the coast).
 */
export function nearestShorePoint(lat: number, lon: number, beach: ShoreBeach): { lat: number; lon: number } {
  const shore = beach.shore;
  if (!shore || shore.length < 2) return { lat: beach.lat, lon: beach.lon };

  let best: { lat: number; lon: number } | null = null;
  let bestDist = Infinity;
  for (let i = 0; i < shore.length - 1; i++) {
    const [aLat, aLon] = shore[i];
    const [bLat, bLon] = shore[i + 1];
    const candidate = closestPointOnSegment(lat, lon, aLat, aLon, bLat, bLon);
    const d = haversineMiles(lat, lon, candidate.lat, candidate.lon);
    if (d < bestDist) {
      bestDist = d;
      best = candidate;
    }
  }
  return best ?? { lat: beach.lat, lon: beach.lon };
}

/**
 * Distance in miles from (lat, lon) to the closest point on `beach`'s
 * shoreline — or straight-line distance to its pin when it has no `shore`.
 * The single distance rule every "which beach is nearest" / "am I at the
 * beach" decision should use, client and server alike.
 */
export function distanceToBeachMi(lat: number, lon: number, beach: ShoreBeach): number {
  if (!beach.shore || beach.shore.length < 2) return haversineMiles(lat, lon, beach.lat, beach.lon);
  const point = nearestShorePoint(lat, lon, beach);
  return haversineMiles(lat, lon, point.lat, point.lon);
}
