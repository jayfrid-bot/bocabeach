// Honesty rules for the beach-cam stills: what we are allowed to CLAIM about
// the frame on screen. Pure and client-safe so the badge/overlay copy is one
// decision, unit-tested, instead of ad-hoc booleans in the component.

/**
 * What the still on screen honestly is.
 *
 * - `live`        — the source published a recent capture time AND the page's
 *                   own data is recent. Only this state may say "● Live".
 * - `feed-stale`  — our data is current, but the provider's capture time is
 *                   old: the camera feed is paused/frozen. Say when the last
 *                   frame came in.
 * - `data-stale`  — the page itself is holding an old snapshot (failed refetch,
 *                   or the app sat in the background). The frame may be far
 *                   older than any timestamp we hold, so we promise nothing and
 *                   say we're refreshing.
 * - `unverified`  — no capture time at all (some cams publish none), or the
 *                   client clock isn't readable yet (first render / SSR). We
 *                   cannot confirm the still is current, so we must not claim
 *                   it is.
 */
export type CamFreshnessState = "live" | "feed-stale" | "data-stale" | "unverified";

/** A capture older than this can't be called "Live" (minutes). */
export const LIVE_CAPTURE_MAX_MIN = 15;
/** Page data older than this can't be called "Live" (minutes). */
export const LIVE_DATA_MAX_MIN = 10;

export interface CamFreshnessInput {
  /** Capture time of the displayed still (ISO), when the source publishes one. */
  capturedAt?: string | null;
  /** When the snapshot the page is holding was generated (ISO). */
  dataAt?: string | null;
  /** Client wall clock in ms; null before mount (server render / hydration). */
  now: number | null;
}

function ageMin(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (now - t) / 60000;
}

/**
 * Decide what the cam tile may claim.
 *
 * Order matters. Data staleness is checked BEFORE capture staleness, because a
 * stale page makes every timestamp it holds untrustworthy — saying "the feed is
 * paused" would falsely imply our own data is current.
 */
export function camFreshness({ capturedAt, dataAt, now }: CamFreshnessInput): CamFreshnessState {
  if (now == null) return "unverified";
  const captureAge = ageMin(capturedAt, now);
  if (captureAge == null) return "unverified";
  // An unreadable/absent data time is treated as stale: we can't prove the page
  // refreshed, so we don't get to say "Live".
  const dataAge = ageMin(dataAt, now);
  if (dataAge == null || dataAge > LIVE_DATA_MAX_MIN) return "data-stale";
  if (captureAge > LIVE_CAPTURE_MAX_MIN) return "feed-stale";
  return "live";
}
