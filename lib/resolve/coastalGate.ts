// Pure guard that decides whether a geocoded point is eligible to resolve to a
// beach Location: US-only, and within range of a coastal (ocean) beach. Keeps the
// resolver from emitting Locations for inland lakes or out-of-coverage places.

import type { WarningCode } from "@/lib/resolve/types";

/** Result of the coastal gate. `reason` (a WarningCode) is set only on failure. */
export interface CoastalGateResult {
  ok: boolean;
  reason?: Extract<WarningCode, "NON_US" | "COASTAL_GATE_FAIL">;
}

/** Default maximum distance (statute miles) to the nearest coastal beach. */
const DEFAULT_MAX_MILES = 30;

/**
 * Gate a geocoded `point` for beach resolution. Fails (ok:false) when the point
 * is outside the US (`reason: "NON_US"`), or when there is no coastal beach in
 * range — `nearestBeachMi` is null or exceeds `maxMiles` (`reason:
 * "COASTAL_GATE_FAIL"`). The non-US check runs first.
 */
export function coastalGate(
  point: { lat: number; lon: number; countryCode: string },
  nearestBeachMi: number | null,
  maxMiles = DEFAULT_MAX_MILES,
): CoastalGateResult {
  if (point.countryCode !== "US") return { ok: false, reason: "NON_US" };
  if (nearestBeachMi == null || nearestBeachMi > maxMiles) {
    return { ok: false, reason: "COASTAL_GATE_FAIL" };
  }
  return { ok: true };
}
