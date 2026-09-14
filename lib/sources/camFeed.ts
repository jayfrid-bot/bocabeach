/**
 * Where the cam-vision feed lives for a beach.
 *
 * The vision job (scripts/cam_seaweed.py) now processes every beach in
 * config/vision-cams.json in one run and publishes ONE file per beach —
 * cam_seaweed.<slug>.json — to the `sargassum-data` branch. A beach with no
 * registry entry (any beach the job doesn't know about yet) simply gets a 404
 * here, which sargassum.ts/busyness.ts turn into the existing honest "no cam
 * data" path (never an error).
 *
 * Boca Raton is the one beach that had cams before this split, so — for
 * transition safety only — its feed falls back to the pre-split single-file
 * `cam_seaweed.json` if `cam_seaweed.boca-raton.json` 404s (e.g. an old
 * `sargassum-data` branch commit that predates the per-beach rewrite). No
 * other beach gets this fallback: a beach that never had a legacy file has
 * nothing useful to fall back to.
 */

/** Branch base the vision job force-pushes to every cycle. Override for local
 *  testing against a fork or a different branch/host. */
const CAM_FEED_BASE =
  process.env.CAM_SEAWEED_FEED_BASE ??
  "https://raw.githubusercontent.com/jayfrid-bot/bocabeach/sargassum-data";

/** The only slug allowed to fall back to the legacy single-beach feed. */
export const LEGACY_FALLBACK_SLUG = "boca-raton";

/** Per-beach cam-vision feed URL: cam_seaweed.<slug>.json. */
export function camFeedUrl(slug: string): string {
  return `${CAM_FEED_BASE}/cam_seaweed.${slug}.json`;
}

/** The pre-split single-beach feed. The vision job keeps publishing this as a
 *  copy of boca-raton's file for one release (see scripts/cam_seaweed.py). */
export function legacyCamFeedUrl(): string {
  return `${CAM_FEED_BASE}/cam_seaweed.json`;
}

/** Whether `slug` may fall back to the legacy single-beach feed on a 404. */
export function allowsLegacyCamFeedFallback(slug: string): boolean {
  return slug === LEGACY_FALLBACK_SLUG;
}

/**
 * URLs to try, in order, for a beach's cam-vision feed: its own per-beach
 * file, then — for Boca Raton only — the pre-split legacy file. Callers fetch
 * each in turn and stop at the first non-404 response.
 */
export function camFeedUrlCandidates(slug: string): string[] {
  const urls = [camFeedUrl(slug)];
  if (allowsLegacyCamFeedFallback(slug)) urls.push(legacyCamFeedUrl());
  return urls;
}
