// One guarded reload when a piece of the page's own code is GONE from the server.
//
// After a deploy, the old build's files are gone from the server. A page that is still on
// the old build (an open tab, the app shell mid-session, or a page the service worker
// answered from its saved copy) then asks for a lazy piece (a flip-card back, the camera
// viewer, the day view) and gets a 404. Without this, the error boundary (app/error.tsx)
// replaces the whole dashboard. With it, the page reloads once and gets the new build.
//
// The same load error comes from a weak or lost signal (offline, a timeout). A reload then
// makes things worse: the browser's offline page, or in the app a reload that never lands.
// So the page reloads ONLY when the browser says it is online AND a probe proves that the
// server answers and the file is gone: `HEAD <the failed file>` (no cache) returns 404 or 410.
// Offline, a failed or slow probe, any other answer, or no file named in the error: no
// reload; the error goes on as before (the piece's own fallback, or the error screen with
// its retry button).
//
// The guard is in sessionStorage, so a page that keeps failing reloads at most once per
// CHUNK_RELOAD_GAP_MS and then shows the error as before: it can never loop. No reload
// while lib/reloadGuard.ts holds one (a purchase, a restore, Beach Mode).
//
// Use it only where a person opened something (next/dynamic loaders, the changelog
// toggle). A background load with a soft fallback (analytics, billing, push) keeps its
// fallback and is marked `// soft-fallback:` (lib/chunkReload.test.ts checks).

import { reloadHeld } from "@/lib/reloadGuard";

export const CHUNK_RELOAD_KEY = "ibd:chunk-reload-at";
export const CHUNK_RELOAD_GAP_MS = 5 * 60_000;
/** The probe must answer within this, or the network is treated as the problem. */
export const PROBE_TIMEOUT_MS = 4000;

const CHUNK_MESSAGE =
  /Loading (?:CSS )?chunk [^\s]+ failed|Failed to load chunk|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i;

/** Is this the error a failed build-file load gives (webpack, Chrome, Firefox, Safari)? */
export function isChunkLoadError(e: unknown): boolean {
  if (!e) return false;
  if (typeof e === "string") return CHUNK_MESSAGE.test(e);
  if (typeof e !== "object") return false;
  const err = e as { name?: unknown; message?: unknown };
  if (err.name === "ChunkLoadError") return true;
  return typeof err.message === "string" && CHUNK_MESSAGE.test(err.message);
}

/**
 * The build file the error names, as a same-origin path (/_next/static/...), or null.
 * Webpack puts it on `error.request` and in the message ("(missing: <url>)"); browsers
 * put it after "dynamically imported module: ". Any other host is never probed.
 */
export function failedChunkPath(e: unknown, origin: string): string | null {
  const err = (e ?? {}) as { request?: unknown; message?: unknown };
  const text = typeof e === "string" ? e : typeof err.message === "string" ? err.message : "";
  const candidates = [
    typeof err.request === "string" ? err.request : null,
    /\((?:missing|error|timeout|load|loading): ([^)\s]+)\)/.exec(text)?.[1] ?? null,
    /dynamically imported module:?\s+(\S+)/.exec(text)?.[1] ?? null,
    /\((\/_next\/static\/[^)\s]+)\)/.exec(text)?.[1] ?? null,
  ];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const u = new URL(c, origin);
      if (u.origin === origin && u.pathname.startsWith("/_next/static/")) return u.pathname + u.search;
    } catch {
      /* not a URL */
    }
  }
  return null;
}

/** Pure decision: may this page reload now (before the probe)? */
export function shouldReloadForChunkError(i: {
  error: unknown;
  now: number;
  lastReloadAt: number | null;
  held: boolean;
  storageOk: boolean;
  online: boolean;
}): boolean {
  if (!isChunkLoadError(i.error)) return false;
  if (!i.online) return false; // weak or no signal: a reload would only make it worse
  if (i.held) return false;
  // Without sessionStorage the guard cannot survive the reload, so do not reload at all.
  if (!i.storageOk) return false;
  if (i.lastReloadAt != null && i.now >= i.lastReloadAt && i.now - i.lastReloadAt < CHUNK_RELOAD_GAP_MS) return false;
  return true;
}

export type ProbeFetch = (url: string, init: RequestInit) => Promise<{ status: number }>;

/**
 * Does the server answer, and say the file is gone? True only for a 404 or 410 within
 * PROBE_TIMEOUT_MS. A network failure, a timeout or any other status is false.
 */
export async function serverSaysGone(path: string, fetchFn: ProbeFetch, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = await Promise.race([
      fetchFn(path, { method: "HEAD", cache: "no-store", credentials: "same-origin" }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    return !!res && (res.status === 404 || res.status === 410);
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ChunkReloadDeps {
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  online: boolean;
  origin: string;
  fetch: ProbeFetch;
  reload: () => void;
  now: number;
  held: boolean;
}

function browserDeps(): ChunkReloadDeps | null {
  if (typeof window === "undefined") return null;
  let storage: ChunkReloadDeps["storage"] = null;
  try {
    storage = window.sessionStorage;
  } catch {
    storage = null;
  }
  return {
    storage,
    online: typeof navigator === "undefined" || navigator.onLine !== false,
    origin: window.location.origin,
    fetch: (u, init) => window.fetch(u, init),
    reload: () => window.location.reload(),
    now: Date.now(),
    held: reloadHeld(),
  };
}

/**
 * Reload once if the error is a build file the server no longer has. Resolves true when
 * a reload has started, false when the error should go on as before.
 */
export async function reloadIfChunkGone(error: unknown, deps: ChunkReloadDeps | null = browserDeps()): Promise<boolean> {
  if (!deps || !isChunkLoadError(error)) return false;
  let lastReloadAt: number | null = null;
  let storageOk = !!deps.storage;
  try {
    const raw = deps.storage?.getItem(CHUNK_RELOAD_KEY) ?? null;
    lastReloadAt = raw ? Number(raw) : null;
    if (lastReloadAt != null && !Number.isFinite(lastReloadAt)) lastReloadAt = null;
  } catch {
    storageOk = false;
  }
  const may = shouldReloadForChunkError({
    error,
    now: deps.now,
    lastReloadAt,
    held: deps.held,
    storageOk,
    online: deps.online,
  });
  if (!may) return false;
  const path = failedChunkPath(error, deps.origin);
  if (!path) return false; // cannot prove the file is gone
  if (!(await serverSaysGone(path, deps.fetch))) return false;
  if (reloadHeld()) return false; // a purchase may have started during the probe
  try {
    deps.storage!.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  deps.reload();
  return true;
}

/**
 * For `import(...).catch(chunkFailed)` on a piece the person opened: a build file the server
 * no longer has starts the one reload and leaves the import pending (the page is going
 * away, so nothing flashes an error). Anything else (offline, a timeout, a second failure
 * inside the guard window, any other error) is rethrown as before.
 */
export async function chunkFailed(e: unknown): Promise<never> {
  if (await reloadIfChunkGone(e)) return new Promise<never>(() => {});
  throw e;
}
