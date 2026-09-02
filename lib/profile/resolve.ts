// Turn what a person told us (a ScoreProfile) into what the engine runs on
// (ScoringOptions). Pure, cheap, and safe to call on every slider drag.
//
// The order of operations is fixed, because it is what the settings sheet
// promises: blend the chosen profiles → shift the ideals for heat → scale the
// crowd factor for crowd sensitivity → apply Advanced multipliers and ideal
// overrides → renormalize the weights to sum to 1.

import { DEFAULT_SCORING } from "@/lib/score";
import type { CapPolicy, ScoringIdeals, ScoringOptions, SubKey, WaveMode } from "@/lib/types";
import type { ProfileId, ProfilePreset, ScoreProfile } from "@/lib/profile/types";
import { PRESETS, isProfileId } from "@/lib/profile/presets";

/** °F the ideal AIR band moves when someone likes it cooler / hotter. */
const HEAT_AIR_SHIFT: Record<ScoreProfile["heat"], number> = { cooler: -5, normal: 0, hot: 5 };
/** °F the ideal WATER band moves. Water swings far less than air, so half as much. */
const HEAT_WATER_SHIFT: Record<ScoreProfile["heat"], number> = { cooler: -2, normal: 0, hot: 2 };
/** At most two profiles blend; anything the app does not know is dropped. */
function chosenPresets(profile: ScoreProfile): ProfilePreset[] {
  const ids = (profile.profiles ?? []).filter(isProfileId).slice(0, 2);
  const seen = new Set<ProfileId>();
  const out: ProfilePreset[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(PRESETS[id]);
  }
  return out;
}

const shift = (band: [number, number], by: number): [number, number] => [band[0] + by, band[1] + by];

/** The average of the chosen columns — the blend of one or two profiles. */
function blendWeights(presets: ProfilePreset[]): Record<SubKey, number> {
  const keys = Object.keys(DEFAULT_SCORING.weights) as SubKey[];
  const out = {} as Record<SubKey, number>;
  for (const key of keys) {
    out[key] = presets.reduce((a, p) => a + p.weights[key], 0) / presets.length;
  }
  return out;
}

/** The average ideal band. Wave mode is a word, not a number — see below. */
function blendIdeals(presets: ProfilePreset[]): ScoringIdeals {
  const avg = (pick: (i: ScoringIdeals) => [number, number]): [number, number] => [
    presets.reduce((a, p) => a + pick(p.ideals)[0], 0) / presets.length,
    presets.reduce((a, p) => a + pick(p.ideals)[1], 0) / presets.length,
  ];
  return {
    airPlateau: avg((i) => i.airPlateau),
    waterPlateau: avg((i) => i.waterPlateau),
    windPlateau: avg((i) => i.windPlateau),
    // Waves can't be averaged. Someone who picked surfing wants waves even if
    // their other profile is a beach walk, so the stronger appetite wins:
    // surf beats some beats calm.
    waveMode: presets.some((p) => p.ideals.waveMode === "surf")
      ? "surf"
      : presets.some((p) => p.ideals.waveMode === "some")
        ? "some"
        : "calm",
  };
}

/**
 * Which caps clamp this person's score. Safety information never changes — only
 * whether a hazard lowers THEIR number (see lib/safetyLine.ts, which reports
 * every hazard to everyone). Surfing wins, then swimming, then the shore.
 */
function blendCapPolicy(presets: ProfilePreset[]): CapPolicy {
  if (presets.some((p) => p.capPolicy === "surf")) return "surf";
  if (presets.some((p) => p.capPolicy === "water")) return "water";
  return "shore";
}

/**
 * The scoring options for a profile. `null` (no profile, or nothing usable in
 * it) is the free score: this returns DEFAULT_SCORING itself.
 */
export function resolveScoring(profile: ScoreProfile | null): ScoringOptions {
  if (!profile) return DEFAULT_SCORING;
  const presets = chosenPresets(profile);
  if (!presets.length) return DEFAULT_SCORING;

  const weights = blendWeights(presets);
  const ideals = blendIdeals(presets);

  // Heat: the whole ideal band slides, so "hot" doesn't just widen tolerance —
  // it moves what perfect means.
  const heat = HEAT_AIR_SHIFT[profile.heat] != null ? profile.heat : "normal";
  ideals.airPlateau = shift(ideals.airPlateau, HEAT_AIR_SHIFT[heat]);
  ideals.waterPlateau = shift(ideals.waterPlateau, HEAT_WATER_SHIFT[heat]);

  // Crowd sensitivity scales one weight, before Advanced and renormalizing.
  const crowdMult = crowdMultiplier(profile.crowds);
  weights.crowds *= crowdMult;

  // Advanced: per-factor multipliers, then flat ideal overrides.
  const adv = profile.advanced;
  if (adv?.mult) {
    for (const [key, mult] of Object.entries(adv.mult) as [SubKey, number][]) {
      if (key in weights && typeof mult === "number" && mult >= 0) weights[key] *= mult;
    }
  }
  if (adv?.airIdeal) ideals.airPlateau = [...adv.airIdeal] as [number, number];
  if (adv?.waterIdeal) ideals.waterPlateau = [...adv.waterIdeal] as [number, number];
  if (adv?.wavePref) ideals.waveMode = adv.wavePref as WaveMode;

  return {
    weights: normalize(weights, blendWeights(presets)),
    ideals,
    capPolicy: blendCapPolicy(presets),
  };
}

function crowdMultiplier(crowds: ScoreProfile["crowds"]): number {
  if (crowds === "low") return 0.4;
  if (crowds === "high") return 2.4;
  return 1;
}

/**
 * Weights always sum to 1, so a score stays a 0-100 number whatever anyone does
 * in Advanced mode. Zeroing every factor would leave nothing to normalize, so
 * that one case falls back to the un-multiplied blend.
 */
function normalize(
  weights: Record<SubKey, number>,
  fallback: Record<SubKey, number>,
): Record<SubKey, number> {
  const keys = Object.keys(weights) as SubKey[];
  let total = keys.reduce((a, k) => a + (Number.isFinite(weights[k]) ? weights[k] : 0), 0);
  let source = weights;
  if (!(total > 0)) {
    source = fallback;
    total = keys.reduce((a, k) => a + fallback[k], 0);
  }
  const out = {} as Record<SubKey, number>;
  for (const key of keys) out[key] = (Number.isFinite(source[key]) ? source[key] : 0) / total;
  return out;
}

/**
 * What this score is tuned for, as a phrase for a sentence: "snorkeling",
 * "swimming and snorkeling", or "everyone" when there is no profile.
 */
export function profileLabel(profile: ScoreProfile | null): string {
  if (!profile) return PRESETS.everyone.label;
  const presets = chosenPresets(profile);
  if (!presets.length) return PRESETS.everyone.label;
  if (presets.length === 1) return presets[0].label;
  return `${presets[0].label} and ${presets[1].label}`;
}
