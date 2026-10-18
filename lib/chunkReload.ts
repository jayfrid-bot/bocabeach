// One guarded reload when a piece of the page's own code fails to load.
//
// After a deploy, the old build's files are gone from the server. A page that is still on
// the old build (an open tab, the app shell mid-session, or a page the service worker
// answered from its saved copy) then asks for a lazy piece (a flip-card back, the camera
// viewer, a Plus sheet) and gets a 404. Without this, the error boundary (app/error.tsx)
// replaces the whole dashboard. With it, the page reloads once and gets the new build.
//
// The guard is in sessionStorage, so a page that keeps failing reloads at most once per
// CHUNK_RELOAD_GAP_MS and then shows the error as before: it can never loop. No reload
// while lib/reloadGuard.ts holds one (a purchase, a restore, Beach Mode).

import { reloadHeld } from "@/lib/reloadGuard";

export const CHUNK_RELOAD_KEY = "ibd:chunk-reload-at";
export const CHUNK_RELOAD_GAP_MS = 5 * 60_000;

const CHUNK_MESSAGE =
  /Loading (?:CSS )?chunk [^\s]+ failed|Failed to load chunk|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i;

/** Is this the error a missing build file gives (webpack, Chrome, Firefox, Safari)? */
export function isChunkLoadError(e: unknown): boolean {
  if (!e) return false;
  if (typeof e === "string") return CHUNK_MESSAGE.test(e);
  if (typeof e !== "object") return false;
  const err = e as { name?: unknown; message?: unknown };
  if (err.name === "ChunkLoadError") return true;
  return typeof err.message === "string" && CHUNK_MESSAGE.test(err.message);
}

/** Pure decision: reload now for this error? */
export function shouldReloadForChunkError(i: {
  error: unknown;
  now: number;
  lastReloadAt: number | null;
  held: boolean;
  storageOk: boolean;
}): boolean {
  if (!isChunkLoadError(i.error)) return false;
  if (i.held) return false;
  // Without sessionStorage the guard cannot survive the reload, so do not reload at all.
  if (!i.storageOk) return false;
  if (i.lastReloadAt != null && i.now >= i.lastReloadAt && i.now - i.lastReloadAt < CHUNK_RELOAD_GAP_MS) return false;
  return true;
}

/** In the browser: reload once for a chunk error. True when a reload has started. */
export function reloadOnceForChunkError(error: unknown): boolean {
  if (typeof window === "undefined") return false;
  let lastReloadAt: number | null = null;
  let storageOk = true;
  try {
    const raw = window.sessionStorage.getItem(CHUNK_RELOAD_KEY);
    lastReloadAt = raw ? Number(raw) : null;
    if (lastReloadAt != null && !Number.isFinite(lastReloadAt)) lastReloadAt = null;
  } catch {
    storageOk = false;
  }
  const now = Date.now();
  if (!shouldReloadForChunkError({ error, now, lastReloadAt, held: reloadHeld(), storageOk })) return false;
  try {
    window.sessionStorage.setItem(CHUNK_RELOAD_KEY, String(now));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

/**
 * For `import(...).catch(chunkFailed)`: a chunk error starts the one reload and leaves the
 * import pending (the page is going away, so nothing flashes an error); any other error,
 * or a second failure inside the guard window, is rethrown as before.
 */
export function chunkFailed(e: unknown): Promise<never> {
  if (reloadOnceForChunkError(e)) return new Promise<never>(() => {});
  return Promise.reject(e);
}
