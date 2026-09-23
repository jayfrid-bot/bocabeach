// "Where you stand" vs "the beach" — phase 1e of docs/LOCATION_FIRST_PLAN.md.
//
// Pure comparison + copy over two ALREADY-DECIDED HazardAssessment pairs (one
// anchored to the device's own fix, one to the beach centroid). This module
// makes no hazard calls of its own — lib/hazards/assess.ts (assessLightning /
// assessRain) is the one evaluator; this only decides whether the point's
// answer is worth telling someone about, and how to say it.

import type { HazardAssessment } from "@/lib/hazards/assess";

export interface HazardPair {
  lightning: HazardAssessment;
  rain: HazardAssessment;
}

/**
 * Is the point assessment worth calling out over the beach's own? Per the
 * phase-1e plan: the active flag differs for either hazard, the lightning
 * distance differs by at least 1 mile, or — when both sides agree
 * active — the `latched` flag differs (an OBSERVED "raining now" at one
 * anchor and a LATCHED "rain in the last 20 min" hold at the other is a real
 * difference worth showing, even though both read "active"). Distances are
 * display-only fields the route hands over alongside the assessments
 * (assess.ts itself never carries a distance), so they're optional here and
 * a missing one never trips this.
 */
export function pointDiffersFromBeach(
  point: HazardPair & { lightningMi?: number | null },
  beach: HazardPair & { lightningMi?: number | null },
): boolean {
  if (point.lightning.active !== beach.lightning.active) return true;
  if (point.rain.active !== beach.rain.active) return true;
  if (point.lightning.active && beach.lightning.active && point.lightning.latched !== beach.lightning.latched) {
    return true;
  }
  if (point.rain.active && beach.rain.active && point.rain.latched !== beach.rain.latched) return true;
  const pmi = point.lightningMi;
  const bmi = beach.lightningMi;
  if (pmi != null && Number.isFinite(pmi) && bmi != null && Number.isFinite(bmi)) {
    if (Math.abs(pmi - bmi) >= 1) return true;
  }
  return false;
}

/**
 * The single quiet line to show under Beach Mode, or null when there's
 * nothing worth a person's attention at their own spot right now. Lightning
 * outranks rain (same priority order lib/alerts/evaluate.ts uses). Built off
 * `reason` — assess.ts's own user-facing text — rather than re-deriving
 * distance/age wording a second time.
 */
export function whereYouStandLine(point: HazardPair): string | null {
  if (point.lightning.active && point.lightning.reason) {
    const m = point.lightning.reason.match(/^Lightning (.+?), (\d+) min ago$/);
    if (m) {
      const distance = m[1]
        .replace(/^(\d+(?:\.\d+)?) miles away$/, "$1 mi")
        .replace(/^within 5 miles$/, "nearby");
      return `Where you stand: lightning ${distance}, ${m[2]} min ago`;
    }
    return "Where you stand: lightning nearby";
  }
  if (point.rain.active) {
    if (point.rain.reason === "Raining right now") return "Where you stand: raining now";
    if (point.rain.reason === "Rain in the last 20 minutes") return "Where you stand: rain in the last 20 min";
  }
  return null;
}

/**
 * The card's one call: the line to show, or null. Combines the "is it
 * different" gate with "is there anything to say" — a point that differs
 * from the beach only because it's CLEARER there has nothing to announce.
 */
export function beachModeHazardLine(point: HazardPair & { lightningMi?: number | null }, beach: HazardPair & { lightningMi?: number | null }): string | null {
  if (!pointDiffersFromBeach(point, beach)) return null;
  return whereYouStandLine(point);
}
