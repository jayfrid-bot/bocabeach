// Severity ranking for SafetyBanner's compact strip (worst-first). Pulled out
// as a pure, unit-tested function — see lib/safetyBannerRank.test.ts — so the
// ordering (lightning beats a water-quality advisory; a Tornado WARNING beats
// a Beach Hazards STATEMENT) can't silently drift from what the collapsed
// strip actually shows. SafetyBanner.tsx builds the candidate list (it alone
// knows the icons/copy for each source) and hands it to `rankSafetyItems`.

/**
 * Six tiers, worst first:
 *  1. lightning       — get out of the water right now.
 *  2. warningAlert     — a NWS product that IS happening/imminent (event name
 *                        ends "Warning", or CAP severity Severe/Extreme).
 *  3. closure          — double-red/water-closed flag, a city no-swim
 *                        advisory, a water-quality advisory.
 *  4. redFlagOrRipWarning — a plain red flag, or an actual NWS Rip Current
 *                        Statement/Warning in effect (resolveRipNow's
 *                        source "alert" — always resolves to "high").
 *  5. softAdvisory      — everything guidance-level: a non-warning-tier NWS
 *                        product (Beach Hazards Statement, Coastal Flood
 *                        Advisory, High Surf Advisory, …), or a rip reading
 *                        that's only a model/forecast, not a posted alert.
 *  6. other             — upcoming (not-yet-active) alerts, and the calmer
 *                        flag colors (yellow/purple/green).
 */
export type SafetyItemKind =
  | "lightning"
  | "warningAlert"
  | "closure"
  | "redFlagOrRipWarning"
  | "softAdvisory"
  | "other";

const TIER: Record<SafetyItemKind, number> = {
  lightning: 1,
  warningAlert: 2,
  closure: 3,
  redFlagOrRipWarning: 4,
  softAdvisory: 5,
  other: 6,
};

export interface SafetyItem {
  kind: SafetyItemKind;
  icon: string;
  text: string;
  /** Stable key so a caller/test can identify a candidate without matching
   *  its rendered text (which is free-form, localized product copy). */
  id: string;
}

/** Worst-first. Stable within a tier — ties keep the caller's push order
 *  (Array.prototype.sort is a stable sort on every engine this ships to),
 *  so pushing "more specific" sources first reads as a sane tiebreak. Never
 *  mutates `items`. */
export function rankSafetyItems<T extends SafetyItem>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => TIER[a.kind] - TIER[b.kind]);
}

/**
 * A NWS product is "warning-tier" when its event name ends in "Warning", or
 * its CAP severity is Severe/Extreme — the same plain-English reading
 * lib/safetyTone.ts uses for the banner's overall color: a "…Warning" is
 * happening or imminent; an Advisory/Statement/Watch is merely be-aware.
 */
export function isWarningTierAlert(alert: { event: string; severity?: string }): boolean {
  return (
    /warning\s*$/i.test(alert.event.trim()) || alert.severity === "Severe" || alert.severity === "Extreme"
  );
}
