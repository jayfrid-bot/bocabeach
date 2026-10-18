// Edge cache for the beach pages and the public conditions JSON (docs/benchmarks/2026-10-18-perf/
// edge-cache.md). The Worker entry (worker.ts) wraps OpenNext's worker with this, so a repeat
// request for a beach is answered from a stored copy in a few milliseconds instead of a full
// server render. The stored copy is refreshed in the background.
//
// What is cached (everything else goes straight through, untouched):
//   GET/HEAD  /                     the flagship beach page (PRIMARY_SLUG)
//   GET/HEAD  /<beach-slug>         a beach page (a 200 with the ibd-edge marker, or the flagship's 308)
//   GET/HEAD  /api/conditions/<slug>  the public conditions JSON (a 200 with x-ibd-edge ok=1)
//   GET/HEAD  /api/conditions/<slug>/lean  the dashboard's packed copy of it (same rule)
// and only with NO query string, NO Authorization, NO Range and none of Next's client-router
// headers (RSC, Next-Router-*, Next-Action, Next-Url). Cookies are ignored: these routes read none
// (a test checks the page sources). The only request input a beach page reads is the User-Agent
// (the native app shell, lib/nativeRequest.ts), so the key has a web/native variant.
// RULE FOR REVIEWERS: if a beach page or the conditions route ever reads another request input
// (a cookie, a header, searchParams, geolocation), it must be added to the key or to the bypass
// list here IN THE SAME CHANGE, or one visitor's page is served to everyone.
//
// The key holds: the Worker version id (CF_VERSION_METADATA), so HTML from one deploy is never
// served by another (its /_next/static chunks may not exist there); the owner-override
// fingerprint of the beach (the same query as lib/quality/overrides.ts), so an owner correction
// changes the key; the path; and the web/native variant.
//
// Freshness (per stored copy):
//   fresh   stored <= FRESH_MS ago and its data generated <= DATA_FRESH_MS ago: served as it is.
//   stale   stored <= MAX_STALE_MS ago: served, and ONE background refresh starts (ctx.waitUntil,
//           one in flight per key per isolate, at most one try per MIN_REFRESH_GAP_MS).
//   expired older, or its data is older than DATA_MAX_AGE_MS: not served; the request renders
//           inline, like before this cache existed.
// No scheduled pre-builds: a copy is only ever built because someone asked for that beach.
//
// Storage: an in-isolate LRU (MEMORY_BUDGET_BYTES) in front of the Workers Cache API
// (caches.default, per datacenter). No KV: Workers Free allows 1,000 KV writes a day.
// caches.default does nothing on *.workers.dev (Cloudflare documents this), so a preview URL only
// shows the in-isolate tier; the custom domains get both.
//
// Browser headers are kept exactly as the route set them (pages stay `private, no-store`), so a
// browser never keeps an old page; the edge copy is separate. Two headers are added:
// x-edge-cache (HIT, STALE, MISS, BYPASS), x-edge-age (seconds since the copy was stored) and
// x-edge-data-age (seconds since its data was generated).
//
// No imports from the app except the two dependency-free files below (wrangler bundles this
// file outside Next).

import { EDGE_DATA_HEADER, findEdgeMarker, parseEdgeMarkerContent } from "./edgeMarker";
import { OVERRIDES_FINGERPRINT_SQL, fingerprintFromRow } from "./quality/overridesFingerprintSql";

/** Bump to drop every stored copy (a change in what a copy holds). */
export const EDGE_CACHE_FORMAT = "1";
/** The beach "/" renders (config/locations.ts: the first curated one). A test checks it. */
export const PRIMARY_SLUG = "boca-raton";

export const FRESH_MS = 60_000;
export const MAX_STALE_MS = 10 * 60_000;
/** A copy whose data is older than this is refreshed even inside FRESH_MS. */
export const DATA_FRESH_MS = 5 * 60_000;
/** A copy whose data is older than this is never served: the request renders inline. */
export const DATA_MAX_AGE_MS = 30 * 60_000;
export const MIN_REFRESH_GAP_MS = 15_000;
/** Owner-override fingerprint: reused for this long without a database read... */
export const FP_FRESH_MS = 30_000;
/** ...and reused (with a background re-read) up to this long; past it a request waits for D1. */
export const FP_MAX_STALE_MS = 3 * 60_000;
export const FP_TIMEOUT_MS = 400;
export const MAX_BODY_BYTES = 2_000_000;
export const MEMORY_BUDGET_BYTES = 8_000_000;
export const MEMORY_MAX_ENTRIES = 64;

const KEY_ORIGIN = "https://edge-cache.isitbeachday.internal";

/** Top-level paths that are not beaches (app/ routes and files). A test checks app/ against it. */
export const RESERVED_TOP_LEVEL = new Set([
  "admin", "api", "find", "get-app", "mcp", "privacy", "sticker", "support", "sw-kill",
  "opengraph-image", "twitter-image", "icon", "apple-icon", "manifest", "robots", "sitemap",
  "_next", "favicon",
]);

/** Request headers that make a response depend on more than the path (Next's client router). */
export const BYPASS_HEADERS = [
  "authorization",
  "range",
  "rsc",
  "next-router-state-tree",
  "next-router-prefetch",
  "next-router-segment-prefetch",
  "next-action",
  "next-url",
];

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const NATIVE_UA = /IsItBeachDayApp/i; // the same test as lib/nativeRequest.ts (a test checks it)

export type RouteKind = "page" | "api";
export interface CacheableRoute {
  kind: RouteKind;
  /** The request path, e.g. "/", "/jupiter", "/api/conditions/jupiter". */
  path: string;
  /** The beach whose data the answer holds ("/" is PRIMARY_SLUG). */
  slug: string;
  variant: "web" | "native";
}

export type Classified = { route: CacheableRoute } | { bypass: string };

/** Decide whether a request may be answered from the edge cache, and under which route. */
export function classify(request: Request): Classified {
  if (request.method !== "GET" && request.method !== "HEAD") return { bypass: "method" };
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return { bypass: "url" };
  }
  if (url.search !== "" || request.url.includes("?")) return { bypass: "query" };
  for (const h of BYPASS_HEADERS) if (request.headers.has(h)) return { bypass: `header:${h}` };
  const variant = NATIVE_UA.test(request.headers.get("user-agent") ?? "") ? "native" : "web";
  const path = url.pathname;
  if (path === "/") return { route: { kind: "page", path, slug: PRIMARY_SLUG, variant } };
  // /api/conditions/<slug> (the public JSON) and /api/conditions/<slug>/lean (the packed copy
  // the dashboard polls, lib/clientConditions.ts). Each path is its own key, so the two shapes
  // never mix; both carry the x-ibd-edge header with the snapshot time.
  const api = /^\/api\/conditions\/([^/]+)(?:\/lean)?$/.exec(path);
  if (api) {
    const slug = api[1];
    // The JSON does not depend on the User-Agent: one variant.
    return isBeachSlug(slug) ? { route: { kind: "api", path, slug, variant: "web" } } : { bypass: "slug" };
  }
  const page = /^\/([^/]+)$/.exec(path);
  if (page && isBeachSlug(page[1])) return { route: { kind: "page", path, slug: page[1], variant } };
  return { bypass: "path" };
}

export function isBeachSlug(s: string): boolean {
  return s.length <= 64 && SLUG_RE.test(s) && !RESERVED_TOP_LEVEL.has(s);
}

/** The synthetic cache key. Never served to anyone; only used to find a stored copy. */
export function cacheKey(route: CacheableRoute, versionId: string, overrides: string): string {
  return (
    `${KEY_ORIGIN}/f${EDGE_CACHE_FORMAT}/${encodeURIComponent(versionId)}/${route.kind}` +
    `/${encodeURIComponent(route.path)}/${route.variant}/${encodeURIComponent(overrides)}`
  );
}

export interface Entry {
  status: number;
  /** Client-facing headers, as the route set them (minus Set-Cookie and Date). */
  headers: [string, string][];
  body: ArrayBuffer;
  storedAt: number;
  /** When the data inside was generated; null for a redirect. */
  dataAt: number | null;
}

export type Freshness = "fresh" | "stale" | "expired";

export function freshness(e: Pick<Entry, "storedAt" | "dataAt">, now: number): Freshness {
  const age = Math.max(0, now - e.storedAt);
  if (age > MAX_STALE_MS) return "expired";
  if (e.dataAt !== null && now - e.dataAt > DATA_MAX_AGE_MS) return "expired";
  if (age <= FRESH_MS && (e.dataAt === null || now - e.dataAt <= DATA_FRESH_MS)) return "fresh";
  return "stale";
}

/** Headers never copied into a stored copy. */
const DROP_HEADERS = new Set(["set-cookie", "date", "content-length", "transfer-encoding", "connection", "keep-alive", "age"]);

/**
 * Whether a route's response can be stored at all, judged on status and headers only (the
 * body check comes after it is read). Returns the reason it cannot, or null.
 */
export function unstorableReason(route: CacheableRoute, res: Response): string | null {
  if (res.headers.has("set-cookie")) return "set-cookie";
  if (res.headers.has("content-encoding")) return "content-encoding";
  if ((res as { webSocket?: unknown }).webSocket) return "websocket";
  const type = (res.headers.get("content-type") ?? "").toLowerCase();
  if (route.kind === "api") {
    if (res.status !== 200) return `status:${res.status}`;
    if (!type.startsWith("application/json")) return "content-type";
    return null;
  }
  if (res.status === 301 || res.status === 308) {
    const loc = res.headers.get("location") ?? "";
    return loc.startsWith("/") && !loc.startsWith("//") ? null : "redirect-target";
  }
  if (res.status !== 200) return `status:${res.status}`;
  if (!type.startsWith("text/html")) return "content-type";
  return null;
}

/**
 * The data time a stored copy will carry, or a reason not to store it: a page needs the
 * ibd-edge marker with ok=1, the JSON the x-ibd-edge header with ok=1. Redirects carry none.
 */
export function dataTimeOf(
  route: CacheableRoute,
  status: number,
  headers: Headers,
  body: ArrayBuffer,
): { dataAt: number | null } | { reject: string } {
  if (status === 301 || status === 308) return { dataAt: null };
  const marker =
    route.kind === "api"
      ? parseEdgeMarkerContent(headers.get(EDGE_DATA_HEADER))
      : findEdgeMarker(new TextDecoder().decode(body));
  if (!marker) return { reject: "no-marker" };
  if (!marker.ok) return { reject: "incomplete" };
  return { dataAt: marker.generatedAtMs };
}

export function entryHeaders(res: Response): [string, string][] {
  const out: [string, string][] = [];
  res.headers.forEach((v, k) => {
    if (!DROP_HEADERS.has(k.toLowerCase())) out.push([k, v]);
  });
  return out;
}

/** A client response from a stored copy. HEAD gets the headers and no body. */
export function serveEntry(e: Entry, method: string, state: "HIT" | "STALE", now: number): Response {
  const headers = new Headers(e.headers);
  headers.set("x-edge-cache", state);
  headers.set("x-edge-age", String(Math.max(0, Math.floor((now - e.storedAt) / 1000))));
  if (e.dataAt !== null) headers.set("x-edge-data-age", String(Math.max(0, Math.floor((now - e.dataAt) / 1000))));
  const body = method === "HEAD" || e.status === 204 || e.status === 304 ? null : e.body;
  return new Response(body, { status: e.status, headers });
}

// ---------- Workers Cache API (per datacenter) ----------

export interface CacheLike {
  match(key: string): Promise<Response | undefined>;
  put(key: string, res: Response): Promise<void>;
}

function defaultCache(): CacheLike | null {
  try {
    const d = (globalThis as { caches?: { default?: CacheLike } }).caches?.default;
    return d && typeof d.match === "function" && typeof d.put === "function" ? d : null;
  } catch {
    return null;
  }
}

const H_STORED = "x-edge-stored-at";
const H_DATA = "x-edge-data-at";
const H_ORIG_CC = "x-edge-orig-cache-control";
const H_STATUS = "x-edge-status";
const H_ORIG_VARY = "x-edge-orig-vary";

/** The copy as the Cache API keeps it. Its own Cache-Control only bounds how long the datacenter keeps it. */
export function toCacheResponse(e: Entry): Response {
  const headers = new Headers();
  for (const [k, v] of e.headers) {
    const l = k.toLowerCase();
    // The key already holds every input. Cache-Control and Vary are kept aside under other names:
    // the stored copy's own Cache-Control only bounds how long the datacenter keeps it, and a
    // Vary would only split it.
    if (l === "cache-control") headers.set(H_ORIG_CC, v);
    else if (l === "vary") headers.set(H_ORIG_VARY, v);
    else headers.append(k, v);
  }
  headers.set("cache-control", `max-age=${Math.ceil(MAX_STALE_MS / 1000)}`);
  headers.set(H_STORED, String(e.storedAt));
  headers.set(H_DATA, e.dataAt === null ? "" : String(e.dataAt));
  headers.set(H_STATUS, String(e.status));
  // Stored as a 200 whatever the real status (kept in x-edge-status): the Cache API does not
  // promise to keep a redirect as it is.
  return new Response(e.body, { status: 200, headers });
}

export async function fromCacheResponse(res: Response): Promise<Entry | null> {
  const storedAt = Number(res.headers.get(H_STORED));
  const status = Number(res.headers.get(H_STATUS));
  const dataRaw = res.headers.get(H_DATA);
  if (!Number.isFinite(storedAt) || storedAt <= 0 || !Number.isInteger(status) || status < 200) return null;
  const dataAt = dataRaw ? Number(dataRaw) : null;
  if (dataAt !== null && !Number.isFinite(dataAt)) return null;
  const headers: [string, string][] = [];
  res.headers.forEach((v, k) => {
    const l = k.toLowerCase();
    if (l === H_STORED || l === H_DATA || l === H_STATUS || l === "cache-control" || DROP_HEADERS.has(l) || l === "cf-cache-status") return;
    if (l === H_ORIG_CC) headers.push(["cache-control", v]);
    else if (l === H_ORIG_VARY) headers.push(["vary", v]);
    else headers.push([k, v]);
  });
  return { status, headers, body: await res.arrayBuffer(), storedAt, dataAt };
}

// ---------- owner-override fingerprint ----------

export interface D1Like {
  prepare(sql: string): { bind(...v: unknown[]): { first<T>(): Promise<T | null> } };
}

export interface Fingerprint {
  version: string;
  /** False when the lookup failed: the request then neither reads nor writes the edge cache. */
  reliable: boolean;
}

// ---------- the cache itself ----------

export interface EdgeEnv {
  DB?: D1Like;
  CF_VERSION_METADATA?: { id?: string };
}

export interface ExecCtx {
  waitUntil(p: Promise<unknown>): void;
}

export interface WorkerLike<Env, Ctx> {
  fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> | Response;
}

export interface EdgeCacheOptions {
  /** The Cache API; default caches.default (null where it does not exist). */
  cache?: CacheLike | null;
  now?: () => number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/** Read a body stream fully, with a byte cap; null when it is bigger. */
async function readCapped(stream: ReadableStream<Uint8Array> | null, cap: number): Promise<ArrayBuffer | null> {
  if (!stream) return new ArrayBuffer(0);
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out.buffer;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export function createEdgeCache(opts: EdgeCacheOptions = {}) {
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  const cache = (): CacheLike | null => (opts.cache !== undefined ? opts.cache : defaultCache());

  // In-isolate LRU: Map keeps insertion order; a hit re-inserts the key.
  const memory = new Map<string, Entry>();
  let memoryBytes = 0;
  const inflight = new Map<string, Promise<void>>();
  const lastTry = new Map<string, number>();
  const fpMemo = new Map<string, { version: string; at: number }>();
  const fpInflight = new Map<string, Promise<void>>();

  function memGet(key: string): Entry | undefined {
    const e = memory.get(key);
    if (e) {
      memory.delete(key);
      memory.set(key, e);
    }
    return e;
  }
  function memSet(key: string, e: Entry): void {
    const old = memory.get(key);
    if (old) {
      memoryBytes -= old.body.byteLength;
      memory.delete(key);
    }
    if (e.body.byteLength > MEMORY_BUDGET_BYTES) return;
    memory.set(key, e);
    memoryBytes += e.body.byteLength;
    while (memoryBytes > MEMORY_BUDGET_BYTES || memory.size > MEMORY_MAX_ENTRIES) {
      const oldest = memory.keys().next().value as string;
      memoryBytes -= memory.get(oldest)!.body.byteLength;
      memory.delete(oldest);
    }
  }

  const fpKey = (slug: string) => `${KEY_ORIGIN}/f${EDGE_CACHE_FORMAT}/fp/${encodeURIComponent(slug)}`;

  async function readFingerprint(db: D1Like, slug: string, at: number): Promise<string> {
    const r = await db.prepare(OVERRIDES_FINGERPRINT_SQL).bind(slug, new Date(at).toISOString()).first<{ n: number; maxId: number }>();
    return fingerprintFromRow(r);
  }

  async function loadFingerprint(db: D1Like, slug: string): Promise<string> {
    const at = now();
    const version = await withTimeout(readFingerprint(db, slug, at), FP_TIMEOUT_MS);
    fpMemo.set(slug, { version, at });
    const c = cache();
    if (c) {
      await c
        .put(
          fpKey(slug),
          new Response(JSON.stringify({ version, at }), {
            headers: { "content-type": "application/json", "cache-control": `max-age=${Math.ceil(FP_MAX_STALE_MS / 1000)}` },
          }),
        )
        .catch(() => {});
    }
    return version;
  }

  async function fingerprint(env: EdgeEnv, ctx: ExecCtx, slug: string): Promise<Fingerprint> {
    const db = env.DB;
    // No database bound (local tools, tests): no verdict can exist, the same rule as overrides.ts.
    if (!db || typeof db.prepare !== "function") return { version: "0", reliable: true };
    const t = now();
    let m = fpMemo.get(slug);
    if (!m || t - m.at > FP_FRESH_MS) {
      const c = cache();
      if (c) {
        try {
          const hit = await c.match(fpKey(slug));
          const j = hit ? ((await hit.json()) as { version?: unknown; at?: unknown }) : null;
          if (j && typeof j.version === "string" && typeof j.at === "number" && (!m || j.at > m.at)) {
            m = { version: j.version, at: j.at };
            fpMemo.set(slug, m);
          }
        } catch {
          // a miss
        }
      }
    }
    if (m && t - m.at <= FP_FRESH_MS) return { version: m.version, reliable: true };
    if (m && t - m.at <= FP_MAX_STALE_MS) {
      if (!fpInflight.has(slug)) {
        const p = loadFingerprint(db, slug)
          .then(() => {})
          .catch(() => {})
          .finally(() => fpInflight.delete(slug));
        fpInflight.set(slug, p);
        ctx.waitUntil(p);
      }
      return { version: m.version, reliable: true };
    }
    try {
      return { version: await loadFingerprint(db, slug), reliable: true };
    } catch (e) {
      log("edge-cache: fingerprint lookup failed", { slug, error: String(e) });
      return { version: "0", reliable: false };
    }
  }

  /** Read a response body fully, check it, and store it in both tiers. */
  async function store(
    key: string,
    route: CacheableRoute,
    res: { status: number; headers: Headers; clientHeaders: [string, string][] },
    body: ReadableStream<Uint8Array> | null,
  ): Promise<boolean> {
    const buf = await readCapped(body, MAX_BODY_BYTES);
    if (!buf) {
      log("edge-cache: not stored", { key, reason: "too-big" });
      return false;
    }
    const dt = dataTimeOf(route, res.status, res.headers, buf);
    if ("reject" in dt) {
      log("edge-cache: not stored", { key, reason: dt.reject });
      return false;
    }
    const entry: Entry = { status: res.status, headers: res.clientHeaders, body: buf, storedAt: now(), dataAt: dt.dataAt };
    memSet(key, entry);
    const c = cache();
    if (c) {
      try {
        await c.put(key, toCacheResponse(entry));
      } catch (e) {
        log("edge-cache: put failed", { key, error: String(e) });
      }
    }
    return true;
  }

  function refreshRequest(original: Request): Request {
    const headers = new Headers();
    const ua = original.headers.get("user-agent");
    if (ua) headers.set("user-agent", ua);
    headers.set("accept", original.headers.get("accept") ?? "*/*");
    return new Request(original.url, { method: "GET", headers });
  }

  function scheduleRefresh<Env extends EdgeEnv, Ctx extends ExecCtx>(
    inner: WorkerLike<Env, Ctx>,
    key: string,
    route: CacheableRoute,
    original: Request,
    env: Env,
    ctx: Ctx,
  ): boolean {
    const t = now();
    if (inflight.has(key)) return false;
    const last = lastTry.get(key);
    if (last !== undefined && t - last < MIN_REFRESH_GAP_MS) return false;
    lastTry.set(key, t);
    if (lastTry.size > 4 * MEMORY_MAX_ENTRIES) {
      for (const [k, v] of lastTry) if (t - v > MIN_REFRESH_GAP_MS) lastTry.delete(k);
    }
    const p = (async () => {
      const res = await inner.fetch(refreshRequest(original), env, ctx);
      const why = unstorableReason(route, res);
      if (why) {
        await res.body?.cancel().catch(() => {});
        log("edge-cache: refresh not stored", { key, reason: why });
        return;
      }
      await store(key, route, { status: res.status, headers: res.headers, clientHeaders: entryHeaders(res) }, res.body);
    })()
      .catch((e) => log("edge-cache: refresh failed", { key, error: String(e) }))
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    ctx.waitUntil(p);
    return true;
  }

  function tagged(res: Response, state: string, body: ReadableStream<Uint8Array> | null = res.body): Response {
    const headers = new Headers(res.headers);
    headers.set("x-edge-cache", state);
    return new Response(body, { status: res.status, statusText: res.statusText, headers });
  }

  type Lookup =
    | { pass: true; tag: string | null }
    | { pass: false; key: string; route: CacheableRoute; entry: Entry | undefined; state: Freshness | "none"; t: number };

  /** Everything before the route runs: classify, fingerprint, find a copy. Never calls the worker. */
  async function lookup(request: Request, env: EdgeEnv, ctx: ExecCtx): Promise<Lookup> {
    const c = classify(request);
    if ("bypass" in c) return { pass: true, tag: null };
    const route = c.route;
    const versionId = env?.CF_VERSION_METADATA?.id;
    if (!versionId) return { pass: true, tag: null }; // no build identity = never risk a mismatched page
    const fp = await fingerprint(env, ctx, route.slug);
    if (!fp.reliable) return { pass: true, tag: "BYPASS" };
    const key = cacheKey(route, versionId, fp.version);
    const t = now();
    let entry = memGet(key);
    let state: Freshness | "none" = entry ? freshness(entry, t) : "none";
    if (state !== "fresh") {
      const cc = cache();
      if (cc) {
        try {
          const hit = await cc.match(key);
          const fromColo = hit ? await fromCacheResponse(hit) : null;
          if (fromColo && (!entry || fromColo.storedAt > entry.storedAt)) {
            entry = fromColo;
            memSet(key, fromColo);
            state = freshness(fromColo, t);
          }
        } catch {
          // a miss
        }
      }
    }
    return { pass: false, key, route, entry, state, t };
  }

  async function handle<Env extends EdgeEnv, Ctx extends ExecCtx>(
    inner: WorkerLike<Env, Ctx>,
    request: Request,
    env: Env,
    ctx: Ctx,
  ): Promise<Response> {
    let l: Lookup;
    try {
      l = await lookup(request, env, ctx);
    } catch (e) {
      // A fault in this cache must never cost a page: answer as if it did not exist.
      log("edge-cache: lookup failed", { error: String(e) });
      return inner.fetch(request, env, ctx);
    }
    if (l.pass) {
      const res = await inner.fetch(request, env, ctx);
      return l.tag ? tagged(res, l.tag) : res;
    }
    const { key, route, entry, state, t } = l;
    if (entry && state === "fresh") return serveEntry(entry, request.method, "HIT", t);
    if (entry && state === "stale") {
      scheduleRefresh(inner, key, route, request, env, ctx);
      return serveEntry(entry, request.method, "STALE", t);
    }

    // Miss (or too old to serve): render inline, exactly as without this cache, and keep a copy.
    const res = await inner.fetch(request, env, ctx);
    try {
      if (request.method !== "GET" || unstorableReason(route, res)) return tagged(res, "MISS");
      const meta = { status: res.status, headers: new Headers(res.headers), clientHeaders: entryHeaders(res) };
      const [toClient, toStore] = res.body ? res.body.tee() : [null, null];
      ctx.waitUntil(
        store(key, route, meta, toStore).catch((e) => {
          log("edge-cache: store failed", { key, error: String(e) });
        }),
      );
      return tagged(res, "MISS", toClient);
    } catch (e) {
      log("edge-cache: keeping a copy failed", { key, error: String(e) });
      return res;
    }
  }

  return {
    handle,
    /** For tests. */
    _state: () => ({ memory, memoryBytes, inflight, fpMemo, lastTry }),
  };
}

const shared = createEdgeCache({
  log: (msg, extra) => {
    try {
      console.log(msg, extra ? JSON.stringify(extra) : "");
    } catch {
      // logging never breaks a request
    }
  },
});

/** Wrap a worker so the beach pages and the conditions JSON are served from the edge cache. */
export function withEdgeCache<Env extends EdgeEnv, Ctx extends ExecCtx, W extends WorkerLike<Env, Ctx>>(
  inner: W,
  edge: ReturnType<typeof createEdgeCache> = shared,
): W {
  return {
    ...inner,
    fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
      return edge.handle(inner, request, env, ctx);
    },
  };
}
