// The user's saved "home" beach slug (for FirstRunBanner, morning alerts,
// presence defaults, etc). SSR-safe: every export is a no-op / returns null
// on the server.

import { getLastViewedBeach } from "@/lib/lastViewedBeach";
import { syncWatchBeaches } from "@/lib/watchSync";

const STORAGE_KEY = "bd:home-beach";

export function getHomeBeach(): string | null {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setHomeBeach(slug: string): void {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, slug);
  } catch {
    /* private mode / storage disabled */
  }
  // Apple Watch app (iOS only; a no-op anywhere else). Sent even when storage
  // failed: the watch should still follow what the person just picked.
  void syncWatchBeaches(slug, [], getLastViewedBeach());
}

export function clearHomeBeach(): void {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  void syncWatchBeaches(null, [], getLastViewedBeach());
}
