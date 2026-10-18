"use client";

import { useEffect } from "react";
import { POSTHOG_HOST, POSTHOG_KEY, shouldLoadAnalytics } from "@/lib/analytics/posthog";
import { nativePlatform } from "@/lib/push/native";
import { chunkFailed } from "@/lib/chunkReload";

/** How long after the page has finished loading we are willing to wait for the
 *  browser to go idle before loading analytics anyway. */
const IDLE_TIMEOUT_MS = 2_000;

/** Run `fn` once the page has finished loading AND the browser is idle. The SDK
 *  is ~300 KB of script (~95 KB compressed); fetching and parsing it during first
 *  paint competed with the page's own scripts for a phone's bandwidth and CPU. */
function whenIdleAfterLoad(fn: () => void): () => void {
  let cancelled = false;
  let idleHandle: number | undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    if (cancelled) return;
    const ric = (window as unknown as {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
    }).requestIdleCallback;
    if (ric) idleHandle = ric(() => !cancelled && fn(), { timeout: IDLE_TIMEOUT_MS });
    else timeoutHandle = setTimeout(() => !cancelled && fn(), 200);
  };
  if (document.readyState === "complete") run();
  else window.addEventListener("load", run, { once: true });
  return () => {
    cancelled = true;
    window.removeEventListener("load", run);
    if (idleHandle !== undefined) (window as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback?.(idleHandle);
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  };
}

/** Mounted once in the root layout. Loads PostHog only when a key is set
 *  (lib/analytics/posthog.ts), as a separate chunk, and only after the page has
 *  loaded and gone idle, so it never slows first paint. The first page view is
 *  still counted (PostHog records it when it initializes); a visitor who leaves
 *  before the page finishes loading is not counted. */
export function PostHogInit() {
  useEffect(() => {
    if (!shouldLoadAnalytics(POSTHOG_KEY, navigator.webdriver === true)) return;
    let cancelled = false;
    const cancelWait = whenIdleAfterLoad(() => {
      import("posthog-js")
        .catch(chunkFailed)
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
    });
    return () => {
      cancelled = true;
      cancelWait();
    };
  }, []);
  return null;
}
