// Stable per-device identifier for Plus API calls. No auth — same trust model
// as the push token today (see docs/PLUS_BUILD_SPEC.md's Identity section).

const STORAGE_KEY = "bd:device-id";

/** RFC-4122 v4 UUID. Prefers the platform CSPRNG; falls back to Math.random
 *  only when crypto.randomUUID isn't available (very old WebViews). */
function uuidV4(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * This device's stable id, minted once into localStorage and reused after.
 * SSR-safe: returns "" on the server (no window/localStorage), so callers
 * should treat "" as "not yet available" and re-read on the client.
 */
export function getDeviceId(): string {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return "";
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing) return existing;
    const id = uuidV4();
    localStorage.setItem(STORAGE_KEY, id);
    return id;
  } catch {
    // Private browsing / storage disabled — can't persist an id.
    return "";
  }
}
