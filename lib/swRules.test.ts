// Tests for public/sw.js: the pure rules first, then the worker itself run against a fake
// Cache API and fake network (no browser). The browser run is e2e/service-worker.spec.ts.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(path.join(process.cwd(), "public", "sw.js"), "utf8");
const ORIGIN = "https://app.test";

// --- fake Cache API ---------------------------------------------------------
class FakeCache {
  store = new Map<string, Response>();
  private k(key: unknown): string {
    return typeof key === "string" ? key : (key as { url: string }).url;
  }
  async match(key: unknown) {
    const r = this.store.get(this.k(key));
    return r ? r.clone() : undefined;
  }
  async put(key: unknown, res: Response) {
    this.store.set(this.k(key), res.clone());
  }
  async keys() {
    return [...this.store.keys()].map((url) => ({ url }));
  }
  async delete(key: unknown) {
    return this.store.delete(this.k(key));
  }
}
class FakeCaches {
  map = new Map<string, FakeCache>();
  async open(n: string) {
    if (!this.map.has(n)) this.map.set(n, new FakeCache());
    return this.map.get(n)!;
  }
  async keys() {
    return [...this.map.keys()];
  }
  async delete(n: string) {
    return this.map.delete(n);
  }
}

interface Posted {
  type: string;
  [k: string]: unknown;
}

function makeWorker(version = "v1") {
  const handlers: Record<string, (e: unknown) => void> = {};
  const caches = new FakeCaches();
  const posted: Posted[] = [];
  const net = {
    calls: [] as string[],
    routes: new Map<string, () => Response | Promise<Response>>(),
    delayMs: 0,
    down: false,
  };
  const fetchFake = async (input: unknown) => {
    const url = typeof input === "string" ? input : (input as { url: string }).url;
    const abs = url.startsWith("http") ? url : ORIGIN + url;
    net.calls.push(abs);
    if (net.down) throw new TypeError("network down");
    if (net.delayMs) await new Promise((r) => setTimeout(r, net.delayMs));
    const route = net.routes.get(abs);
    if (!route) return new Response("nope", { status: 404 });
    return route();
  };
  const self = {
    location: { href: `${ORIGIN}/sw.js?v=${version}`, origin: ORIGIN },
    navigator: {},
    addEventListener: (n: string, h: (e: unknown) => void) => {
      handlers[n] = h;
    },
    skipWaiting: () => {},
    registration: { unregister: async () => (unregistered.value = true) },
    clients: {
      claim: async () => {},
      matchAll: async () => [
        { url: `${ORIGIN}/`, postMessage: (m: Posted) => posted.push(m) },
        { url: `${ORIGIN}/jupiter`, postMessage: (m: Posted) => posted.push({ ...m, toJupiter: true }) },
      ],
    },
    IBD_SW: undefined as unknown,
  };
  const unregistered = { value: false };
  new Function("self", "caches", "fetch", "Response", "Request", "Headers", "URL", "setTimeout", SRC)(
    self,
    caches,
    fetchFake,
    Response,
    Request,
    Headers,
    URL,
    setTimeout,
  );
  const rules = self.IBD_SW as Rules;

  /** Fire a fetch event; returns the response (or null when the worker stayed out of it). */
  async function dispatch(req: {
    url: string;
    mode?: string;
    method?: string;
    cache?: string;
    headers?: Record<string, string>;
    clientId?: string;
  }) {
    const request = {
      url: req.url.startsWith("http") ? req.url : ORIGIN + req.url,
      method: req.method ?? "GET",
      mode: req.mode ?? "cors",
      cache: req.cache ?? "default",
      headers: new Headers(req.headers ?? {}),
    };
    let responded: Promise<Response> | null = null;
    const waits: Promise<unknown>[] = [];
    handlers.fetch({
      request,
      clientId: req.clientId ?? "c1",
      resultingClientId: "",
      respondWith: (p: Promise<Response>) => {
        responded = p;
      },
      waitUntil: (p: Promise<unknown>) => {
        waits.push(p);
      },
    });
    const response = responded ? await (responded as Promise<Response>) : null;
    await Promise.all(waits.map((w) => w.catch(() => {})));
    return response;
  }
  async function lifecycle(name: "activate") {
    const waits: Promise<unknown>[] = [];
    handlers[name]({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  }
  return { rules, caches, posted, net, dispatch, lifecycle, unregistered, handlers };
}

type Rules = {
  LIMITS: Record<string, number>;
  RESERVED_SEGMENTS: string[];
  classify: (r: Record<string, unknown>) => { kind: string; key: string; slug?: string; path?: string } | null;
  cacheableResponse: (k: string, s: Record<string, unknown>) => boolean;
  looksCompleteHtml: (t: string) => boolean;
  looksLikeConditions: (t: string) => boolean;
  assetSignature: (h: string) => string;
  servePlan: (k: string, at: number | null, o: Record<string, unknown>) => { action: string; revalidate: boolean };
  bypassesCache: (m: string) => boolean;
  quotaAllows: (e: unknown) => boolean;
};

const req = (url: string, extra: Record<string, unknown> = {}) => ({
  method: "GET",
  url: url.startsWith("http") ? url : ORIGIN + url,
  origin: ORIGIN,
  mode: "cors",
  hasAuth: false,
  hasRange: false,
  ...extra,
});

describe("sw.js routing rules", () => {
  const { rules } = makeWorker();

  it("handles hashed build files, beach pages and conditions data", () => {
    expect(rules.classify(req("/_next/static/chunks/main-abc.js"))?.kind).toBe("static");
    expect(rules.classify(req("/_next/static/css/68bf.css"))?.kind).toBe("static");
    expect(rules.classify(req("/", { mode: "navigate" }))?.kind).toBe("page");
    expect(rules.classify(req("/siesta-key", { mode: "navigate" }))?.kind).toBe("page");
    const c = rules.classify(req("/api/conditions/boca-raton/lean"));
    expect(c).toMatchObject({ kind: "conditions", slug: "boca-raton" });
  });

  it("every beach in config/beach-slugs.json is a cacheable page", () => {
    const slugs = JSON.parse(readFileSync(path.join(process.cwd(), "config", "beach-slugs.json"), "utf8")) as string[];
    expect(slugs.length).toBeGreaterThan(30);
    for (const s of slugs) {
      expect(rules.classify(req(`/${s}`, { mode: "navigate" }))?.kind, s).toBe("page");
      expect(rules.classify(req(`/api/conditions/${s}/lean`))?.kind, s).toBe("conditions");
    }
  });

  it("never touches the paths that must stay live", () => {
    const never = [
      // the public JSON: nothing on a web page calls it; the dashboard reads /lean
      "/api/conditions/boca-raton",
      "/api/conditions/boca-raton/lean/x",
      "/api/conditions/boca-raton/leaner",
      "/admin",
      "/admin/review",
      "/api/admin/add",
      "/api/history/boca-raton",
      "/api/devices",
      "/api/devices/purchase",
      "/api/revenuecat/webhook",
      "/api/quality/owner/session",
      "/api/quality/alerts",
      "/api/push/register",
      "/api/push/run",
      "/api/presence",
      "/api/live-activity/start",
      "/api/v1/beaches",
      "/api/v1/beaches/boca-raton",
      "/api/watch/boca-raton",
      "/api/share/boca-raton",
      "/api/cam/boca-1",
      "/api/resolve",
      "/api/version",
      "/api/open",
      "/mcp",
      "/llms.txt",
      "/sw.js",
      "/sw-kill",
      "/sticker",
      "/get-app",
      "/find",
      "/privacy",
      "/support",
      "/manifest.webmanifest",
      "/robots.txt",
      "/sitemap.xml",
      "/opengraph-image",
    ];
    for (const p of never) {
      expect(rules.classify(req(p, { mode: "navigate" })), `navigate ${p}`).toBeNull();
      expect(rules.classify(req(p)), `fetch ${p}`).toBeNull();
    }
  });

  it("leaves non-GET, credentialed, ranged, cross-origin and query-string requests alone", () => {
    expect(rules.classify(req("/api/conditions/boca-raton/lean", { method: "POST" }))).toBeNull();
    expect(rules.classify(req("/api/conditions/boca-raton/lean", { hasAuth: true }))).toBeNull();
    expect(rules.classify(req("/_next/static/media/a.woff2", { hasRange: true }))).toBeNull();
    expect(rules.classify(req("https://evil.test/_next/static/a.js"))).toBeNull();
    expect(rules.classify(req("https://user:pw@app.test/_next/static/a.js"))).toBeNull();
    // the dashboard's deliberate freshness check and any other query go to the network
    expect(rules.classify(req("/api/conditions/boca-raton/lean?fresh=1"))).toBeNull();
    expect(rules.classify(req("/?ref=tag", { mode: "navigate" }))).toBeNull();
    expect(rules.classify(req("/siesta-key?x=1", { mode: "navigate" }))).toBeNull();
    // a page is only a navigation: a script fetching "/" is not
    expect(rules.classify(req("/"))).toBeNull();
    // odd shapes
    expect(rules.classify(req("/siesta-key/", { mode: "navigate" }))).toBeNull();
    expect(rules.classify(req("/Siesta-Key", { mode: "navigate" }))).toBeNull();
    expect(rules.classify(req("/a/b", { mode: "navigate" }))).toBeNull();
    expect(rules.classify(req("/api/conditions/", {}))).toBeNull();
    expect(rules.classify(req("/api/conditions/a/b", {}))).toBeNull();
  });

  it("RESERVED_SEGMENTS covers every real route folder in app/ (drift guard)", () => {
    const dirs = readdirSync(path.join(process.cwd(), "app"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((n) => !/^[[(_@]/.test(n) && !n.includes("."));
    for (const d of dirs) expect(rules.RESERVED_SEGMENTS, `app/${d}`).toContain(d);
    // and no beach slug is wrongly reserved
    const slugs = JSON.parse(readFileSync(path.join(process.cwd(), "config", "beach-slugs.json"), "utf8")) as string[];
    for (const r of rules.RESERVED_SEGMENTS) expect(slugs).not.toContain(r);
  });

  it("refuses to store anything but a complete 200 from this origin", () => {
    const good = { status: 200, type: "basic", redirected: false, contentType: "text/html; charset=utf-8" };
    expect(rules.cacheableResponse("page", good)).toBe(true);
    expect(rules.cacheableResponse("page", { ...good, status: 404 })).toBe(false);
    expect(rules.cacheableResponse("page", { ...good, status: 206 })).toBe(false);
    expect(rules.cacheableResponse("page", { ...good, status: 500 })).toBe(false);
    expect(rules.cacheableResponse("page", { ...good, type: "opaque" })).toBe(false);
    expect(rules.cacheableResponse("page", { ...good, type: "cors" })).toBe(false);
    expect(rules.cacheableResponse("page", { ...good, type: "opaqueredirect", status: 0 })).toBe(false);
    expect(rules.cacheableResponse("page", { ...good, redirected: true })).toBe(false);
    expect(rules.cacheableResponse("page", { ...good, varyStar: true })).toBe(false);
    expect(rules.cacheableResponse("page", { ...good, contentType: "application/json" })).toBe(false);
    expect(rules.cacheableResponse("conditions", { ...good, contentType: "application/json" })).toBe(true);
    expect(rules.cacheableResponse("conditions", { ...good, contentType: "text/html" })).toBe(false);
    expect(rules.cacheableResponse("static", { ...good, contentType: "text/javascript" })).toBe(true);
    expect(rules.cacheableResponse("static", { ...good, contentType: "text/html" })).toBe(false);
    expect(rules.cacheableResponse("static", { ...good, contentType: "font/woff2", contentLength: 9_000_000 })).toBe(false);
    expect(rules.cacheableResponse("other", good)).toBe(false);
  });

  it("recognises complete html and real conditions data", () => {
    expect(rules.looksCompleteHtml("<html><body>x</body></html>\n")).toBe(true);
    expect(rules.looksCompleteHtml("<html><body>x</bo")).toBe(false);
    expect(rules.looksLikeConditions(JSON.stringify({ snapshot: { generatedAt: "2026-10-18T12:00:00Z" } }))).toBe(true);
    expect(rules.looksLikeConditions(JSON.stringify({ error: "Unknown location" }))).toBe(false);
    expect(rules.looksLikeConditions("not json")).toBe(false);
  });

  it("the asset signature changes with the build and not with the data", () => {
    const a = `<script src="/_next/static/chunks/a-111.js"></script><link href="/_next/static/css/x.css"> data=1`;
    const a2 = `<link href="/_next/static/css/x.css"><script src="/_next/static/chunks/a-111.js"></script> data=2`;
    const b = `<script src="/_next/static/chunks/a-222.js"></script><link href="/_next/static/css/x.css"> data=1`;
    expect(rules.assetSignature(a)).toBe(rules.assetSignature(a2));
    expect(rules.assetSignature(a)).not.toBe(rules.assetSignature(b));
    expect(rules.assetSignature("<html></html>")).toBe("");
  });

  it("serve plan: fresh copy answers at once, an old one never stands in as current", () => {
    const now = 1_000_000_000_000;
    const h = 3600_000;
    const plan = (kind: string, at: number | null, o: Record<string, unknown> = {}) =>
      rules.servePlan(kind, at, { now, saveData: false, firstForClient: true, ...o });
    expect(plan("page", null).action).toBe("network");
    expect(plan("page", now - 5_000)).toEqual({ action: "cache", revalidate: false }); // just refreshed
    expect(plan("page", now - 60_000)).toEqual({ action: "cache", revalidate: true });
    expect(plan("page", now - 5 * h)).toEqual({ action: "cache", revalidate: true });
    expect(plan("page", now - 6 * h - 1).action).toBe("stale-fallback");
    expect(plan("page", now + 60_000).action).toBe("stale-fallback"); // a clock that moved back
    expect(plan("page", now - 60_000, { saveData: true })).toEqual({ action: "cache", revalidate: false });
    expect(plan("page", now - 31 * 60_000, { saveData: true }).revalidate).toBe(true);
    // conditions: only the first call of a page load is stale-while-revalidate
    expect(plan("conditions", now - 60_000).action).toBe("cache");
    expect(plan("conditions", now - 60_000, { firstForClient: false }).action).toBe("network-first");
    expect(plan("conditions", now - 7 * h).action).toBe("stale-fallback");
  });

  it("a reload or hard reload skips the cache; a normal visit does not", () => {
    expect(rules.bypassesCache("reload")).toBe(true);
    expect(rules.bypassesCache("no-cache")).toBe(true);
    expect(rules.bypassesCache("no-store")).toBe(true);
    expect(rules.bypassesCache("default")).toBe(false);
    expect(rules.bypassesCache("force-cache")).toBe(false);
  });

  it("stops caching when storage is nearly full or tiny", () => {
    expect(rules.quotaAllows(null)).toBe(true);
    expect(rules.quotaAllows({ usage: 10e6, quota: 1e9 })).toBe(true);
    expect(rules.quotaAllows({ usage: 900e6, quota: 1e9 })).toBe(false);
    expect(rules.quotaAllows({ usage: 0, quota: 10e6 })).toBe(false);
  });
});

// --- the worker run end to end against fakes ---------------------------------
const html = (build: string, data = "1") =>
  `<!doctype html><html><head><script src="/_next/static/chunks/main-${build}.js"></script></head><body>score ${data}</body></html>`;
const cond = (generatedAt: string, extra = "") => JSON.stringify({ snapshot: { generatedAt }, extra });
const htmlRes = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" } });
const jsonRes = (body: string) => new Response(body, { status: 200, headers: { "content-type": "application/json" } });

describe("sw.js behaviour", () => {
  it("static files: network once, then cache-first", async () => {
    const w = makeWorker();
    w.net.routes.set(`${ORIGIN}/_next/static/chunks/a.js`, () => new Response("code", { status: 200, headers: { "content-type": "text/javascript" } }));
    const r1 = await w.dispatch({ url: "/_next/static/chunks/a.js" });
    expect(await r1!.text()).toBe("code");
    w.net.calls.length = 0;
    const r2 = await w.dispatch({ url: "/_next/static/chunks/a.js" });
    expect(await r2!.text()).toBe("code");
    expect(w.net.calls.filter((u) => u.includes("a.js"))).toHaveLength(0);
  });

  it("does not store a 404 or an html page posing as a file", async () => {
    const w = makeWorker();
    w.net.routes.set(`${ORIGIN}/_next/static/chunks/gone.js`, () => new Response("missing", { status: 404 }));
    w.net.routes.set(`${ORIGIN}/_next/static/chunks/fake.js`, () => htmlRes("<html></html>"));
    await w.dispatch({ url: "/_next/static/chunks/gone.js" });
    await w.dispatch({ url: "/_next/static/chunks/fake.js" });
    const c = await w.caches.open(w.rules && "ibd-static-s1");
    expect(c.store.size).toBe(0);
  });

  it("page: first visit from the network, second from the cache, fresh copy fetched behind it", async () => {
    const w = makeWorker();
    let data = "1";
    w.net.routes.set(`${ORIGIN}/`, () => htmlRes(html("A", data)));
    const r1 = await w.dispatch({ url: "/", mode: "navigate" });
    expect(await r1!.text()).toContain("score 1");

    data = "2";
    w.net.calls.length = 0;
    // age the stored copy past the 10 s refresh gap
    const pages = await w.caches.open("ibd-pages-s1-v1");
    const stored = pages.store.get(`${ORIGIN}/`)!;
    const aged = new Response(await stored.clone().text(), { headers: new Headers(stored.headers) });
    aged.headers.set("x-ibd-cached-at", String(Date.now() - 60_000));
    pages.store.set(`${ORIGIN}/`, aged);

    const r2 = await w.dispatch({ url: "/", mode: "navigate" });
    expect(await r2!.text()).toContain("score 1"); // instant: the old copy
    expect(w.net.calls).toContain(`${ORIGIN}/`); // and a fresh one was fetched behind it
    const r3 = await w.dispatch({ url: "/", mode: "navigate" });
    expect(await r3!.text()).toContain("score 2"); // next open shows the new copy
  });

  it("page: the saved copy carries the Server-Timing stamp the page reads", async () => {
    const w = makeWorker();
    w.net.routes.set(`${ORIGIN}/jupiter`, () => htmlRes(html("A")));
    await w.dispatch({ url: "/jupiter", mode: "navigate" });
    const r = await w.dispatch({ url: "/jupiter", mode: "navigate" });
    const st = r!.headers.get("server-timing") ?? "";
    expect(st).toMatch(/ibd-sw;desc="\d{13}"/);
    expect(r!.headers.get("content-encoding")).toBeNull();
  });

  it("page: a copy older than 6 hours is not shown as current; the network wins", async () => {
    const w = makeWorker();
    w.net.routes.set(`${ORIGIN}/`, () => htmlRes(html("A", "new")));
    const pages = await w.caches.open("ibd-pages-s1-v1");
    pages.store.set(
      `${ORIGIN}/`,
      new Response(html("A", "old"), { headers: { "content-type": "text/html", "x-ibd-cached-at": String(Date.now() - 7 * 3600_000) } }),
    );
    const r = await w.dispatch({ url: "/", mode: "navigate" });
    expect(await r!.text()).toContain("score new");
  });

  it("page: an old copy is used only if the network is down or silent", async () => {
    const w = makeWorker();
    const oldAt = String(Date.now() - 7 * 3600_000);
    const seed = async () => {
      const pages = await w.caches.open("ibd-pages-s1-v1");
      pages.store.set(`${ORIGIN}/`, new Response(html("A", "old"), { headers: { "content-type": "text/html", "x-ibd-cached-at": oldAt } }));
    };
    await seed();
    w.net.down = true;
    const down = await w.dispatch({ url: "/", mode: "navigate" });
    expect(await down!.text()).toContain("score old");

    w.net.down = false;
    w.net.delayMs = 3500; // silent past the 3 s limit
    w.net.routes.set(`${ORIGIN}/`, () => htmlRes(html("A", "late")));
    const slow = await w.dispatch({ url: "/", mode: "navigate" });
    expect(await slow!.text()).toContain("score old");
    // and the late answer still refreshed the cache for next time
    const pages = await w.caches.open("ibd-pages-s1-v1");
    expect(await pages.store.get(`${ORIGIN}/`)!.text()).toContain("score late");
  }, 15_000);

  it("page: no copy and no network is an honest failure, not an empty page", async () => {
    const w = makeWorker();
    w.net.down = true;
    await expect(w.dispatch({ url: "/siesta-key", mode: "navigate" })).rejects.toThrow();
  });

  it("page: a reload goes to the network", async () => {
    const w = makeWorker();
    w.net.routes.set(`${ORIGIN}/`, () => htmlRes(html("A", "net")));
    const pages = await w.caches.open("ibd-pages-s1-v1");
    pages.store.set(`${ORIGIN}/`, new Response(html("A", "saved"), { headers: { "content-type": "text/html", "x-ibd-cached-at": String(Date.now() - 60_000) } }));
    const r = await w.dispatch({ url: "/", mode: "navigate", cache: "reload" });
    expect(await r!.text()).toContain("score net");
  });

  it("page: never stores an incomplete page, a redirect or an error page", async () => {
    const w = makeWorker();
    w.net.routes.set(`${ORIGIN}/a`, () => htmlRes("<html><body>cut off"));
    w.net.routes.set(`${ORIGIN}/b`, () => new Response("<html></html>", { status: 500, headers: { "content-type": "text/html" } }));
    w.net.routes.set(`${ORIGIN}/c`, () => new Response("<html></html>", { status: 404, headers: { "content-type": "text/html" } }));
    for (const p of ["/a", "/b", "/c"]) await w.dispatch({ url: p, mode: "navigate" });
    const pages = await w.caches.open("ibd-pages-s1-v1");
    expect(pages.store.size).toBe(0);
  });

  it("page: a new build behind the saved page tells the page", async () => {
    const w = makeWorker();
    let build = "A";
    w.net.routes.set(`${ORIGIN}/`, () => htmlRes(html(build)));
    await w.dispatch({ url: "/", mode: "navigate" });
    const pages = await w.caches.open("ibd-pages-s1-v1");
    const s = pages.store.get(`${ORIGIN}/`)!;
    const aged = new Response(await s.clone().text(), { headers: new Headers(s.headers) });
    aged.headers.set("x-ibd-cached-at", String(Date.now() - 60_000));
    pages.store.set(`${ORIGIN}/`, aged);
    build = "B";
    await w.dispatch({ url: "/", mode: "navigate" });
    const msg = w.posted.filter((m) => m.type === "ibd-build-changed");
    expect(msg).toHaveLength(1);
    expect(msg[0].path).toBe("/");
    expect(msg[0].toJupiter).toBeUndefined(); // only windows on that path hear it
  });

  it("conditions: first call is answered from the cache, then the fresh snapshot is posted", async () => {
    const w = makeWorker();
    const url = `${ORIGIN}/api/conditions/boca-raton/lean`;
    w.net.routes.set(url, () => jsonRes(cond("2026-10-18T10:00:00Z")));
    const first = await w.dispatch({ url: "/api/conditions/boca-raton/lean", clientId: "tab1" });
    expect((await first!.json()).snapshot.generatedAt).toBe("2026-10-18T10:00:00Z");
    const mine = () => w.posted.filter((m) => m.type === "ibd-fresh" && !m.toJupiter);
    expect(mine()).toHaveLength(1); // delivered:true, no data
    expect(mine()[0].delivered).toBe(true);
    expect(mine()[0].data).toBeUndefined();
    w.posted.length = 0;

    // age the copy, change the server data, new page load (new client)
    const data = await w.caches.open("ibd-data-s1-v1");
    const s = data.store.get(url)!;
    const aged = new Response(await s.clone().text(), { headers: new Headers(s.headers) });
    aged.headers.set("x-ibd-cached-at", String(Date.now() - 120_000));
    data.store.set(url, aged);
    w.net.routes.set(url, () => jsonRes(cond("2026-10-18T10:05:00Z")));
    const second = await w.dispatch({ url: "/api/conditions/boca-raton/lean", clientId: "tab2" });
    expect((await second!.json()).snapshot.generatedAt).toBe("2026-10-18T10:00:00Z"); // instant, old
    const fresh = mine();
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ slug: "boca-raton", changed: true, delivered: false });
    expect((fresh[0].data as { snapshot: { generatedAt: string } }).snapshot.generatedAt).toBe("2026-10-18T10:05:00Z");
  });

  it("conditions: the packed lean answer is stored and posted as it came (the page unpacks it)", async () => {
    const w = makeWorker();
    const url = `${ORIGIN}/api/conditions/boca-raton/lean`;
    const packed = (g: string) =>
      JSON.stringify({ wire: 1, snapshot: { generatedAt: g, hourly: { data: { $packed: 1, n: 0, k: [], c: [] } } } });
    w.net.routes.set(url, () => jsonRes(packed("2026-10-18T10:00:00Z")));
    await w.dispatch({ url: "/api/conditions/boca-raton/lean", clientId: "p1" });
    const data = await w.caches.open("ibd-data-s1-v1");
    const s = data.store.get(url)!;
    expect(JSON.parse(await s.clone().text()).wire).toBe(1);
    const aged = new Response(await s.clone().text(), { headers: new Headers(s.headers) });
    aged.headers.set("x-ibd-cached-at", String(Date.now() - 120_000));
    data.store.set(url, aged);
    w.posted.length = 0;
    w.net.routes.set(url, () => jsonRes(packed("2026-10-18T10:05:00Z")));
    await w.dispatch({ url: "/api/conditions/boca-raton/lean", clientId: "p2" });
    const m = w.posted.filter((x) => x.type === "ibd-fresh" && !x.toJupiter);
    expect(m).toHaveLength(1);
    const posted = m[0].data as { wire: number; snapshot: { generatedAt: string; hourly: { data: { $packed: number } } } };
    expect(posted.wire).toBe(1);
    expect(posted.snapshot.generatedAt).toBe("2026-10-18T10:05:00Z");
    expect(posted.snapshot.hourly.data.$packed).toBe(1);
  });

  it("conditions: an unchanged refresh still posts the snapshot, so the page can never be left behind", async () => {
    const w = makeWorker();
    const url = `${ORIGIN}/api/conditions/boca-raton/lean`;
    w.net.routes.set(url, () => jsonRes(cond("2026-10-18T10:00:00Z")));
    await w.dispatch({ url: "/api/conditions/boca-raton/lean", clientId: "u1" });
    const data = await w.caches.open("ibd-data-s1-v1");
    const s = data.store.get(url)!;
    const aged = new Response(await s.clone().text(), { headers: new Headers(s.headers) });
    aged.headers.set("x-ibd-cached-at", String(Date.now() - 120_000));
    data.store.set(url, aged);
    w.posted.length = 0;
    await w.dispatch({ url: "/api/conditions/boca-raton/lean", clientId: "u2" });
    const m = w.posted.filter((x) => x.type === "ibd-fresh" && !x.toJupiter);
    expect(m).toHaveLength(1);
    expect(m[0].changed).toBe(false);
    expect(m[0].data).toBeTruthy();
  });

  it("conditions: later calls in the same page load (poll, Refresh) go to the network", async () => {
    const w = makeWorker();
    const url = `${ORIGIN}/api/conditions/boca-raton/lean`;
    let g = "2026-10-18T10:00:00Z";
    w.net.routes.set(url, () => jsonRes(cond(g)));
    await w.dispatch({ url: "/api/conditions/boca-raton/lean", clientId: "tab1" });
    g = "2026-10-18T10:05:00Z";
    const poll = await w.dispatch({ url: "/api/conditions/boca-raton/lean", clientId: "tab1" });
    expect((await poll!.json()).snapshot.generatedAt).toBe("2026-10-18T10:05:00Z");
    // offline poll falls back to the last good copy
    w.net.down = true;
    const off = await w.dispatch({ url: "/api/conditions/boca-raton/lean", clientId: "tab1" });
    expect((await off!.json()).snapshot.generatedAt).toBe("2026-10-18T10:05:00Z");
  });

  it("conditions: ?fresh=1, errors and wrong bodies are never stored", async () => {
    const w = makeWorker();
    const url = `${ORIGIN}/api/conditions/boca-raton/lean`;
    expect(await w.dispatch({ url: "/api/conditions/boca-raton/lean?fresh=1" })).toBeNull(); // worker stays out
    w.net.routes.set(url, () => new Response(JSON.stringify({ error: "Unknown location" }), { status: 404, headers: { "content-type": "application/json" } }));
    const r = await w.dispatch({ url: "/api/conditions/boca-raton/lean" });
    expect(r!.status).toBe(404);
    w.net.routes.set(url, () => jsonRes(JSON.stringify({ hello: "world" })));
    await w.dispatch({ url: "/api/conditions/boca-raton/lean", clientId: "t2" });
    const data = await w.caches.open("ibd-data-s1-v1");
    expect(data.store.size).toBe(0);
  });

  it("conditions: an old copy (over 6 h) waits for the network instead of posing as current", async () => {
    const w = makeWorker();
    const url = `${ORIGIN}/api/conditions/boca-raton/lean`;
    const data = await w.caches.open("ibd-data-s1-v1");
    data.store.set(url, new Response(cond("2026-10-18T01:00:00Z"), { headers: { "content-type": "application/json", "x-ibd-cached-at": String(Date.now() - 8 * 3600_000) } }));
    w.net.routes.set(url, () => jsonRes(cond("2026-10-18T10:00:00Z")));
    const r = await w.dispatch({ url: "/api/conditions/boca-raton/lean", clientId: "n1" });
    expect((await r!.json()).snapshot.generatedAt).toBe("2026-10-18T10:00:00Z");
  });

  it("conditions: a failed refresh tells the page", async () => {
    const w = makeWorker();
    const url = `${ORIGIN}/api/conditions/boca-raton/lean`;
    const data = await w.caches.open("ibd-data-s1-v1");
    data.store.set(url, new Response(cond("2026-10-18T10:00:00Z"), { headers: { "content-type": "application/json", "x-ibd-cached-at": String(Date.now() - 120_000) } }));
    w.net.down = true;
    const r = await w.dispatch({ url: "/api/conditions/boca-raton/lean", clientId: "f1" });
    expect((await r!.json()).snapshot.generatedAt).toBe("2026-10-18T10:00:00Z");
    expect(w.posted.some((m) => m.type === "ibd-fresh-failed")).toBe(true);
  });

  it("activate deletes caches of older builds and keeps the build files", async () => {
    const w = makeWorker("v2");
    await w.caches.open("ibd-pages-s1-v1");
    await w.caches.open("ibd-data-s1-v1");
    await w.caches.open("ibd-pages-s1-v2");
    await w.caches.open("ibd-static-s1");
    await w.caches.open("other-site-cache");
    w.net.routes.set(`${ORIGIN}/sw-kill`, () => new Response("ok", { status: 404 }));
    await w.lifecycle("activate");
    const names = await w.caches.keys();
    expect(names).toContain("ibd-pages-s1-v2");
    expect(names).toContain("ibd-static-s1");
    expect(names).toContain("other-site-cache");
    expect(names).not.toContain("ibd-pages-s1-v1");
    expect(names).not.toContain("ibd-data-s1-v1");
    expect(w.unregistered.value).toBe(false);
  });

  it("kill switch: a 200 'kill' answer wipes the caches, unregisters, and the worker stops answering", async () => {
    const w = makeWorker();
    w.net.routes.set(`${ORIGIN}/sw-kill`, () => new Response("kill", { status: 200 }));
    w.net.routes.set(`${ORIGIN}/`, () => htmlRes(html("A")));
    await w.dispatch({ url: "/", mode: "navigate" });
    await w.lifecycle("activate");
    expect(w.unregistered.value).toBe(true);
    expect((await w.caches.keys()).filter((n) => n.startsWith("ibd-"))).toEqual([]);
    expect(w.posted.some((m) => m.type === "ibd-killed")).toBe(true);
    expect(await w.dispatch({ url: "/", mode: "navigate" })).toBeNull();
  });

  it("kill switch: a network error or a 500 never kills the worker", async () => {
    const w = makeWorker();
    w.net.down = true;
    await w.lifecycle("activate");
    expect(w.unregistered.value).toBe(false);
    w.net.down = false;
    w.net.routes.set(`${ORIGIN}/sw-kill`, () => new Response("kill", { status: 500 }));
    await w.lifecycle("activate");
    expect(w.unregistered.value).toBe(false);
  });
});
