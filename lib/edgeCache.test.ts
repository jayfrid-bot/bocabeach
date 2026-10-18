import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  BYPASS_HEADERS,
  DATA_FRESH_MS,
  DATA_MAX_AGE_MS,
  FP_FRESH_MS,
  FP_MAX_STALE_MS,
  FRESH_MS,
  MAX_STALE_MS,
  MEMORY_BUDGET_BYTES,
  MIN_REFRESH_GAP_MS,
  PRIMARY_SLUG,
  RESERVED_TOP_LEVEL,
  cacheKey,
  classify,
  createEdgeCache,
  dataTimeOf,
  freshness,
  fromCacheResponse,
  toCacheResponse,
  unstorableReason,
  withEdgeCache,
  type CacheLike,
  type CacheableRoute,
  type D1Like,
  type Entry,
} from "@/lib/edgeCache";
import { EDGE_DATA_HEADER, EDGE_MARKER_NAME, edgeMarkerContent, findEdgeMarker, parseEdgeMarkerContent } from "@/lib/edgeMarker";
import { listLocations } from "@/config/locations";
import { isNativeUserAgent } from "@/lib/nativeRequest";
import { OVERRIDES_FINGERPRINT_SQL, fingerprintFromRow } from "@/lib/quality/overridesFingerprintSql";

const ROOT = join(__dirname, "..");
const T0 = Date.parse("2026-10-18T12:00:00.000Z");
const GEN = "2026-10-18T11:59:30.000Z";
const SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 Version/19.0 Mobile/15E148 Safari/604.1";
const APP_UA = `${SAFARI} IsItBeachDayApp/ios`;

const req = (path: string, init: RequestInit & { ua?: string } = {}) =>
  new Request(`https://app.isitbeachday.com${path}`, {
    ...init,
    headers: { "user-agent": init.ua ?? SAFARI, ...(init.headers as Record<string, string> | undefined) },
  });

const markerMeta = (content: string) => `<meta name="${EDGE_MARKER_NAME}" content="${content}"/>`;
const pageHtml = (gen = GEN, ok = 1, extra = "") =>
  `<!DOCTYPE html><html><head>${markerMeta(`v1;gen=${gen};ok=${ok}`)}</head><body>beach ${extra}</body></html>`;

// ---------- pure rules ----------

describe("classify: what may be cached", () => {
  it("the beach pages and the conditions JSON, by path", () => {
    expect(classify(req("/"))).toEqual({ route: { kind: "page", path: "/", slug: PRIMARY_SLUG, variant: "web" } });
    expect(classify(req("/jupiter"))).toEqual({ route: { kind: "page", path: "/jupiter", slug: "jupiter", variant: "web" } });
    expect(classify(req("/api/conditions/jupiter"))).toEqual({
      route: { kind: "api", path: "/api/conditions/jupiter", slug: "jupiter", variant: "web" },
    });
    expect("route" in classify(req("/jupiter", { method: "HEAD" }))).toBe(true);
  });

  it("the dashboard's packed copy, /api/conditions/<slug>/lean, under its own path", () => {
    expect(classify(req("/api/conditions/jupiter/lean"))).toEqual({
      route: { kind: "api", path: "/api/conditions/jupiter/lean", slug: "jupiter", variant: "web" },
    });
    expect(classify(req("/api/conditions/jupiter/lean", { ua: APP_UA }))).toMatchObject({ route: { variant: "web" } });
    expect(classify(req("/api/conditions/jupiter/lean", { method: "HEAD" }))).toMatchObject({ route: { kind: "api" } });
    // The same rules as the public JSON: any query (the dashboard's ?fresh=1 retry) goes through.
    for (const p of ["/api/conditions/jupiter/lean?fresh=1", "/api/conditions/jupiter/lean?x=1", "/api/conditions/jupiter/lean?"]) {
      expect(classify(req(p)), p).toEqual({ bypass: "query" });
    }
    for (const h of BYPASS_HEADERS) {
      expect(classify(req("/api/conditions/jupiter/lean", { headers: { [h]: "1" } })), h).toEqual({ bypass: `header:${h}` });
    }
    for (const p of ["/api/conditions/jupiter/lean/x", "/api/conditions/Bad_Slug/lean", "/api/conditions//lean", "/api/conditions/jupiter/leaner"]) {
      expect("bypass" in classify(req(p)), p).toBe(true);
    }
  });

  it("the native app shell is its own variant for pages, not for the JSON", () => {
    expect(classify(req("/jupiter", { ua: APP_UA }))).toMatchObject({ route: { variant: "native" } });
    expect(classify(req("/", { ua: "x IsItBeachDayApp/android" }))).toMatchObject({ route: { variant: "native" } });
    expect(classify(req("/api/conditions/jupiter", { ua: APP_UA }))).toMatchObject({ route: { variant: "web" } });
  });

  it("uses the same native test as lib/nativeRequest.ts", () => {
    for (const ua of [SAFARI, APP_UA, "isitbeachdayapp/ios", "", "IsItBeachDay", "Mozilla IsItBeachDayApp/android"]) {
      const v = classify(req("/jupiter", { ua }));
      expect("route" in v && v.route.variant === "native", ua).toBe(isNativeUserAgent(ua));
    }
  });

  it("bypasses every method but GET and HEAD", () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      expect(classify(req("/jupiter", { method })), method).toEqual({ bypass: "method" });
    }
  });

  it("bypasses any query string, including ?fresh=1, ?_rsc= and ?ref=", () => {
    for (const p of ["/?ref=sticker", "/jupiter?_rsc=abc", "/api/conditions/jupiter?fresh=1", "/api/conditions/jupiter?x", "/jupiter?", "/?utm_source=a"]) {
      expect(classify(req(p)), p).toEqual({ bypass: "query" });
    }
  });

  it("bypasses Next's client-router headers, Authorization and Range", () => {
    for (const h of BYPASS_HEADERS) {
      expect(classify(req("/jupiter", { headers: { [h]: "1" } })), h).toEqual({ bypass: `header:${h}` });
    }
    expect(BYPASS_HEADERS).toEqual(expect.arrayContaining(["rsc", "next-router-prefetch", "next-router-state-tree", "next-action", "authorization", "range"]));
  });

  it("ignores cookies: no beach page reads one (see the source check below)", () => {
    expect("route" in classify(req("/jupiter", { headers: { cookie: "ibd_ref=sticker; ph_x=1" } }))).toBe(true);
  });

  it("bypasses every other path", () => {
    for (const p of [
      "/admin", "/admin/review", "/find", "/privacy", "/support", "/get-app", "/sticker", "/mcp", "/llms.txt",
      "/robots.txt", "/sitemap.xml", "/manifest.webmanifest", "/opengraph-image", "/twitter-image", "/icon.png",
      "/sw.js", "/_next/static/chunks/a.js", "/api/v1/beaches", "/api/watch/jupiter", "/api/cam/x", "/api/history/jupiter",
      "/api/conditions/jupiter/extra", "/api/conditions/", "/api/conditions/Bad_Slug", "/jupiter/extra", "/Jupiter",
      "/api/version", "/api/push/run", "/api/quality/owner/list",
    ]) {
      expect("bypass" in classify(req(p)), p).toBe(true);
    }
  });
});

describe("reserved top-level names", () => {
  it("cover every route and file in app/ that is not a beach", () => {
    const special = new Set(["layout", "page", "error", "global-error", "not-found", "globals"]);
    for (const name of readdirSync(join(ROOT, "app"))) {
      if (name.startsWith("[")) continue; // the beach route itself
      const base = name.replace(/\.(tsx|ts|png|ico|css)$/, "");
      // A name with a dot left (llms.txt, robots.test) can never match a beach slug.
      if (special.has(base) || base.includes(".")) continue;
      expect(RESERVED_TOP_LEVEL.has(base), name).toBe(true);
    }
  });

  it("no served beach uses a reserved name", () => {
    for (const l of listLocations()) expect(RESERVED_TOP_LEVEL.has(l.slug), l.slug).toBe(false);
  });

  it("PRIMARY_SLUG is the beach / renders (the first curated one)", () => {
    const all = listLocations();
    expect(PRIMARY_SLUG).toBe((all.find((l) => l.tier !== "auto") ?? all[0]).slug);
  });
});

describe("cache key", () => {
  const route: CacheableRoute = { kind: "page", path: "/jupiter", slug: "jupiter", variant: "web" };
  it("holds the deploy, the path, the variant and the owner-override fingerprint", () => {
    const k = cacheKey(route, "ver-1", "0");
    expect(k).toContain("ver-1");
    expect(k).toContain(encodeURIComponent("/jupiter"));
    const others = [
      cacheKey(route, "ver-2", "0"),
      cacheKey(route, "ver-1", "2.17"),
      cacheKey({ ...route, variant: "native" }, "ver-1", "0"),
      cacheKey({ ...route, path: "/siesta-key", slug: "siesta-key" }, "ver-1", "0"),
      cacheKey({ ...route, kind: "api", path: "/api/conditions/jupiter" }, "ver-1", "0"),
      cacheKey({ ...route, kind: "api", path: "/api/conditions/jupiter/lean" }, "ver-1", "0"),
    ];
    expect(new Set([k, ...others]).size).toBe(7);
    expect(cacheKey({ kind: "page", path: "/", slug: PRIMARY_SLUG, variant: "web" }, "v", "0")).not.toBe(
      cacheKey({ kind: "page", path: `/${PRIMARY_SLUG}`, slug: PRIMARY_SLUG, variant: "web" }, "v", "0"),
    );
  });
  it("is a synthetic internal URL", () => {
    expect(new URL(cacheKey(route, "v", "0")).hostname).toBe("edge-cache.isitbeachday.internal");
  });
});

describe("freshness bounds", () => {
  const e = (ageMs: number, dataAgeMs: number | null = 30_000) => ({ storedAt: T0 - ageMs, dataAt: dataAgeMs === null ? null : T0 - dataAgeMs });
  it("fresh up to FRESH_MS, stale up to MAX_STALE_MS, then expired", () => {
    expect(freshness(e(0), T0)).toBe("fresh");
    expect(freshness(e(FRESH_MS), T0)).toBe("fresh");
    expect(freshness(e(FRESH_MS + 1), T0)).toBe("stale");
    expect(freshness(e(MAX_STALE_MS), T0)).toBe("stale");
    expect(freshness(e(MAX_STALE_MS + 1), T0)).toBe("expired");
  });
  it("a copy with old data is stale even when just stored", () => {
    expect(freshness(e(1_000, DATA_FRESH_MS), T0)).toBe("fresh");
    expect(freshness(e(1_000, DATA_FRESH_MS + 1), T0)).toBe("stale");
    expect(freshness(e(1_000, DATA_MAX_AGE_MS), T0)).toBe("stale");
    expect(freshness(e(1_000, DATA_MAX_AGE_MS + 1), T0)).toBe("expired");
  });
  it("a redirect has no data time", () => {
    expect(freshness(e(1_000, null), T0)).toBe("fresh");
  });
  it("the stale window is at most 10 minutes", () => {
    expect(MAX_STALE_MS).toBeLessThanOrEqual(10 * 60_000);
  });
});

describe("what may be stored", () => {
  const page: CacheableRoute = { kind: "page", path: "/jupiter", slug: "jupiter", variant: "web" };
  const api: CacheableRoute = { kind: "api", path: "/api/conditions/jupiter", slug: "jupiter", variant: "web" };
  const html = (init: ResponseInit = {}) => new Response("x", { status: 200, ...init, headers: { "content-type": "text/html; charset=utf-8", ...(init.headers as object) } });
  it("refuses Set-Cookie, an encoded body, other statuses and other types", () => {
    expect(unstorableReason(page, html())).toBeNull();
    expect(unstorableReason(page, html({ headers: { "set-cookie": "a=1" } }))).toBe("set-cookie");
    expect(unstorableReason(page, html({ headers: { "content-encoding": "gzip" } }))).toBe("content-encoding");
    expect(unstorableReason(page, html({ status: 404 }))).toBe("status:404");
    expect(unstorableReason(page, html({ status: 500 }))).toBe("status:500");
    expect(unstorableReason(page, new Response("{}", { headers: { "content-type": "application/json" } }))).toBe("content-type");
    expect(unstorableReason(api, new Response("{}", { headers: { "content-type": "application/json" } }))).toBeNull();
    expect(unstorableReason(api, html())).toBe("content-type");
  });
  it("keeps a permanent redirect to a path on this site, nothing else", () => {
    const r = (status: number, location: string) => new Response(null, { status, headers: { location } });
    expect(unstorableReason(page, r(308, "/"))).toBeNull();
    expect(unstorableReason(page, r(301, "/x"))).toBeNull();
    expect(unstorableReason(page, r(307, "/"))).toBe("status:307");
    expect(unstorableReason(page, r(302, "/"))).toBe("status:302");
    expect(unstorableReason(page, r(308, "https://evil.example/"))).toBe("redirect-target");
    expect(unstorableReason(page, r(308, "//evil.example/"))).toBe("redirect-target");
    expect(unstorableReason(api, r(308, "/"))).toBe("status:308");
  });
  it("needs the complete-build marker", () => {
    const enc = (s: string) => new TextEncoder().encode(s).buffer;
    expect(dataTimeOf(page, 200, new Headers(), enc(pageHtml()))).toEqual({ dataAt: Date.parse(GEN) });
    expect(dataTimeOf(page, 200, new Headers(), enc(pageHtml(GEN, 0)))).toEqual({ reject: "incomplete" });
    expect(dataTimeOf(page, 200, new Headers(), enc("<html>We couldn't load conditions</html>"))).toEqual({ reject: "no-marker" });
    expect(dataTimeOf(api, 200, new Headers({ [EDGE_DATA_HEADER]: `v1;gen=${GEN};ok=1` }), enc("{}"))).toEqual({ dataAt: Date.parse(GEN) });
    expect(dataTimeOf(api, 200, new Headers({ [EDGE_DATA_HEADER]: `v1;gen=${GEN};ok=0` }), enc("{}"))).toEqual({ reject: "incomplete" });
    expect(dataTimeOf(api, 200, new Headers(), enc("{}"))).toEqual({ reject: "no-marker" });
    expect(dataTimeOf(page, 308, new Headers(), enc(""))).toEqual({ dataAt: null });
  });
});

describe("the marker", () => {
  const data = (over: Record<string, unknown> = {}) => ({ snapshot: { generatedAt: GEN }, score: { dataAvailable: true }, ...over });
  it("says ok=1 only for a complete build with data", () => {
    expect(edgeMarkerContent(data())).toBe(`v1;gen=${GEN};ok=1`);
    expect(edgeMarkerContent(data({ budgetAborted: true }))).toBe(`v1;gen=${GEN};ok=0`);
    expect(edgeMarkerContent(data({ score: { dataAvailable: false } }))).toBe(`v1;gen=${GEN};ok=0`);
    expect(edgeMarkerContent({ snapshot: { generatedAt: "garbage" } })).toBe("v1;gen=none;ok=0");
    expect(parseEdgeMarkerContent("v1;gen=none;ok=0")).toBeNull();
  });
  it("parses only the exact v1 shape", () => {
    expect(parseEdgeMarkerContent(`v1;gen=${GEN};ok=1`)).toEqual({ generatedAtMs: Date.parse(GEN), ok: true });
    for (const bad of ["", "v2;gen=x;ok=1", `v1;gen=${GEN};ok=2`, `v1;gen=${GEN}`, `v1;gen=${GEN};ok=1;x`, `v1;gen=2026-10-18;ok=1`]) {
      expect(parseEdgeMarkerContent(bad), bad).toBeNull();
    }
  });
  it("is found in what React actually renders for the <meta>", () => {
    const html = renderToStaticMarkup(createElement("meta", { name: EDGE_MARKER_NAME, content: edgeMarkerContent(data()) }));
    expect(findEdgeMarker(`<html><head>${html}</head></html>`)).toEqual({ generatedAtMs: Date.parse(GEN), ok: true });
    expect(findEdgeMarker('<meta name="description" content="v1;gen=2026-10-18T11:59:30.000Z;ok=1"/>')).toBeNull();
  });
});

describe("beach page sources", () => {
  const files = ["app/page.tsx", "app/[slug]/page.tsx", "app/layout.tsx", "lib/nativeRequest.ts"];
  it("read no cookies, no query, no draft mode (so cookies and the key need not vary)", () => {
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), "utf8");
      expect(src, f).not.toMatch(/\bcookies\s*\(|searchParams|draftMode|connection\s*\(/);
    }
  });
  it("both beach pages render the marker; the JSON route sends the header", () => {
    for (const f of ["app/page.tsx", "app/[slug]/page.tsx"]) {
      expect(readFileSync(join(ROOT, f), "utf8"), f).toMatch(/<meta name=\{EDGE_MARKER_NAME\} content=\{edgeMarkerContent\(data\)\}/);
    }
    for (const f of ["app/api/conditions/[slug]/route.ts", "app/api/conditions/[slug]/lean/route.ts"]) {
      expect(readFileSync(join(ROOT, f), "utf8"), f).toMatch(/\[EDGE_DATA_HEADER\]: edgeMarkerContent\(data\)/);
    }
  });
  it("the owner-override fingerprint is one query for both bundles", () => {
    const src = readFileSync(join(ROOT, "lib/quality/overrides.ts"), "utf8");
    expect(src).toContain(".prepare(OVERRIDES_FINGERPRINT_SQL)");
    expect(src).toContain("fingerprintFromRow(r)");
    expect(fingerprintFromRow(null)).toBe("0");
    expect(fingerprintFromRow({ n: 0, maxId: 0 })).toBe("0");
    expect(fingerprintFromRow({ n: 2, maxId: 17 })).toBe("2.17");
  });
});

describe("stored copy round trip", () => {
  it("keeps status, the route's own Cache-Control and Vary, the body and both times", async () => {
    const e: Entry = {
      status: 308,
      headers: [["location", "/"], ["cache-control", "private, no-store"], ["vary", "rsc"], ["content-type", "text/html"]],
      body: new TextEncoder().encode("moved").buffer,
      storedAt: T0,
      dataAt: null,
    };
    const stored = toCacheResponse(e);
    expect(stored.status).toBe(200);
    expect(stored.headers.get("cache-control")).toBe(`max-age=${MAX_STALE_MS / 1000}`);
    expect(stored.headers.get("vary")).toBeNull();
    const back = await fromCacheResponse(stored);
    expect(back).not.toBeNull();
    expect(back!.status).toBe(308);
    expect(back!.storedAt).toBe(T0);
    expect(back!.dataAt).toBeNull();
    expect(new Headers(back!.headers).get("cache-control")).toBe("private, no-store");
    expect(new Headers(back!.headers).get("vary")).toBe("rsc");
    expect(new Headers(back!.headers).get("location")).toBe("/");
    expect(new TextDecoder().decode(back!.body)).toBe("moved");
  });
  it("rejects a response that is not a stored copy", async () => {
    expect(await fromCacheResponse(new Response("x"))).toBeNull();
  });
});

// ---------- the wrapper, end to end with fakes ----------

class FakeCache implements CacheLike {
  store = new Map<string, Response>();
  puts = 0;
  async match(key: string) {
    const r = this.store.get(key);
    return r ? r.clone() : undefined;
  }
  async put(key: string, res: Response) {
    this.puts += 1;
    this.store.set(key, res.clone());
  }
}

function fakeDb(state: { n: number; maxId: number; fail?: boolean }) {
  const calls: unknown[][] = [];
  const db: D1Like = {
    prepare(sql: string) {
      expect(sql).toBe(OVERRIDES_FINGERPRINT_SQL);
      return {
        bind: (...v: unknown[]) => ({
          first: async <T,>() => {
            calls.push(v);
            if (state.fail) throw new Error("d1 down");
            return { n: state.n, maxId: state.maxId } as T;
          },
        }),
      };
    },
  };
  return { db, calls };
}

interface Harness {
  call: (r: Request) => Promise<Response>;
  settle: () => Promise<void>;
  inner: ReturnType<typeof vi.fn>;
  cache: FakeCache;
  clock: { t: number };
  env: { DB?: D1Like; CF_VERSION_METADATA?: { id?: string } };
  edge: ReturnType<typeof createEdgeCache>;
}

function harness(
  respond: (r: Request, n: number) => Response | Promise<Response> = () => new Response(pageHtml(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-cache, no-store, max-age=0, must-revalidate", vary: "rsc, next-router-state-tree" } }),
  over: Partial<Pick<Harness, "cache" | "clock" | "env">> = {},
): Harness {
  const cache = "cache" in over ? (over.cache as FakeCache) : new FakeCache();
  const clock = over.clock ?? { t: T0 };
  const env = over.env ?? { CF_VERSION_METADATA: { id: "ver-1" } };
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
  let n = 0;
  const inner = vi.fn(async (r: Request, _env?: unknown, _ctx?: unknown) => respond(r, ++n));
  const edge = createEdgeCache({ cache, now: () => clock.t });
  const wrapped = withEdgeCache({ fetch: inner }, edge);
  return {
    call: (r) => wrapped.fetch(r, env, ctx),
    settle: async () => {
      while (pending.length) await Promise.all(pending.splice(0));
    },
    inner,
    cache,
    clock,
    env,
    edge,
  };
}

describe("withEdgeCache", () => {
  it("first request renders and stores; the next is a hit with the same body and headers", async () => {
    const h = harness();
    const a = await h.call(req("/jupiter"));
    expect(a.headers.get("x-edge-cache")).toBe("MISS");
    const aBody = await a.text();
    await h.settle();
    h.clock.t += 5_000;
    const b = await h.call(req("/jupiter"));
    expect(b.headers.get("x-edge-cache")).toBe("HIT");
    expect(b.headers.get("x-edge-age")).toBe("5");
    expect(b.headers.get("x-edge-data-age")).toBe("35");
    expect(await b.text()).toBe(aBody);
    expect(b.headers.get("cache-control")).toBe("private, no-cache, no-store, max-age=0, must-revalidate");
    expect(b.headers.get("vary")).toBe("rsc, next-router-state-tree");
    expect(h.inner).toHaveBeenCalledTimes(1);
    expect(h.cache.puts).toBe(1);
  });

  it("serves a stale copy once and refreshes in the background, one refresh at a time", async () => {
    const h = harness((_r, n) => new Response(pageHtml(GEN, 1, `v${n}`), { headers: { "content-type": "text/html" } }));
    await (await h.call(req("/jupiter"))).text();
    await h.settle();
    h.clock.t += FRESH_MS + 1;
    const s1 = await h.call(req("/jupiter"));
    const s2 = await h.call(req("/jupiter"));
    expect(s1.headers.get("x-edge-cache")).toBe("STALE");
    expect(s2.headers.get("x-edge-cache")).toBe("STALE");
    expect(await s1.text()).toContain("v1");
    expect(h.inner).toHaveBeenCalledTimes(2); // the first render + ONE refresh
    await h.settle();
    const fresh = await h.call(req("/jupiter"));
    expect(fresh.headers.get("x-edge-cache")).toBe("HIT");
    expect(await fresh.text()).toContain("v2");
  });

  it("does not retry a failed refresh before MIN_REFRESH_GAP_MS", async () => {
    let fail = false;
    const h = harness(() => (fail ? new Response("boom", { status: 500 }) : new Response(pageHtml(), { headers: { "content-type": "text/html" } })));
    await (await h.call(req("/jupiter"))).text();
    await h.settle();
    fail = true;
    h.clock.t += FRESH_MS + 1;
    await h.call(req("/jupiter"));
    await h.settle();
    h.clock.t += MIN_REFRESH_GAP_MS - 1;
    const again = await h.call(req("/jupiter"));
    expect(again.headers.get("x-edge-cache")).toBe("STALE");
    expect(h.inner).toHaveBeenCalledTimes(2);
    h.clock.t += 2;
    await h.call(req("/jupiter"));
    expect(h.inner).toHaveBeenCalledTimes(3);
  });

  it("never serves a copy older than MAX_STALE_MS: renders inline instead", async () => {
    const h = harness();
    await (await h.call(req("/jupiter"))).text();
    await h.settle();
    h.clock.t += MAX_STALE_MS + 1;
    const r = await h.call(req("/jupiter"));
    expect(r.headers.get("x-edge-cache")).toBe("MISS");
    expect(h.inner).toHaveBeenCalledTimes(2);
  });

  it("refreshes a just-stored copy whose data is old", async () => {
    const oldGen = new Date(T0 - DATA_FRESH_MS - 60_000).toISOString();
    const h = harness(() => new Response(pageHtml(oldGen), { headers: { "content-type": "text/html" } }));
    await (await h.call(req("/jupiter"))).text();
    await h.settle();
    h.clock.t += 1_000;
    expect((await h.call(req("/jupiter"))).headers.get("x-edge-cache")).toBe("STALE");
  });

  it("never stores an incomplete build, a page without the marker, a Set-Cookie or an error", async () => {
    for (const make of [
      () => new Response(pageHtml(GEN, 0), { headers: { "content-type": "text/html" } }),
      () => new Response("<html>We couldn't load conditions</html>", { headers: { "content-type": "text/html" } }),
      () => new Response(pageHtml(), { headers: { "content-type": "text/html", "set-cookie": "a=1" } }),
      () => new Response(pageHtml(), { status: 500, headers: { "content-type": "text/html" } }),
      () => new Response("not found", { status: 404, headers: { "content-type": "text/html" } }),
    ]) {
      const h = harness(make);
      await (await h.call(req("/jupiter"))).text();
      await h.settle();
      const r2 = await h.call(req("/jupiter"));
      expect(r2.headers.get("x-edge-cache")).toBe("MISS");
      expect(h.inner).toHaveBeenCalledTimes(2);
      expect(h.cache.puts).toBe(0);
    }
  });

  it("keeps web and native app pages apart", async () => {
    const h = harness((r) => new Response(pageHtml(GEN, 1, isNativeUserAgent(r.headers.get("user-agent")) ? "native" : "web"), { headers: { "content-type": "text/html" } }));
    await (await h.call(req("/jupiter"))).text();
    await h.settle();
    const app = await h.call(req("/jupiter", { ua: APP_UA }));
    expect(app.headers.get("x-edge-cache")).toBe("MISS");
    expect(await app.text()).toContain("native");
    await h.settle();
    expect(await (await h.call(req("/jupiter"))).text()).toContain("web");
    expect(await (await h.call(req("/jupiter", { ua: APP_UA }))).text()).toContain("native");
    expect(h.inner).toHaveBeenCalledTimes(2);
  });

  it("an owner correction changes the key within FP_FRESH_MS (plus one request)", async () => {
    const ov = { n: 0, maxId: 0 };
    const { db, calls } = fakeDb(ov);
    const h = harness(undefined, { env: { DB: db, CF_VERSION_METADATA: { id: "ver-1" } } });
    await (await h.call(req("/jupiter"))).text();
    await h.settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["jupiter", new Date(T0).toISOString()]);
    ov.n = 1;
    ov.maxId = 42; // the owner answers
    h.clock.t += 1_000;
    expect((await h.call(req("/jupiter"))).headers.get("x-edge-cache")).toBe("HIT"); // memo still fresh: no D1 read
    expect(calls).toHaveLength(1);
    h.clock.t += FP_FRESH_MS;
    // Past FP_FRESH_MS: still served under the old fingerprint, the re-read runs in the background...
    expect((await h.call(req("/jupiter"))).headers.get("x-edge-cache")).toBe("HIT");
    await h.settle();
    expect(calls).toHaveLength(2);
    // ...and the next request uses the new fingerprint, so the pre-correction page is not found.
    const after = await h.call(req("/jupiter"));
    expect(after.headers.get("x-edge-cache")).toBe("MISS");
    expect(h.inner).toHaveBeenCalledTimes(2);
  });

  it("past FP_MAX_STALE_MS a request waits for the fingerprint", async () => {
    const ov = { n: 0, maxId: 0 };
    const { db, calls } = fakeDb(ov);
    const h = harness(undefined, { env: { DB: db, CF_VERSION_METADATA: { id: "ver-1" } } });
    await (await h.call(req("/jupiter"))).text();
    await h.settle();
    ov.n = 1;
    ov.maxId = 7;
    h.clock.t += FP_MAX_STALE_MS + 1;
    expect((await h.call(req("/jupiter"))).headers.get("x-edge-cache")).toBe("MISS");
    expect(calls).toHaveLength(2);
  });

  it("a failed fingerprint lookup neither reads nor writes the cache", async () => {
    const { db } = fakeDb({ n: 0, maxId: 0, fail: true });
    const h = harness(undefined, { env: { DB: db, CF_VERSION_METADATA: { id: "ver-1" } } });
    const a = await h.call(req("/jupiter"));
    expect(a.headers.get("x-edge-cache")).toBe("BYPASS");
    await a.text();
    await h.settle();
    expect(h.cache.puts).toBe(0);
    expect((await h.call(req("/jupiter"))).headers.get("x-edge-cache")).toBe("BYPASS");
    expect(h.inner).toHaveBeenCalledTimes(2);
  });

  it("a fault inside the cache falls back to a plain render", async () => {
    const env = {} as { CF_VERSION_METADATA?: { id?: string } };
    Object.defineProperty(env, "CF_VERSION_METADATA", { get: () => { throw new Error("boom"); } });
    const h = harness(undefined, { env });
    const r = await h.call(req("/jupiter"));
    expect(r.status).toBe(200);
    expect(r.headers.get("x-edge-cache")).toBeNull();
    expect(h.inner).toHaveBeenCalledTimes(1);
    const broken: CacheLike = { match: async () => { throw new Error("cache down"); }, put: async () => { throw new Error("cache down"); } };
    const h2 = harness(undefined, { cache: broken as FakeCache });
    expect((await h2.call(req("/jupiter"))).status).toBe(200);
    await h2.settle();
    // The in-isolate copy still works when the Cache API fails.
    expect((await h2.call(req("/jupiter"))).headers.get("x-edge-cache")).toBe("HIT");
  });

  it("a new deploy never sees the old deploy's copies", async () => {
    const cache = new FakeCache();
    const h1 = harness(undefined, { cache, env: { CF_VERSION_METADATA: { id: "ver-1" } } });
    await (await h1.call(req("/jupiter"))).text();
    await h1.settle();
    const h2 = harness(undefined, { cache, env: { CF_VERSION_METADATA: { id: "ver-2" } } });
    expect((await h2.call(req("/jupiter"))).headers.get("x-edge-cache")).toBe("MISS");
  });

  it("without a version id nothing is cached and the response is untouched", async () => {
    const h = harness(undefined, { env: {} });
    const a = await h.call(req("/jupiter"));
    expect(a.headers.get("x-edge-cache")).toBeNull();
    await h.call(req("/jupiter"));
    expect(h.inner).toHaveBeenCalledTimes(2);
    expect(h.cache.puts).toBe(0);
  });

  it("a bypassed request reaches the worker as the same Request object", async () => {
    const h = harness();
    const r = req("/api/conditions/jupiter?fresh=1");
    const res = await h.call(r);
    expect(h.inner.mock.calls[0][0]).toBe(r);
    expect(res.headers.get("x-edge-cache")).toBeNull();
  });

  it("another isolate in the same datacenter finds the copy in the Cache API", async () => {
    const cache = new FakeCache();
    const h1 = harness(undefined, { cache });
    await (await h1.call(req("/jupiter"))).text();
    await h1.settle();
    const h2 = harness(undefined, { cache });
    const r = await h2.call(req("/jupiter"));
    expect(r.headers.get("x-edge-cache")).toBe("HIT");
    expect(await r.text()).toContain("beach");
    expect(h2.inner).not.toHaveBeenCalled();
  });

  it("HEAD is answered from a copy with no body, and a HEAD miss stores nothing", async () => {
    const h = harness();
    const head = await h.call(req("/jupiter", { method: "HEAD" }));
    expect(head.headers.get("x-edge-cache")).toBe("MISS");
    await h.settle();
    expect(h.cache.puts).toBe(0);
    await (await h.call(req("/jupiter"))).text();
    await h.settle();
    const head2 = await h.call(req("/jupiter", { method: "HEAD" }));
    expect(head2.headers.get("x-edge-cache")).toBe("HIT");
    expect(await head2.text()).toBe("");
  });

  it("the refresh request carries only the User-Agent and Accept, never cookies", async () => {
    const h = harness();
    const ua = APP_UA;
    await (await h.call(req("/jupiter", { ua, headers: { cookie: "a=1" } }))).text();
    await h.settle();
    h.clock.t += FRESH_MS + 1;
    await h.call(req("/jupiter", { ua, headers: { cookie: "a=1", accept: "text/html" } }));
    await h.settle();
    const refresh = h.inner.mock.calls[1][0] as Request;
    expect(refresh.method).toBe("GET");
    expect(refresh.url).toBe("https://app.isitbeachday.com/jupiter");
    expect(refresh.headers.get("cookie")).toBeNull();
    expect(refresh.headers.get("user-agent")).toBe(ua);
    expect(refresh.headers.get("accept")).toBe("text/html");
  });

  it("stores the flagship's 308 to /", async () => {
    const h = harness(() => new Response(null, { status: 308, headers: { location: "/", "content-type": "text/html" } }));
    await h.call(req(`/${PRIMARY_SLUG}`));
    await h.settle();
    const r = await h.call(req(`/${PRIMARY_SLUG}`));
    expect(r.status).toBe(308);
    expect(r.headers.get("location")).toBe("/");
    expect(r.headers.get("x-edge-cache")).toBe("HIT");
  });

  it("caches the conditions JSON only with a complete-build header", async () => {
    let ok = 1;
    const h = harness(() =>
      new Response('{"snapshot":{}}', { headers: { "content-type": "application/json", [EDGE_DATA_HEADER]: `v1;gen=${GEN};ok=${ok}`, "cache-control": "public, s-maxage=300, stale-while-revalidate=600" } }),
    );
    ok = 0;
    await (await h.call(req("/api/conditions/jupiter"))).text();
    await h.settle();
    expect(h.cache.puts).toBe(0);
    ok = 1;
    await (await h.call(req("/api/conditions/jupiter"))).text();
    await h.settle();
    const hit = await h.call(req("/api/conditions/jupiter"));
    expect(hit.headers.get("x-edge-cache")).toBe("HIT");
    expect(hit.headers.get("cache-control")).toBe("public, s-maxage=300, stale-while-revalidate=600");
    expect(await hit.text()).toBe('{"snapshot":{}}');
  });

  it("caches the lean JSON under its own key and reads its data time from x-ibd-edge", async () => {
    let gen = GEN;
    const h = harness((r) =>
      new Response(r.url.endsWith("/lean") ? `{"wire":1,"snapshot":{"generatedAt":"${gen}"}}` : '{"snapshot":{}}', {
        headers: { "content-type": "application/json", [EDGE_DATA_HEADER]: `v1;gen=${gen};ok=1`, "cache-control": "public, s-maxage=300, stale-while-revalidate=600" },
      }),
    );
    await (await h.call(req("/api/conditions/jupiter/lean"))).text();
    await h.settle();
    const hit = await h.call(req("/api/conditions/jupiter/lean"));
    expect(hit.headers.get("x-edge-cache")).toBe("HIT");
    expect(hit.headers.get("x-edge-data-age")).toBe("30");
    expect(await hit.text()).toContain('"wire":1');
    // The public JSON is a different key: a miss, never the packed body.
    const pub = await h.call(req("/api/conditions/jupiter"));
    expect(pub.headers.get("x-edge-cache")).toBe("MISS");
    expect(await pub.text()).toBe('{"snapshot":{}}');
    await h.settle();
    // ?fresh=1 always reaches the route, untagged.
    const before = h.inner.mock.calls.length;
    const fresh = await h.call(req("/api/conditions/jupiter/lean?fresh=1"));
    expect(fresh.headers.get("x-edge-cache")).toBeNull();
    expect(h.inner.mock.calls.length).toBe(before + 1);

    // A lean copy whose snapshot is old (by its x-ibd-edge time, not when it was stored) is stale.
    gen = new Date(T0 - DATA_FRESH_MS - 60_000).toISOString();
    const h2 = harness(() =>
      new Response(`{"wire":1,"snapshot":{"generatedAt":"${gen}"}}`, { headers: { "content-type": "application/json", [EDGE_DATA_HEADER]: `v1;gen=${gen};ok=1` } }),
    );
    await (await h2.call(req("/api/conditions/jupiter/lean"))).text();
    await h2.settle();
    const stale = await h2.call(req("/api/conditions/jupiter/lean"));
    expect(stale.headers.get("x-edge-cache")).toBe("STALE");
    expect(Number(stale.headers.get("x-edge-data-age"))).toBe((DATA_FRESH_MS + 60_000) / 1000);
    await h2.settle();

    // ...one past DATA_MAX_AGE_MS is never served: the request renders inline.
    gen = new Date(T0 - DATA_MAX_AGE_MS - 1000).toISOString();
    const h3 = harness(() =>
      new Response(`{"wire":1,"snapshot":{}}`, { headers: { "content-type": "application/json", [EDGE_DATA_HEADER]: `v1;gen=${gen};ok=1` } }),
    );
    await (await h3.call(req("/api/conditions/jupiter/lean"))).text();
    await h3.settle();
    expect((await h3.call(req("/api/conditions/jupiter/lean"))).headers.get("x-edge-cache")).toBe("MISS");

    // ...and a lean answer without the header is never stored.
    const h4 = harness(() => new Response(`{"wire":1,"snapshot":{}}`, { headers: { "content-type": "application/json" } }));
    await (await h4.call(req("/api/conditions/jupiter/lean"))).text();
    await h4.settle();
    expect(h4.cache.puts).toBe(0);
    expect((await h4.call(req("/api/conditions/jupiter/lean"))).headers.get("x-edge-cache")).toBe("MISS");
  });

  it("the miss response still streams the body the route produced", async () => {
    const h = harness(() => {
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(pageHtml().slice(0, 40)));
          c.enqueue(enc.encode(pageHtml().slice(40)));
          c.close();
        },
      });
      return new Response(body, { headers: { "content-type": "text/html" } });
    });
    const r = await h.call(req("/jupiter"));
    expect(await r.text()).toBe(pageHtml());
    await h.settle();
    expect(h.cache.puts).toBe(1);
  });

  it("the in-isolate tier stays inside its memory budget", async () => {
    const big = "x".repeat(600_000);
    const h = harness((r) => new Response(pageHtml(GEN, 1, big + r.url), { headers: { "content-type": "text/html" } }), { cache: null as unknown as FakeCache });
    for (let i = 0; i < 40; i++) {
      await (await h.call(req(`/beach-${i}`))).text();
      await h.settle();
    }
    const s = h.edge._state();
    expect(s.memoryBytes).toBeLessThanOrEqual(MEMORY_BUDGET_BYTES);
    expect(s.memory.size).toBeLessThan(40);
  });
});
