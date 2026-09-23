/**
 * Shared bound for the rolling cam-read `history` arrays (busyness, clarity,
 * sargassum all read the same feed) — the upstream feed can in principle grow
 * without limit, and every history-derived computation (by-hour/by-day
 * aggregation, the vs-average baseline, the next-cam-read estimate) is only
 * ever interested in a bounded recent window. Applying this once, right after
 * parsing, keeps every downstream pass over `history` cheap regardless of how
 * large the published feed gets.
 */

export const MAX_CAM_HISTORY_ENTRIES = 1200;

/**
 * The newest `max` entries of a rolling cam-read history array, assuming the
 * array is already in roughly chronological (oldest-first) order — as every
 * beach-cam feed publishes it. A no-op copy when already within the bound.
 */
export function capCamHistory<T>(
  history: readonly T[] | undefined,
  max: number = MAX_CAM_HISTORY_ENTRIES,
): T[] {
  const h = history ?? [];
  return h.length > max ? h.slice(h.length - max) : [...h];
}
