// The beach page the person last opened in the app. Saved so the Apple Watch
// app has a default beach for people who never set a home beach
// (lib/useWatchSync.ts sends it; lib/watchSync.ts carries it).
// SSR-safe: every export is a no-op / returns null on the server.

const STORAGE_KEY = "bd:last-viewed-beach";

export function getLastViewedBeach(): string | null {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setLastViewedBeach(slug: string): void {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, slug);
  } catch {
    /* private mode / storage disabled */
  }
}
