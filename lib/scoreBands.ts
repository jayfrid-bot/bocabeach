// ---------------------------------------------------------------------------
// The Beach Day score's tier bands — ONE source of truth.
//
// The 0-100 composite maps to a headline verdict, a short rating word (the wheel
// center + forecast tiles), an accent colour, a Tailwind text class, and a push-
// notification phrase. These used to be FIVE separate functions each hardcoding
// their own cutoffs — and they had already drifted (push titles said
// "Great/So-so/Rough" while the app said "Yes!/Maybe/Not really"). Centralizing
// here keeps every surface in lockstep and makes a re-tune a one-place edit.
//
// Boundaries (owner-set 2026-07-17): 90 / 75 / 65 / 25. Stricter than the old
// 80/65/45 — a 78 is now "good beach day", 65-74 only "Decent", and below 65 the
// day is "likely not".
// ---------------------------------------------------------------------------

export interface ScoreBand {
  /** Inclusive lower bound of the band (0-100). */
  min: number;
  /** Headline answer to "Is it beach day?" */
  verdict: string;
  /** Short word for the wheel center + forecast tiles. */
  rating: string;
  /** Accent hex (wheel center number, forecast badge, each slice by its own score). */
  color: string;
  /** Tailwind text colour, light + dark. */
  text: string;
  /** Push-notification title phrase. */
  push: string;
}

/** Highest band first — scoreBand() returns the first whose `min` <= score. */
export const SCORE_BANDS: readonly ScoreBand[] = [
  { min: 90, verdict: "Absolutely!",          rating: "Excellent", color: "#10b981", text: "text-emerald-600 dark:text-emerald-400", push: "Perfect beach day today" },
  { min: 75, verdict: "Yes — good beach day", rating: "Good",      color: "#34d399", text: "text-emerald-600 dark:text-emerald-400", push: "Great beach day today" },
  { min: 65, verdict: "Decent",               rating: "Decent",    color: "#a3e635", text: "text-lime-600 dark:text-lime-400",       push: "Decent beach day today" },
  { min: 25, verdict: "Likely not",           rating: "Marginal",  color: "#fbbf24", text: "text-amber-600 dark:text-amber-400",     push: "Marginal beach day today" },
  { min: 0,  verdict: "Definitely not",       rating: "Poor",      color: "#fb7185", text: "text-rose-600 dark:text-rose-400",       push: "Rough beach day today" },
] as const;

/** The band a 0-100 score falls into (clamped; never returns undefined). */
export function scoreBand(score: number): ScoreBand {
  for (const band of SCORE_BANDS) {
    if (score >= band.min) return band;
  }
  return SCORE_BANDS[SCORE_BANDS.length - 1];
}
