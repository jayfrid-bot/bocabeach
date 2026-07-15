// UV index → plain-English band, burn-time estimate, and display color.
// Pulled out of ConditionsDashboard so UvCard can unit-test the math
// (previously an inline `uvBurn = Math.round(200 / uvIndex)` local var).

import { clamp } from "@/lib/util";

export type UvBandWord = "Low" | "Moderate" | "High" | "Very High" | "Extreme";

/** EPA UV Index bands: 0-2 Low, 3-5 Moderate, 6-7 High, 8-10 Very High, 11+ Extreme. */
export function uvBand(uvIndex: number): UvBandWord {
  if (uvIndex <= 2) return "Low";
  if (uvIndex <= 5) return "Moderate";
  if (uvIndex <= 7) return "High";
  if (uvIndex <= 10) return "Very High";
  return "Extreme";
}

/** Band color, emerald (safe) → violet (extreme), matching uvBand's cutoffs. */
export function uvBandColor(uvIndex: number): string {
  if (uvIndex <= 2) return "#10b981"; // emerald-500
  if (uvIndex <= 5) return "#f59e0b"; // amber-500
  if (uvIndex <= 7) return "#f97316"; // orange-500
  if (uvIndex <= 10) return "#f43f5e"; // rose-500
  return "#8b5cf6"; // violet-500
}

/**
 * Minutes to a bare-skin burn at this UV index — a rough rule-of-thumb
 * (~200 minute-UV "dose" to burn), same math the dashboard used inline.
 * Undefined below UV 1, where the estimate is meaningless (minimal risk).
 */
export function uvBurnMinutes(uvIndex: number): number | undefined {
  return uvIndex >= 1 ? Math.round(200 / uvIndex) : undefined;
}

const BURN_MIN_FLOOR = 14; // ~UV 14 (our render clamp ceiling) — fastest realistic burn
const BURN_MIN_CEIL = 200; // UV 1 — slowest

/**
 * 0 (no rush) .. 1 (urgent) — how alarming a given burn-time estimate is, for
 * driving the UvCard ring fill. Shorter time to burn = fuller ring.
 */
export function uvBurnUrgency(minutes: number | undefined): number {
  if (minutes == null) return 0;
  const clamped = clamp(minutes, BURN_MIN_FLOOR, BURN_MIN_CEIL);
  return 1 - (clamped - BURN_MIN_FLOOR) / (BURN_MIN_CEIL - BURN_MIN_FLOOR);
}
