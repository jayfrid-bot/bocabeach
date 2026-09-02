// The shape of a person's beach taste. A ScoreProfile is what the app stores
// (phone + D1); lib/profile/resolve.ts turns one into the ScoringOptions the
// engine actually runs on. Types only — no logic lives here.

import type { CapPolicy, ScoringIdeals, ScoringOptions, SubKey, WaveMode } from "@/lib/types";

/** The seven things people come to the beach to do. */
export type ProfileId = "swim" | "kids" | "sun" | "snorkel" | "dog" | "walk" | "surf";

/** Every preset vector, including the free score's "everyone". */
export type PresetId = ProfileId | "everyone";

/** Do you want it cooler or hotter than the default ideal? */
export type HeatPreference = "cooler" | "normal" | "hot";

/** How much a crowd bothers you. `high` triples the crowd factor's pull. */
export type CrowdSensitivity = "low" | "normal" | "high";

/** Advanced mode's five stops: doesn't matter → essential. */
export type FactorMultiplier = 0 | 0.5 | 1 | 2 | 3;

/** Hand edits on top of a profile. Everything here is optional. */
export interface AdvancedProfile {
  /** Multiplies the profile's weight for a factor, before renormalizing. */
  mult?: Partial<Record<SubKey, FactorMultiplier>>;
  /** [low, high] °F air temperature that should score 100. */
  airIdeal?: [number, number];
  /** [low, high] °F water temperature that should score 100. */
  waterIdeal?: [number, number];
  /** Overrides the wave curve the profiles imply. */
  wavePref?: WaveMode;
}

/** What the app saves for a person. One or two profiles; two blend. */
export interface ScoreProfile {
  profiles: ProfileId[];
  heat: HeatPreference;
  crowds: CrowdSensitivity;
  advanced?: AdvancedProfile;
}

/** One column of the preset table: weights, ideals, and the caps it obeys. */
export interface ProfilePreset {
  id: PresetId;
  /** Lower-case phrase for copy: "Tuned for snorkeling: …". */
  label: string;
  /** Title-case word for a chip or a settings row. */
  chip: string;
  weights: Record<SubKey, number>;
  ideals: ScoringIdeals;
  capPolicy: CapPolicy;
}

export type { CapPolicy, ScoringIdeals, ScoringOptions, SubKey, WaveMode };
