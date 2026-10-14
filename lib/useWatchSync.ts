"use client";

import { useEffect } from "react";
import { getHomeBeach } from "@/lib/homeBeach";
import { getLastViewedBeach, setLastViewedBeach } from "@/lib/lastViewedBeach";
import { syncWatchBeaches } from "@/lib/watchSync";

/** Send everything the watch needs, from what is saved on this phone. */
export function syncWatchFromStorage(): Promise<boolean> {
  return syncWatchBeaches(getHomeBeach(), [], getLastViewedBeach());
}

/**
 * Keeps the Apple Watch app's beaches current. `setHomeBeach` and
 * `clearHomeBeach` (lib/homeBeach.ts) send every home change; this sends the
 * saved values on load and on every return to the foreground, so a beach saved
 * before the watch app existed, or before the watch was paired, still arrives.
 * A no-op everywhere except the iOS app.
 *
 * Favorites: the web app has no favorites list yet. When it gets one, pass it
 * as the second argument here and in lib/homeBeach.ts.
 */
export function useWatchSync(): void {
  useEffect(() => {
    void syncWatchFromStorage();
    const onVisible = () => {
      if (document.visibilityState === "visible") void syncWatchFromStorage();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
}

/**
 * Remember the beach page being viewed and tell the watch. The watch shows it
 * when the person has no home beach, so free users still get a beach on their
 * wrist. Mount in the beach dashboard with its slug; skipped in admin preview.
 */
export function useRecordLastViewedBeach(slug: string, skip = false): void {
  useEffect(() => {
    if (skip || !slug) return;
    setLastViewedBeach(slug);
    void syncWatchFromStorage();
  }, [slug, skip]);
}
