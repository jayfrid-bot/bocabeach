// Station-registry loaders + pure nearest-neighbor selection for the resolver.
//
// Mirrors the source-module split (cf. lib/sources/nws.ts): the loaders are the
// thin I/O layer (read a committed JSON snapshot, never throw — return [] when
// the file is missing or malformed), while `nearestTideStations` /
// `nearestBuoys` are pure functions over an in-memory registry. The buoy picker
// is capability-aware so it reproduces the hand-written Boca config: primary is
// the nearest station that reports water temp OR waves (LKWF1), and the fallback
// is the nearest *wave*-capable station distinct from it (FWYF1) so the app's
// fallback chain can still source waves.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { haversineMiles, round } from "@/lib/util";
import type { BuoyStation, TideStation } from "./types";

const TIDE_REGISTRY_PATH = join(process.cwd(), "data", "registry", "tide-stations.json");
const BUOY_REGISTRY_PATH = join(process.cwd(), "data", "registry", "buoys.json");

// --- loaders ----------------------------------------------------------------
// Read a committed registry snapshot from disk. These files may not exist yet
// when the resolver runs; a missing/unreadable/malformed file yields [] so the
// module never throws (the registry source degrades to "no stations in range").

/** Read the NOAA tide-station registry; returns [] when missing or unreadable. */
export function loadTideStations(): TideStation[] {
  return loadRegistry<TideStation>(TIDE_REGISTRY_PATH);
}

/** Read the NDBC buoy registry; returns [] when missing or unreadable. */
export function loadBuoyStations(): BuoyStation[] {
  return loadRegistry<BuoyStation>(BUOY_REGISTRY_PATH);
}

function loadRegistry<T>(path: string): T[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

// --- pure nearest selection -------------------------------------------------

/** A registry station annotated with its statute-mile distance from the point. */
type WithDistance<T> = T & { distanceMi: number };

/**
 * Rank a registry by ascending distance from (lat, lon), annotating each entry
 * with `distanceMi` (statute miles, rounded to 0.01). Pure; does not mutate the
 * input array.
 */
function rankByDistance<T extends { lat: number; lon: number }>(
  reg: T[],
  lat: number,
  lon: number,
): WithDistance<T>[] {
  return reg
    .map((s) => ({ ...s, distanceMi: round(haversineMiles(lat, lon, s.lat, s.lon), 2) }))
    .sort((a, b) => a.distanceMi - b.distanceMi);
}

/**
 * The `n` nearest tide stations to (lat, lon), nearest first. For the Boca beach
 * point this yields 8722816 (Boca Raton) then 8722670 (Lake Worth Pier).
 */
export function nearestTideStations(
  reg: TideStation[],
  lat: number,
  lon: number,
  n = 2,
): WithDistance<TideStation>[] {
  return rankByDistance(reg, lat, lon).slice(0, n);
}

/**
 * Capability-aware buoy selection from (lat, lon):
 *   - `primary`:  nearest buoy reporting water temp OR waves (hasWaterTemp || hasWaves).
 *   - `fallback`: nearest *wave*-capable buoy (hasWaves) distinct from `primary`,
 *                 so the app's fallback chain can still source waves when the
 *                 primary lacks them.
 * Reproduces Boca: primary LKWF1 (nearest, water-temp only), fallback FWYF1
 * (nearest wave buoy). If the primary already has waves, the fallback is the
 * next-nearest wave-capable buoy. Returns `{}` when nothing qualifies.
 */
export function nearestBuoys(
  reg: BuoyStation[],
  lat: number,
  lon: number,
): { primary?: WithDistance<BuoyStation>; fallback?: WithDistance<BuoyStation> } {
  const ranked = rankByDistance(reg, lat, lon);
  const primary = ranked.find((b) => b.hasWaterTemp || b.hasWaves);
  if (!primary) return {};
  const fallback = ranked.find((b) => b.hasWaves && b.id !== primary.id);
  return fallback ? { primary, fallback } : { primary };
}
