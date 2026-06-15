/*
 * Boca Beach Rats service worker — makes the app installable + usable offline,
 * without ever passing off stale conditions as live.
 *
 * Strategy:
 *  - Hashed build assets (/_next/static/*) -> cache-first (they're immutable).
 *  - Everything else same-origin (pages + /api/conditions) -> network-first,
 *    falling back to cache ONLY when the network is unavailable. So you always
 *    get fresh data online, and the last-known snapshot (with its own visible
 *    timestamps) when offline.
 *  - Cam images (/api/cam/*) and any third-party host are left to the browser
 *    (large/own caching) — the SW doesn't touch them.
 */
const VERSION = "v1";
const STATIC_CACHE = `bbr-static-${VERSION}`;
const RUNTIME_CACHE = `bbr-runtime-${VERSION}`;
const KEEP = [STATIC_CACHE, RUNTIME_CACHE];

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // third-party (cam hosts, etc.)
  if (url.pathname.startsWith("/api/cam/")) return; // big images, own HTTP cache

  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(req, STATIC_CACHE));
    return;
  }
  event.respondWith(networkFirst(req, RUNTIME_CACHE));
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok) cache.put(req, res.clone());
  return res;
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    if (req.mode === "navigate") {
      const home = await cache.match("/");
      if (home) return home;
      return new Response(
        "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>" +
          // Match the app's theme before paint: stored choice ("theme") wins, else
          // fall back to the OS preference — same rule as the layout.tsx pre-paint script.
          "<script>(function(){try{var t=localStorage.getItem('theme');var d=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);var s=document.documentElement.style;s.background=d?'#020617':'#f3f7fb';s.color=d?'#e2e8f0':'#0f172a';}catch(e){}})();</script>" +
          "<body style='font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;text-align:center'>" +
          "<div><h1 style='margin:0 0 .5rem'>You're offline</h1>" +
          "<p style='opacity:.65'>Is It Beach Day needs a connection to load fresh conditions.</p></div>",
        { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }
    throw err;
  }
}
