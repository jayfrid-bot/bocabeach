// Crowd reading → how many of BUSYNESS_SLOTS silhouette icons render "filled"
// in BusynessCard. Pulled into a pure helper so the fullness math is unit-tested
// independent of the SVG/markup.

import type { BusynessLevel } from "@/lib/types";
import { clamp } from "@/lib/util";

export const BUSYNESS_SLOTS = 10;

/**
 * Approx crowd % at the middle of each category band — mirrors the RANK bands
 * in lib/sources/busyness.ts (empty<10, quiet<30, moderate<55, busy<80,
 * packed>=80). Used only as a fallback when a beach reports a level but no
 * measured crowdPct.
 */
const LEVEL_MIDPOINT_PCT: Record<BusynessLevel, number> = {
  empty: 5,
  quiet: 20,
  moderate: 42,
  busy: 67,
  packed: 90,
  unknown: 0,
};

/**
 * Of `slots` (10) icons, how many should render "filled" for a reading — the
 * measured fullness % when present, else the category's midpoint %.
 */
export function busynessFilledSlots(
  crowdPct: number | undefined,
  level: BusynessLevel,
  slots: number = BUSYNESS_SLOTS,
): number {
  const pct =
    typeof crowdPct === "number" && Number.isFinite(crowdPct)
      ? clamp(crowdPct, 0, 100)
      : LEVEL_MIDPOINT_PCT[level];
  return clamp(Math.round((pct / 100) * slots), 0, slots);
}
