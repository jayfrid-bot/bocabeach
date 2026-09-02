// The safety line: what the water is actually doing, in one word and a few
// short reasons. The SCORE is personal — a red flag does not spoil a sunbather's
// day, so it does not cap their number (see applyBeachCaps' cap policies). This
// file is the other half of that trade: safety information is never personal.
// Everybody sees the flags, the rip risk, and the lightning, whatever profile
// they picked.
//
// Pure functions. The wording matches the score's cap strings wherever the same
// hazard exists in both, so the app never says the same thing two ways.

import { rainSeverity, type Derived } from "@/lib/score";
import type { ConditionsSnapshot } from "@/lib/types";

/** Can you get in the water? */
export type SwimSafetyLevel = "safe" | "caution" | "stay-out";
/** Should you paddle out? */
export type SurfConditionLevel = "go" | "experienced" | "closed";

export interface SafetyLine<L extends string> {
  level: L;
  /** Short plain-English reasons, most serious first. Empty when all is well. */
  reasons: string[];
}

/** "Lightning within 5 miles — get out of the water", with the distance when known. */
function lightningReason(snapshot?: ConditionsSnapshot): string {
  const mi = snapshot?.lightning?.data?.nearestMi;
  if (typeof mi === "number" && Number.isFinite(mi)) {
    return `Lightning ${Math.round(mi * 10) / 10} miles away — get out of the water`;
  }
  return "Lightning within 5 miles — get out of the water";
}

/** A thunderstorm right now or in the forecast, worded to match the score's caps. */
function thunderReason(d: Derived): string | null {
  const stormCode = d.weatherCode != null && d.weatherCode >= 95 && d.weatherCode <= 99;
  const stormText = /thunder|storm/i.test(d.shortForecast ?? "");
  if (d.nowcastRaining && (stormCode || stormText)) return "Thunderstorm — raining now";
  if (rainSeverity(d) === "thunder") return "Thunderstorm in the forecast";
  return null;
}

/** Waves as a plain sentence: "Rough water — 5 ft waves". */
function waveReason(ft: number): string {
  return `Rough water — ${ft} ft waves`;
}

/**
 * Swim safety for anybody, whatever they came to do.
 *
 * stay-out: double red, red flag, lightning within 5 miles, severe weather, a
 * city no-swim advisory, or a water-quality advisory.
 * caution: moderate or high rip current, waves over 4 ft, a thunderstorm, or a
 * high-surf / coastal-flood advisory.
 */
export function swimSafety(
  d: Derived,
  snapshot?: ConditionsSnapshot,
): SafetyLine<SwimSafetyLevel> {
  const stayOut: string[] = [];
  const caution: string[] = [];

  if (d.flags?.includes("double-red")) stayOut.push("Double red flag — water access closed");
  else if (d.flags?.includes("red")) stayOut.push("Red flag — high hazard, swimming discouraged");
  if (d.lightningWithin5mi) stayOut.push(lightningReason(snapshot));
  if (d.severeAlert) stayOut.push("Severe weather warning in effect");
  if (d.noSwimAdvisory) stayOut.push("City no-swim advisory in effect");
  if (d.waterAdvisory) stayOut.push("Water quality advisory in effect");

  if (d.ripCurrentRisk === "high") caution.push("High rip current risk (NWS)");
  else if (d.ripCurrentRisk === "moderate") caution.push("Moderate rip current risk (NWS)");
  if (d.waveHeightFt != null && d.waveHeightFt > 4) caution.push(waveReason(d.waveHeightFt));
  const thunder = thunderReason(d);
  if (thunder) caution.push(thunder);
  if (d.surfAdvisory) caution.push("High surf or coastal-flood advisory — swimming discouraged");

  if (stayOut.length) return { level: "stay-out", reasons: [...stayOut, ...caution] };
  if (caution.length) return { level: "caution", reasons: caution };
  return { level: "safe", reasons: [] };
}

/**
 * Surf conditions, read the way a surfer reads them.
 *
 * closed: double red, lightning within 5 miles, severe weather.
 * experienced only: red flag, high rip, a high-surf advisory, waves over 6 ft.
 * A water-quality advisory is worth saying out loud, but it does not change the
 * call — that is the surfer's to make.
 */
export function surfConditions(
  d: Derived,
  snapshot?: ConditionsSnapshot,
): SafetyLine<SurfConditionLevel> {
  const closed: string[] = [];
  const experienced: string[] = [];
  const notes: string[] = [];

  if (d.flags?.includes("double-red")) closed.push("Double red flag — water access closed");
  if (d.lightningWithin5mi) closed.push(lightningReason(snapshot));
  if (d.severeAlert) closed.push("Severe weather warning in effect");

  if (d.flags?.includes("red")) experienced.push("Red flag — high hazard, experienced surfers only");
  if (d.ripCurrentRisk === "high") experienced.push("High rip current risk (NWS)");
  if (d.surfAdvisory) experienced.push("High surf advisory — experienced surfers only");
  if (d.waveHeightFt != null && d.waveHeightFt > 6) {
    experienced.push(`Big surf — ${d.waveHeightFt} ft waves`);
  }

  if (d.waterAdvisory) notes.push("Water quality advisory in effect");
  if (d.noSwimAdvisory) notes.push("City no-swim advisory in effect");
  const thunder = thunderReason(d);
  if (thunder) notes.push(thunder);

  if (closed.length) return { level: "closed", reasons: [...closed, ...experienced, ...notes] };
  if (experienced.length) return { level: "experienced", reasons: [...experienced, ...notes] };
  return { level: "go", reasons: notes };
}
