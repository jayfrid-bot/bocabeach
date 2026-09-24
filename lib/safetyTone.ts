import type { FlagColor, RipRisk } from "@/lib/types";
import type { RipNow } from "@/lib/ripRisk";

/**
 * How loud the safety banner is allowed to be.
 *  - "danger"  → rose. Reserved for get-out-of-the-water facts.
 *  - "caution" → amber. Advisories and moderate risk: read this, but it's not a veto.
 *  - "calm"    → neutral. Nothing here is alarming.
 */
export type SafetyTone = "danger" | "caution" | "calm";

export interface SafetyToneInput {
  /** An official water-quality advisory (bacteria) is in effect. */
  advisory?: boolean;
  /** A fresh strike within 5 mi. */
  lightningDanger?: boolean;
  /** A City-issued no-swim advisory. */
  noSwim?: boolean;
  /** @deprecated pass `ripNow` instead — this flat word can't distinguish an
   *  alert actually in effect from a merely scheduled or forecast one. Kept
   *  only so an untouched caller doesn't crash; `ripNow` takes priority. */
  ripCurrentRisk?: RipRisk;
  /** The temporally-resolved rip status (lib/ripRisk's resolveRipNow). A
   *  source of "alert" (an actual NWS Rip Current Statement in effect right
   *  now — always "high", see resolveRipNow) drives danger (rose). A source
   *  of "model" (NOAA's rip current model) or "forecast" (the CURRENT SRF
   *  period) at "high" drives only CAUTION (amber), never danger — the model
   *  and the forecast word are both guidance, not a posted statement, so
   *  they never paint the banner rose. "moderate" from any source drives
   *  caution. A merely SCHEDULED alert (source "unknown" with an
   *  `upcomingAlert`) is neither — it's informational, surfaced separately
   *  (see SafetyBanner). */
  ripNow?: RipNow;
  /** Posted lifeguard flags ("unknown" entries should be filtered out first). */
  flags?: FlagColor[];
  /** NWS alert event names, e.g. ["Heat Advisory", "Hurricane Warning"]. */
  alertEvents?: string[];
}

/**
 * The banner's colour must match the WORST thing inside it — never merely "an
 * alert exists".
 *
 * The bug this encodes against (found in a 2026-07-17 design pass): the tone was
 * a binary `hasWarning` that counted ANY NWS alert, so a routine Heat Advisory
 * painted the whole banner get-out-of-the-water rose while its own contents read
 * "Rip current risk: LOW" in green next to a low-hazard flag. Alarm colour over
 * an all-clear message is worse than no colour at all: it teaches people that
 * this app's red means nothing, so the day it means "lightning is 3 miles away"
 * they scroll straight past it.
 *
 * NWS severity maps by event NAME because that's the convention NWS itself uses:
 * a "…Warning" is happening/imminent (danger), an "…Advisory"/"…Statement"/
 * "…Watch" is be-aware (caution).
 */
export function safetyTone(input: SafetyToneInput): SafetyTone {
  const flags = input.flags ?? [];
  const alerts = input.alertEvents ?? [];
  const rip = input.ripNow;

  // An ALERT actually in effect is the only rip source that can paint the
  // banner rose (danger) — resolveRipNow always resolves an in-effect alert
  // to "high", so this is just "source is alert". A NOAA model or SRF
  // forecast reading of "high" is guidance, not a posted statement: it caps
  // out at CAUTION (amber), never danger, no matter how high the level.
  const ripDanger = rip ? rip.source === "alert" : input.ripCurrentRisk === "high";
  const ripCaution = rip
    ? rip.source === "alert"
      ? false // already counted in ripDanger
      : (rip.source === "model" || rip.source === "forecast") && rip.level !== "low" && rip.level !== "unknown"
    : input.ripCurrentRisk === "moderate";

  const danger =
    !!input.advisory ||
    !!input.lightningDanger ||
    !!input.noSwim ||
    ripDanger ||
    flags.some((f) => f === "red" || f === "double-red") ||
    alerts.some((e) => /warning/i.test(e));
  if (danger) return "danger";

  const caution =
    alerts.length > 0 ||
    ripCaution ||
    flags.some((f) => f === "yellow" || f === "purple");
  return caution ? "caution" : "calm";
}
