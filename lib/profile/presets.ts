// The eight weight vectors, straight from docs/PREMIUM_ROADMAP.md. Each column
// is written in whole points that add up to 100 (so the table stays readable and
// checkable against the doc) and is divided by 100 once, here.
//
// `everyone` is the free score: its weights are exactly DEFAULT_SCORING's, and a
// test pins that. Change a number here and you change what the app sells; change
// one in DEFAULT_SCORING and you change what every free user sees.

import type { ScoringIdeals, SubKey } from "@/lib/types";
import type { PresetId, ProfileId, ProfilePreset } from "@/lib/profile/types";

/** Points per factor, per profile. Every column sums to 100. */
const POINTS: Record<PresetId, Record<SubKey, number>> = {
  //          air  sky  wind waves water comfort sand weed crowd uv  clarity
  everyone: p(16, 16, 13, 14, 9, 8, 8, 7, 5, 4, 0),
  swim: p(12, 14, 10, 20, 16, 6, 4, 10, 4, 4, 0),
  kids: p(12, 16, 10, 18, 12, 6, 10, 6, 4, 6, 0),
  sun: p(22, 28, 12, 2, 4, 10, 6, 6, 6, 4, 0),
  snorkel: p(6, 10, 14, 22, 12, 2, 2, 8, 2, 2, 20),
  dog: p(20, 12, 8, 2, 2, 10, 26, 6, 10, 4, 0),
  walk: p(22, 14, 10, 4, 2, 14, 12, 6, 10, 6, 0),
  surf: p(8, 10, 18, 30, 12, 2, 2, 8, 6, 4, 0),
};

function p(
  airTemp: number,
  sky: number,
  wind: number,
  waves: number,
  waterTemp: number,
  comfort: number,
  sandTemp: number,
  sargassum: number,
  crowds: number,
  uv: number,
  clarity: number,
): Record<SubKey, number> {
  return { airTemp, sky, wind, waves, waterTemp, comfort, sandTemp, sargassum, crowds, uv, clarity };
}

/** The ideal bands per profile (roadmap "Ideals per profile"). A profile with no
 *  opinion about the water keeps the default band — its water weight is tiny. */
const IDEALS: Record<PresetId, ScoringIdeals> = {
  everyone: { airPlateau: [78, 88], waterPlateau: [77, 90], windPlateau: [5, 13], waveMode: "calm" },
  swim: { airPlateau: [78, 88], waterPlateau: [77, 90], windPlateau: [5, 13], waveMode: "calm" },
  kids: { airPlateau: [78, 88], waterPlateau: [79, 90], windPlateau: [5, 12], waveMode: "calm" },
  sun: { airPlateau: [84, 94], waterPlateau: [77, 90], windPlateau: [3, 10], waveMode: "calm" },
  snorkel: { airPlateau: [76, 90], waterPlateau: [78, 90], windPlateau: [3, 10], waveMode: "calm" },
  dog: { airPlateau: [68, 82], waterPlateau: [77, 90], windPlateau: [5, 15], waveMode: "calm" },
  walk: { airPlateau: [65, 82], waterPlateau: [77, 90], windPlateau: [5, 15], waveMode: "calm" },
  // Surfers want waves and light wind — dead calm air is fine, it holds the
  // face of the wave up. Hence a wind band that starts at 0, not 5.
  surf: { airPlateau: [70, 90], waterPlateau: [74, 88], windPlateau: [0, 10], waveMode: "surf" },
};

/** Copy words. `label` goes inside a sentence; `chip` labels a button. */
const WORDS: Record<PresetId, { label: string; chip: string }> = {
  everyone: { label: "everyone", chip: "Everyone" },
  swim: { label: "swimming", chip: "Swimming" },
  kids: { label: "kids", chip: "Kids" },
  sun: { label: "sunbathing", chip: "Sunbathing" },
  snorkel: { label: "snorkeling", chip: "Snorkeling" },
  dog: { label: "dog walks", chip: "Dog walks" },
  walk: { label: "beach walks", chip: "Walking" },
  surf: { label: "surfing", chip: "Surfing" },
};

/** Which safety caps this profile obeys (roadmap "Safety line and cap policy"). */
const CAP_POLICY: Record<PresetId, ProfilePreset["capPolicy"]> = {
  everyone: "water",
  swim: "water",
  kids: "water",
  snorkel: "water",
  sun: "shore",
  dog: "shore",
  walk: "shore",
  surf: "surf",
};

function preset(id: PresetId): ProfilePreset {
  const points = POINTS[id];
  const weights = {} as Record<SubKey, number>;
  for (const key of Object.keys(points) as SubKey[]) weights[key] = points[key] / 100;
  return { id, label: WORDS[id].label, chip: WORDS[id].chip, weights, ideals: IDEALS[id], capPolicy: CAP_POLICY[id] };
}

/** Every preset, keyed by id. Fresh objects — safe for a caller to hold. */
export const PRESETS: Record<PresetId, ProfilePreset> = {
  everyone: preset("everyone"),
  swim: preset("swim"),
  kids: preset("kids"),
  sun: preset("sun"),
  snorkel: preset("snorkel"),
  dog: preset("dog"),
  walk: preset("walk"),
  surf: preset("surf"),
};

/** The seven pickable profiles, in the order the onboarding chips show them. */
export const PROFILE_IDS: ProfileId[] = ["swim", "kids", "sun", "snorkel", "dog", "walk", "surf"];

/** True when `id` is a profile the app knows. Guards stored/POSTed values. */
export function isProfileId(id: unknown): id is ProfileId {
  return typeof id === "string" && (PROFILE_IDS as string[]).includes(id);
}

/** The chip word for a profile ("Snorkeling"). */
export function profileChip(id: PresetId): string {
  return WORDS[id].chip;
}
