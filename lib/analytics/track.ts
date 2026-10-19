/**
 * Send one product-analytics event, only if PostHog is already running.
 *
 * PostHog loads late (components/PostHogInit.tsx, after the page is idle), so an event fired
 * before that is simply dropped: analytics must never slow the page, queue work, or throw.
 * Same privacy rules as the setup: anonymous, no identify(), no personal fields in `props`.
 */
export function track(event: string, props: Record<string, string | number | boolean | null> = {}): void {
  if (typeof window === "undefined") return;
  // soft-fallback: analytics must never break or reload the page; a failed load means no event.
  import("posthog-js")
    .then(({ default: posthog }) => {
      if (posthog.__loaded) posthog.capture(event, props);
    })
    .catch(() => {
      /* analytics must never break the page */
    });
}
