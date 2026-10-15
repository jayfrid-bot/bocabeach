// A tiny per-datacenter store of the most recent watch view for each beach, in the
// Workers Cache API (caches.default). It exists for ONE reason: a request that compares
// several beaches (the agent API and MCP) can read a recent view without starting a
// conditions build, so one request never fans out into several cold builds.
//
// Rules:
//  - Written whenever a view is built successfully (lib/watchLoad.ts, any caller). Never
//    for a partial build and never for a view that is already past its validUntil.
//  - The entry lives exactly as long as the view is valid: Cache-Control max-age = seconds
//    until validUntil. A read also re-checks validUntil against the clock.
//  - A read (peek) only calls caches.default.match. It writes nothing and builds nothing.
//  - No KV writes (free-tier write quota). The cache is per datacenter, which is fine: a
//    miss only means "not compared right now".
//  - Where `caches` does not exist (Node, tests, next dev), peek is a miss and store does nothing.
//  - Keys are synthetic internal URLs; nothing is ever served from them to a visitor.
//  - Only the compact public view is stored: no snapshot, no coordinates of a visitor.
//  - Workers Cache only stores on a custom domain (not workers.dev); the site is on one.

import type { WatchView } from "@/lib/watchView";

const KEY_PREFIX = "https://cache.isitbeachday.internal/watchview/";
/** Never keep an entry longer than the watch view's own maximum validity. */
const MAX_AGE_CAP_SEC = 15 * 60;

interface CacheLike {
  match(key: string): Promise<Response | undefined>;
  put(key: string, res: Response): Promise<void>;
}

function defaultCache(): CacheLike | null {
  try {
    const c = (globalThis as { caches?: { default?: CacheLike } }).caches;
    const d = c?.default;
    return d && typeof d.match === "function" && typeof d.put === "function" ? d : null;
  } catch {
    return null;
  }
}

export const watchViewKey = (slug: string): string => `${KEY_PREFIX}${encodeURIComponent(slug)}`;

const isStr = (v: unknown): v is string => typeof v === "string";

/** The stored view for `slug` if one exists and is still valid at `nowMs`; otherwise null. Read-only. */
export async function peekWatchView(slug: string, nowMs: number = Date.now()): Promise<WatchView | null> {
  const cache = defaultCache();
  if (!cache) return null;
  try {
    const res = await cache.match(watchViewKey(slug));
    if (!res) return null;
    const v = (await res.json()) as Partial<WatchView> | null;
    if (!v || typeof v !== "object" || v.v !== 1 || v.slug !== slug) return null;
    if (!isStr(v.validUntil) || !isStr(v.capturedAt) || !Array.isArray(v.lines)) return null;
    const until = Date.parse(v.validUntil);
    if (!Number.isFinite(until) || until <= nowMs) return null;
    return v as WatchView;
  } catch {
    return null;
  }
}

/** Remember a successfully built view until its validUntil. Best effort: never throws. */
export async function storeWatchView(view: WatchView, nowMs: number = Date.now()): Promise<boolean> {
  const cache = defaultCache();
  if (!cache) return false;
  const until = Date.parse(view.validUntil);
  const seconds = Math.min(MAX_AGE_CAP_SEC, Math.floor((until - nowMs) / 1000));
  if (!Number.isFinite(seconds) || seconds <= 0) return false;
  try {
    await cache.put(
      watchViewKey(view.slug),
      new Response(JSON.stringify(view), {
        headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${seconds}` },
      }),
    );
    return true;
  } catch {
    return false;
  }
}
