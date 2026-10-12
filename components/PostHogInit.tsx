"use client";

import { useEffect } from "react";
import { POSTHOG_HOST, POSTHOG_KEY, shouldLoadAnalytics } from "@/lib/analytics/posthog";
import { nativePlatform } from "@/lib/push/native";

/** Mounted once in the root layout. Loads PostHog only when a key is set
 *  (lib/analytics/posthog.ts), as a separate chunk so pages without it stay
 *  as light as before. */
export function PostHogInit() {
  useEffect(() => {
    if (!shouldLoadAnalytics(POSTHOG_KEY, navigator.webdriver === true)) return;
    let cancelled = false;
    import("posthog-js")
      .then(({ default: posthog }) => {
        if (cancelled || posthog.__loaded) return;
        posthog.init(POSTHOG_KEY, {
          api_host: POSTHOG_HOST,
          person_profiles: "identified_only",
          persistence: "localStorage",
          capture_pageview: "history_change", // client-side route changes count too
          capture_pageleave: true, // needed for time on page
          autocapture: true,
          disable_session_recording: true,
          disable_surveys: true,
          enable_heatmaps: false,
        });
        // Split every report by website vs iPhone app vs Android app.
        posthog.register({ platform: nativePlatform() });
      })
      .catch(() => {
        /* analytics must never break the page */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}
