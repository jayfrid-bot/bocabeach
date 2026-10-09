// Every scoring-formula version the hourly archive has stored, in order, with
// the day it first appeared and a one-line plain-English note. History reads
// this to tell a formula change from a weather change (lib/history/summary.ts,
// components/plus/HistorySection.tsx).
//
// Keep this file light: the history UI is a client component and imports it.
// It must NOT import lib/score.ts. A test (lib/scoringVersions.test.ts) fails
// when the last entry here differs from SCORING_ENGINE_VERSION, so a bump in
// lib/score.ts without a note here fails CI.
//
// To add a version: append one entry at the END. `since` is the first
// beach-local day the new formula scored a row. Write `note` for beachgoers:
// short, plain, no jargon.

export interface ScoringVersion {
  /** The exact SCORING_ENGINE_VERSION string rows are stamped with. */
  version: string;
  /** First day (YYYY-MM-DD) rows carry this version. */
  since: string;
  /** One plain sentence on what changed. */
  note: string;
}

export const SCORING_VERSIONS: readonly ScoringVersion[] = [
  {
    version: "2026-09-18.1",
    since: "2026-09-22",
    note: "The first formula in the archive.",
  },
  {
    version: "2026-09-22.1",
    since: "2026-09-22",
    note: "Beaches with thin data can no longer read Excellent. Estimated water and wave data counts for less.",
  },
  {
    version: "2026-09-28.1",
    since: "2026-09-28",
    note: "Waves now score the estimated surf height at the shore, not the raw buoy wave height.",
  },
  {
    version: "2026-09-28.2",
    since: "2026-09-28",
    note: "A red flag or a High Surf Advisory now caps the score at 70 (it was 85).",
  },
  {
    version: "2026-10-06.1",
    since: "2026-10-06",
    note: "The humidity comfort curve was retuned for the shore: free up to a 65°F dew point, then 2.5 points per degree.",
  },
  {
    version: "2026-10-09.1",
    since: "2026-10-09",
    note: "Strong wind costs more: the standard band is 5–12 mph, and 16 mph or more scores zero for wind.",
  },
];

/** Position of `version` in SCORING_VERSIONS, or -1 when it is not listed. */
function indexOfVersion(version: string): number {
  return SCORING_VERSIONS.findIndex((v) => v.version === version);
}

/** The newest listed version. Equals SCORING_ENGINE_VERSION (tested). */
export const LATEST_SCORING_VERSION: ScoringVersion = SCORING_VERSIONS[SCORING_VERSIONS.length - 1];

/**
 * Order two engine versions: negative when `a` is older than `b`, positive
 * when newer, 0 when equal. Listed versions compare by their position in
 * SCORING_VERSIONS. If either is not listed, fall back to plain string order
 * (the version strings are date-prefixed, so that order is also correct).
 */
export function compareEngineVersions(a: string, b: string): number {
  if (a === b) return 0;
  const ia = indexOfVersion(a);
  const ib = indexOfVersion(b);
  if (ia >= 0 && ib >= 0) return ia < ib ? -1 : 1;
  return a < b ? -1 : 1;
}

/** The listed entry for `version`, or null when it is not listed. */
export function findScoringVersion(version: string): ScoringVersion | null {
  return SCORING_VERSIONS.find((v) => v.version === version) ?? null;
}
