// The user's saved "home" beach slug (for FirstRunBanner, morning alerts,
// presence defaults, etc). SSR-safe: every export is a no-op / returns null
// on the server.

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
}

export function clearHomeBeach(): void {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
