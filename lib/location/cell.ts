// Deterministic lat/lon grid cells. Used to bucket a device fix onto a coarse
// cell (default 0.05°, ~3-3.5 mi) so per-run fetches (e.g. rain nowcast) can
// be cached once per cell instead of once per device (see PLUS_BUILD_SPEC.md's
// alerts-engine section). Pure — no browser globals.

const DEFAULT_SIZE_DEG = 0.05;

/** Digits after the decimal point in `n`'s own literal representation. */
function decimalPlaces(n: number): number {
  const s = n.toString();
  const i = s.indexOf(".");
  return i === -1 ? 0 : s.length - i - 1;
}

/**
 * Stable key for the grid cell containing (lat, lon), e.g. "26.35,-80.10".
 * Floors toward the cell's low corner (so negative coordinates bucket
 * correctly — -80.001 falls in the -80.05 cell, not -80.00).
 */
export function cellKey(lat: number, lon: number, sizeDeg: number = DEFAULT_SIZE_DEG): string {
  const dp = decimalPlaces(sizeDeg);
  const latKey = (Math.floor(lat / sizeDeg) * sizeDeg).toFixed(dp);
  const lonKey = (Math.floor(lon / sizeDeg) * sizeDeg).toFixed(dp);
  return `${latKey},${lonKey}`;
}

/** The (lat, lon) at the center of the cell named by `key`. */
export function cellCenter(key: string, sizeDeg: number = DEFAULT_SIZE_DEG): { lat: number; lon: number } {
  const [latStr, lonStr] = key.split(",");
  return {
    lat: parseFloat(latStr) + sizeDeg / 2,
    lon: parseFloat(lonStr) + sizeDeg / 2,
  };
}
