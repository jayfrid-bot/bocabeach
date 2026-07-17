import type { FlagColor, RipRisk } from "@/lib/types";

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
  ripCurrentRisk?: RipRisk;
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

  const danger =
    !!input.advisory ||
    !!input.lightningDanger ||
    !!input.noSwim ||
    input.ripCurrentRisk === "high" ||
    flags.some((f) => f === "red" || f === "double-red") ||
    alerts.some((e) => /warning/i.test(e));
  if (danger) return "danger";

  const caution =
    alerts.length > 0 ||
    input.ripCurrentRisk === "moderate" ||
    flags.some((f) => f === "yellow" || f === "purple");
  return caution ? "caution" : "calm";
}
