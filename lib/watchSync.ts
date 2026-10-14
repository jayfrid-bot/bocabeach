// Tells the Apple Watch app which beach is home (and which are favorites).
//
// The iOS shell exposes a local Capacitor plugin, `WatchSync`
// (ios/App/App/WatchSyncPlugin.swift), that keeps the values in the App Group
// and sends them to the paired watch with WatchConnectivity. In a normal
// browser, on Android, or in an iOS build that predates the plugin there is
// no plugin: every export here is then a quiet no-op. Nothing throws.
//
// Same resolver shape and the same `.then` trap as lib/plus/liveActivity.ts:
// getPlugin() is SYNCHRONOUS. Never `await` the plugin object itself, only the
// Promises its methods return. Capacitor's plugin proxy answers every property
// access, including `.then`, with a native call that never resolves.

/** `boca-raton`: lowercase words joined by hyphens. Mirrors WatchSync.cleanSlug
 *  in ios/Shared/WatchSyncPayload.swift. */
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_SLUG_LENGTH = 64;
/** Mirrors WatchSync.maxFavorites on the native side. */
export const MAX_FAVORITES = 20;

export interface WatchBeaches {
  /** The home beach, or null when there is none. */
  homeSlug: string | null;
  favorites: string[];
  /** The beach last opened in the app. The watch uses it only when there is no
   *  home beach and nothing was picked on the watch. */
  lastViewedSlug: string | null;
}

function cleanSlug(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length < 1 || raw.length > MAX_SLUG_LENGTH) return null;
  return SLUG_PATTERN.test(raw) ? raw : null;
}

/** Drops anything that is not a valid slug, removes duplicates, keeps order and
 *  caps the list. Bad input becomes "no home, no favorites"; never throws. */
export function buildWatchPayload(home: unknown, favorites: unknown, lastViewed: unknown = null): WatchBeaches {
  const seen = new Set<string>();
  const list: string[] = [];
  if (Array.isArray(favorites)) {
    for (const item of favorites) {
      const slug = cleanSlug(item);
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      list.push(slug);
      if (list.length === MAX_FAVORITES) break;
    }
  }
  return { homeSlug: cleanSlug(home), favorites: list, lastViewedSlug: cleanSlug(lastViewed) };
}

interface WatchSyncPlugin {
  setBeaches(opts: WatchBeaches): Promise<{ ok: boolean; reason?: string }>;
}

type CapacitorGlobal = {
  isPluginAvailable?: (name: string) => boolean;
  Plugins?: { WatchSync?: WatchSyncPlugin };
};

function getPlugin(): WatchSyncPlugin | null {
  if (typeof window === "undefined") return null;
  const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  if (!cap) return null;
  if (cap.isPluginAvailable && !cap.isPluginAvailable("WatchSync")) return null;
  return cap.Plugins?.WatchSync ?? null;
}

/** True only when the native plugin is reachable (iOS app with the watch build). */
export function isWatchSyncAvailable(): boolean {
  return getPlugin() != null;
}

let lastSentKey: string | null = null;

/** Test hook: forget what was last sent. */
export function resetWatchSyncState(): void {
  lastSentKey = null;
}

/**
 * Send the home beach, favorites and last-viewed beach to the watch. Returns true when the native
 * side took the payload, false when there is no plugin or it refused. An
 * unchanged payload is not sent again in the same page session.
 */
export async function syncWatchBeaches(
  home: unknown,
  favorites: unknown = [],
  lastViewed: unknown = null,
): Promise<boolean> {
  const plugin = getPlugin();
  if (!plugin) return false;
  const payload = buildWatchPayload(home, favorites, lastViewed);
  const key = JSON.stringify(payload);
  if (key === lastSentKey) return true;
  try {
    const res = await plugin.setBeaches(payload);
    if (res?.ok) {
      lastSentKey = key;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
