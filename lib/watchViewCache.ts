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
//  - Keys are synthetic internal URLs; nothing is ever served from them to a visitor. A key
//    holds the beach slug and the owner-override fingerprint (see watchViewKey).
//  - Only the compact public view is stored: no snapshot, no coordinates of a visitor.
//  - Workers Cache only stores on a custom domain (not workers.dev); the site is on one.

import { MAX_WATCH_LINES, WATER_TEMP_MAX_F, WATER_TEMP_MIN_F, type WatchView } from "@/lib/watchView";

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

/**
 * The key includes the owner-override fingerprint (the same one the conditions cache key
 * uses), so a correction by the owner changes the key and every view stored before it is
 * simply never found again. The stored envelope repeats it and a read checks it too.
 */
export const watchViewKey = (slug: string, ov: string): string =>
  `${KEY_PREFIX}${encodeURIComponent(slug)}/${encodeURIComponent(ov)}`;

const TONES = new Set(["calm", "caution", "danger"]);
const KINDS = new Set(["hazard", "safety", "water", "best", "more"]);
const VIEW_KEYS = [
  "v", "slug", "name", "score", "rating", "band", "limitedData", "lines",
  "waterTempF", "sunForecast", "generatedAt", "capturedAt", "validUntil",
].sort();
const SUN_FORECAST_KEYS = ["availableAt", "eventAt", "kind", "state", "text"];

/** `sunForecast` is null or exactly { kind, state, availableAt, eventAt, text } (no score, ever). */
function isSunForecast(v: unknown): boolean {
  if (v === null) return true;
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  if (keys.length !== SUN_FORECAST_KEYS.length || keys.some((k, i) => k !== SUN_FORECAST_KEYS[i])) return false;
  return (
    (o.kind === "sunrise" || o.kind === "sunset") &&
    (o.state === "pending" || o.state === "available") &&
    isDate(o.availableAt) &&
    isDate(o.eventAt) &&
    (o.state === "pending" ? isStr(o.text) && o.text.length <= 200 : o.text === null)
  );
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isDate = (v: unknown): v is string => isStr(v) && Number.isFinite(Date.parse(v));
const isStrOrNull = (v: unknown): boolean => v === null || isStr(v);
const isIntOrNull = (v: unknown, lo: number, hi: number): boolean =>
  v === null || (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi);

/**
 * A full structural check of a stored view: exact key set, every field the right type and
 * range, every line a known kind and tone. Anything else (a damaged entry, an entry written
 * by an older or newer shape) is rejected, which only ever costs a miss.
 */
export function isWatchView(x: unknown, slug: string): x is WatchView {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const o = x as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  if (keys.length !== VIEW_KEYS.length || keys.some((k, i) => k !== VIEW_KEYS[i])) return false;
  if (o.v !== 1 || o.slug !== slug || !isStr(o.name)) return false;
  if (!isIntOrNull(o.score, 0, 100) || !isStrOrNull(o.rating) || !isStrOrNull(o.band)) return false;
  if ((o.score === null) !== (o.rating === null)) return false;
  if (typeof o.limitedData !== "boolean") return false;
  if (!isIntOrNull(o.waterTempF, WATER_TEMP_MIN_F, WATER_TEMP_MAX_F)) return false;
  if (!isSunForecast(o.sunForecast)) return false;
  if (!(o.generatedAt === null || isDate(o.generatedAt)) || !isDate(o.capturedAt) || !isDate(o.validUntil)) return false;
  if (!Array.isArray(o.lines) || o.lines.length > MAX_WATCH_LINES) return false;
  return o.lines.every((l) => {
    if (!l || typeof l !== "object" || Array.isArray(l)) return false;
    const line = l as Record<string, unknown>;
    const k = Object.keys(line);
    return k.length === 3 && isStr(line.text) && line.text.length <= 200 && KINDS.has(line.kind as string) && TONES.has(line.tone as string);
  });
}

/**
 * The stored view for `slug` + override fingerprint `ov` if one exists, is well formed, and
 * is still valid at `nowMs`; otherwise null. Read-only.
 */
export async function peekWatchView(slug: string, ov: string, nowMs: number = Date.now()): Promise<WatchView | null> {
  const cache = defaultCache();
  if (!cache) return null;
  try {
    const res = await cache.match(watchViewKey(slug, ov));
    if (!res) return null;
    const env = (await res.json()) as { v?: unknown; ov?: unknown; view?: unknown } | null;
    if (!env || typeof env !== "object" || env.v !== 1 || env.ov !== ov) return null;
    if (!isWatchView(env.view, slug)) return null;
    const until = Date.parse(env.view.validUntil);
    if (until <= nowMs) return null;
    return env.view;
  } catch {
    return null;
  }
}

/** Remember a successfully built view until its validUntil. Best effort: never throws. */
export async function storeWatchView(view: WatchView, ov: string, nowMs: number = Date.now()): Promise<boolean> {
  const cache = defaultCache();
  if (!cache) return false;
  const until = Date.parse(view.validUntil);
  const seconds = Math.min(MAX_AGE_CAP_SEC, Math.floor((until - nowMs) / 1000));
  if (!Number.isFinite(seconds) || seconds <= 0) return false;
  try {
    await cache.put(
      watchViewKey(view.slug, ov),
      new Response(JSON.stringify({ v: 1, ov, view }), {
        headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${seconds}` },
      }),
    );
    return true;
  } catch {
    return false;
  }
}
