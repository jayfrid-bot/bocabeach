/**
 * PostHog product analytics: time on site, pages per visit, paths, and which
 * buttons people tap — the parts Cloudflare Web Analytics can't show.
 *
 * The app shell loads the live site (capacitor.config.ts), so this one setup
 * covers the website, the iPhone app and the Android app.
 *
 * Privacy choices (mirrored on /privacy):
 * - Anonymous only. We never call identify() and never send the device id,
 *   home beach, profile or push token. `person_profiles: "identified_only"`
 *   means PostHog keeps no person record for us.
 * - No cookies: PostHog's random visitor id lives in localStorage.
 * - No session recordings, no surveys, no heatmap recordings.
 *
 * Off until POSTHOG_KEY is set. The key is a public, write-only project key
 * (it ships in every page by design), so it lives here rather than in a secret.
 */

/** PostHog project API key ("phc_…"). Empty = analytics off. */
export const POSTHOG_KEY = "";

/** PostHog US cloud ingestion host. */
export const POSTHOG_HOST = "https://us.i.posthog.com";

export function analyticsEnabled(key: string = POSTHOG_KEY): boolean {
  return /^phc_[A-Za-z0-9]{20,}$/.test(key);
}

/** Pure decision: load analytics only with a real key, outside automated
 *  browsers (our Playwright checks, crawlers that run JS). */
export function shouldLoadAnalytics(key: string, automated: boolean): boolean {
  return analyticsEnabled(key) && !automated;
}
