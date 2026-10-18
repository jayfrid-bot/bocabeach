/*
 * Is It Beach Day service worker (2026-10-18, perf-sw).
 *
 * Goal: a REPEAT open shows the page with its last data at once (target 50 ms),
 * then a quiet refresh. Plan and risks: docs/SERVICE_WORKER.md.
 *
 * What it does:
 *  - /_next/static/*       cache-first. Files are hashed, so they never change.
 *  - / and /<beach>        stale-while-revalidate. Answer from the last copy, fetch a
 *                          fresh copy behind it. A copy older than 6 hours is not shown
 *                          as current: the network answers, and the old copy is used
 *                          only if the network is slow (3 s) or down.
 *  - /api/conditions/<b>/lean  the dashboard's data call (the packed form). The call the
 *                          page marks as its first of a page load (header x-ibd-first-call: 1)
 *                          is stale-while-revalidate. Every other call (poll, resume, Refresh
 *                          button) goes to the network. When fresh data lands the worker
 *                          posts it to the page, still packed.
 *  - everything else       untouched. The worker never calls respondWith for it.
 *
 * Never cached: any non-GET, any request with Authorization or Range, any query string
 * on a page, /admin, /api/* other than conditions/<b>/lean (the public
 * /api/conditions/<b> included), /mcp, /api/v1, push, history,
 * devices, RevenueCat, install-token routes, non-200 and opaque answers.
 *
 * Versioning: the page registers /sw.js?v=<build>. A new build installs a new worker.
 * On activate it deletes EVERY cache on this origin that is not its own (older page and
 * data caches, and anything an earlier worker left). Hashed files stay in the shared
 * static cache (an open tab or a saved page on the old build still needs them): when a
 * page is saved, the build files it names are saved too, and trimming never drops a
 * file that a saved page names. After a deploy the old files are gone from the server,
 * so this cache is what lets a saved old page still run.
 *
 * Never in the app shells: their user agent carries IsItBeachDayApp/ (capacitor.config.ts,
 * iOS and Android). A worker that finds itself there deletes its caches and unregisters.
 *
 * Kill switch: GET /sw-kill answering 200 "kill" makes the worker delete its caches and
 * unregister. It checks at activate and at most every 30 minutes. The page also removes
 * it on ?nosw=1 (sticky; ?sw=on undoes it). See docs/SERVICE_WORKER.md.
 *
 * The pure rules sit in IBD_SW and are unit-tested (lib/swRules.test.ts).
 */
"use strict";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
var SW_SCHEMA = 1;
var HOUR = 3600 * 1000;
var MIN = 60 * 1000;

var LIMITS = {
  /** A cached page or data copy older than this is never shown as current. */
  maxAgeMs: 6 * HOUR,
  /** Do not start a background refresh for a copy younger than this. */
  pageRefreshGapMs: 10 * 1000,
  dataRefreshGapMs: 20 * 1000,
  /** With Save-Data on, refresh at most this often. */
  saveDataGapMs: 30 * MIN,
  /** An expired copy is used only after the network is silent for this long. */
  networkTimeoutMs: 3000,
  /** Saving a page's build files waits this long, so the page's own loads come first. */
  precacheDelayMs: 5000,
  maxPages: 12,
  maxData: 48,
  maxStaticEntries: 200,
  trimStaticTo: 150,
  maxStaticBytes: 1500 * 1024,
  /** Stop adding to the caches above this share of the origin quota. */
  quotaShare: 0.8,
  minQuotaBytes: 50 * 1024 * 1024,
  killCheckGapMs: 30 * MIN,
};

var CACHE_PREFIX = "ibd-";
var VERSION = (function () {
  try {
    return new URL(self.location.href).searchParams.get("v") || "0";
  } catch (e) {
    return "0";
  }
})();
var STATIC_CACHE = CACHE_PREFIX + "static-s" + SW_SCHEMA;
var PAGE_CACHE = CACHE_PREFIX + "pages-s" + SW_SCHEMA + "-" + VERSION;
var DATA_CACHE = CACHE_PREFIX + "data-s" + SW_SCHEMA + "-" + VERSION;
var META_CACHE = CACHE_PREFIX + "meta-s" + SW_SCHEMA;

/** Single-segment paths that are real routes, not beaches. Drift is tested against app/. */
var RESERVED_SEGMENTS = [
  "admin",
  "api",
  "find",
  "get-app",
  "mcp",
  "opengraph-image",
  "privacy",
  "sticker",
  "support",
  "sw-kill",
  "twitter-image",
];

var SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The dashboard sends this on the first data call of a page load only (lib/swClient.ts). */
var FIRST_CALL_HEADER = "x-ibd-first-call";
/** The native shells append this to the user agent (capacitor.config.ts, iOS and Android). */
var SHELL_UA_RE = /IsItBeachDayApp\//i;
/**
 * The dashboard's data call is the packed /api/conditions/<b>/lean (lib/clientConditions.ts).
 * The public /api/conditions/<b> is left to the network: nothing on a web page calls it, and
 * one data route keeps "the first call of a page load" unambiguous.
 */
var CONDITIONS_RE = /^\/api\/conditions\/([a-z0-9]+(?:-[a-z0-9]+)*)\/lean$/;

// ---------------------------------------------------------------------------
// Pure rules (no I/O). Exposed as self.IBD_SW for the unit tests.
// ---------------------------------------------------------------------------

/**
 * What kind of request is this, if the worker handles it at all?
 * r = { method, url, origin, mode, hasAuth, hasRange }
 * Returns { kind: "static" | "page" | "conditions", key, slug? } or null (= hands off).
 */
function classify(r) {
  if (!r || r.method !== "GET") return null;
  var u;
  try {
    u = new URL(r.url);
  } catch (e) {
    return null;
  }
  if (u.origin !== r.origin) return null;
  if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") return null;
  if (u.username || u.password) return null;
  if (r.hasAuth || r.hasRange) return null;
  var p = u.pathname;

  if (p.indexOf("/_next/static/") === 0) {
    return { kind: "static", key: u.origin + p + u.search };
  }

  var m = CONDITIONS_RE.exec(p);
  if (m) {
    // "?fresh=1" is the dashboard's deliberate freshness check: always the network.
    if (u.search !== "") return null;
    return { kind: "conditions", key: u.origin + p, slug: m[1] };
  }

  if (r.mode === "navigate" && u.search === "") {
    if (p === "/") return { kind: "page", key: u.origin + "/", path: "/" };
    var seg = p.slice(1);
    if (SLUG_RE.test(seg) && RESERVED_SEGMENTS.indexOf(seg) === -1) {
      return { kind: "page", key: u.origin + p, path: p };
    }
  }
  return null;
}

/**
 * May this answer go into the cache?
 * s = { status, type, redirected, contentType, varyStar, contentLength }
 */
function cacheableResponse(kind, s) {
  if (!s || s.status !== 200) return false;
  if (s.type !== "basic" && s.type !== "default") return false; // no opaque, no cors
  if (s.redirected) return false;
  if (s.varyStar) return false;
  var ct = (s.contentType || "").toLowerCase();
  if (kind === "page") return ct.indexOf("text/html") === 0;
  if (kind === "conditions") return ct.indexOf("application/json") === 0;
  if (kind === "static") {
    if (ct.indexOf("text/html") === 0) return false; // a fallback page posing as a file
    if (s.contentLength != null && s.contentLength > LIMITS.maxStaticBytes) return false;
    return true;
  }
  return false;
}

/** A complete HTML document ends with </html>. A cut-off stream does not. */
function looksCompleteHtml(text) {
  return typeof text === "string" && /<\/html>\s*$/i.test(text);
}

/** A conditions answer must carry the snapshot the dashboard reads. */
function looksLikeConditions(text) {
  try {
    var j = JSON.parse(text);
    return !!(j && j.snapshot && j.snapshot.generatedAt);
  } catch (e) {
    return false;
  }
}

/**
 * Hash of the build files an HTML page points at. Two copies of a page from the same
 * build give the same value; a new deploy changes it.
 */
function assetSignature(html) {
  var found = html.match(/\/_next\/static\/[A-Za-z0-9_\-\/.]+\.(?:js|css)/g) || [];
  var seen = {};
  var list = [];
  for (var i = 0; i < found.length; i++) {
    if (!seen[found[i]]) {
      seen[found[i]] = 1;
      list.push(found[i]);
    }
  }
  list.sort();
  var h = 5381;
  var s = list.join("|");
  for (var k = 0; k < s.length; k++) h = ((h * 33) ^ s.charCodeAt(k)) >>> 0;
  return list.length ? h.toString(16) + "." + list.length : "";
}

/**
 * The build files a page names: its <script>/<link> tags (/_next/static/...) and the
 * chunk lists in its React flight data ("static/chunks/..."), as same-origin paths.
 */
function referencedAssets(html) {
  if (typeof html !== "string") return [];
  var out = [];
  var seen = {};
  var add = function (p) {
    if (!seen[p] && out.length < 120) {
      seen[p] = 1;
      out.push(p);
    }
  };
  var a = html.match(/\/_next\/static\/[A-Za-z0-9_\-\/.~%]+\.(?:js|css|woff2)/g) || [];
  for (var i = 0; i < a.length; i++) add(a[i]);
  var b = html.match(/(?:^|[^A-Za-z0-9_\/])static\/(?:chunks|css)\/[A-Za-z0-9_\-\/.~%]+\.(?:js|css)/g) || [];
  for (var j = 0; j < b.length; j++) add("/_next/" + b[j].replace(/^[^s]*/, ""));
  return out;
}

/** Is this worker running inside one of the app shells? */
function isShellAgent(ua) {
  return typeof ua === "string" && SHELL_UA_RE.test(ua);
}

/** Which caches to delete on activate: every name that is not one of this worker's own. */
function cachesToDelete(names, keep) {
  return (names || []).filter(function (n) { return keep.indexOf(n) === -1; });
}

/**
 * What to do with a request for a page or for conditions data.
 *  cachedAt: ms the cached copy was stored, or null.
 *  o = { now, saveData, firstForClient } (firstForClient: the page marked this call as its first)
 * Returns { action, revalidate } where action is one of:
 *  "cache"           answer from the cache now
 *  "network"         ask the network, no cached copy to fall back on
 *  "network-first"   ask the network; use the cached copy only if it fails
 *  "stale-fallback"  ask the network; use the cached copy if it is silent for 3 s or fails
 */
function servePlan(kind, cachedAt, o) {
  var now = o.now;
  if (cachedAt == null || !isFinite(cachedAt)) return { action: "network", revalidate: false };
  var age = now - cachedAt;
  var tooOld = age < 0 || age > LIMITS.maxAgeMs; // a clock that moved back is not trusted
  if (kind === "conditions" && o.firstForClient === false) {
    return { action: "network-first", revalidate: false };
  }
  if (tooOld) return { action: "stale-fallback", revalidate: false };
  var gap = o.saveData
    ? LIMITS.saveDataGapMs
    : kind === "page"
      ? LIMITS.pageRefreshGapMs
      : LIMITS.dataRefreshGapMs;
  return { action: "cache", revalidate: age >= gap };
}

/** Does the page ask for a fresh copy (reload button, hard reload)? */
function bypassesCache(cacheMode) {
  return cacheMode === "reload" || cacheMode === "no-cache" || cacheMode === "no-store";
}

/** navigator.storage.estimate() result -> may we add more? */
function quotaAllows(est) {
  if (!est || !est.quota) return true;
  if (est.quota < LIMITS.minQuotaBytes) return false;
  return (est.usage || 0) / est.quota < LIMITS.quotaShare;
}

/** Server-Timing value the stored page carries: the page reads cachedAt back from it. */
function serverTimingValue(cachedAt) {
  return 'ibd-sw;desc="' + cachedAt + '"';
}

self.IBD_SW = {
  LIMITS: LIMITS,
  RESERVED_SEGMENTS: RESERVED_SEGMENTS,
  classify: classify,
  cacheableResponse: cacheableResponse,
  looksCompleteHtml: looksCompleteHtml,
  looksLikeConditions: looksLikeConditions,
  assetSignature: assetSignature,
  servePlan: servePlan,
  bypassesCache: bypassesCache,
  quotaAllows: quotaAllows,
  serverTimingValue: serverTimingValue,
  referencedAssets: referencedAssets,
  isShellAgent: isShellAgent,
  cachesToDelete: cachesToDelete,
  FIRST_CALL_HEADER: FIRST_CALL_HEADER,
  cacheNames: { STATIC_CACHE: STATIC_CACHE, PAGE_CACHE: PAGE_CACHE, DATA_CACHE: DATA_CACHE, META_CACHE: META_CACHE },
};

// ---------------------------------------------------------------------------
// Worker state and helpers
// ---------------------------------------------------------------------------
var killed = false;
var MATCH_OPTS = { ignoreVary: true };
var lastKillCheckMem = 0;
var storageMemo = { at: 0, ok: true };
var staticPuts = 0;

function hasCaches() {
  return typeof caches !== "undefined" && typeof caches.open === "function";
}

/** Save-Data on, or a 2g / slow-2g connection: no extra downloads. */
function slowOrSaveData(request) {
  if (saveDataOn(request)) return true;
  try {
    var t = self.navigator && self.navigator.connection && self.navigator.connection.effectiveType;
    return t === "2g" || t === "slow-2g";
  } catch (e) {
    return false;
  }
}

function saveDataOn(request) {
  try {
    if (self.navigator && self.navigator.connection && self.navigator.connection.saveData) return true;
  } catch (e) {
    /* ignore */
  }
  return !!(request && request.headers && /(^|,)\s*on\s*$/i.test(request.headers.get("save-data") || ""));
}

function describeRequest(request) {
  return {
    method: request.method,
    url: request.url,
    origin: self.location.origin,
    mode: request.mode,
    hasAuth: request.headers.has("authorization"),
    hasRange: request.headers.has("range"),
  };
}

function cachedAtOf(response) {
  if (!response) return null;
  var v = Number(response.headers.get("x-ibd-cached-at"));
  return isFinite(v) && v > 0 ? v : null;
}

async function storageOk() {
  if (Date.now() - storageMemo.at < 30 * 1000) return storageMemo.ok;
  var ok = true;
  try {
    if (self.navigator && self.navigator.storage && self.navigator.storage.estimate) {
      ok = quotaAllows(await self.navigator.storage.estimate());
    }
  } catch (e) {
    /* ignore */
  }
  storageMemo = { at: Date.now(), ok: ok };
  return ok;
}

function timeoutAfter(ms) {
  return new Promise(function (resolve) {
    setTimeout(function () { resolve(null); }, ms);
  });
}

function hashText(text) {
  var h = 5381;
  for (var i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(16) + "." + text.length;
}

function responseFacts(res) {
  return {
    status: res.status,
    type: res.type,
    redirected: res.redirected,
    contentType: res.headers.get("content-type"),
    varyStar: (res.headers.get("vary") || "").trim() === "*",
  };
}

/** Build the copy that goes into the cache: decoded body, our stamps, no stale length/encoding. */
function stamped(response, body, extra) {
  var headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  var now = Date.now();
  headers.set("x-ibd-cached-at", String(now));
  if (extra && extra.assets) headers.set("x-ibd-assets", extra.assets);
  if (extra && extra.hash) headers.set("x-ibd-hash", extra.hash);
  if (extra && extra.timing) headers.append("server-timing", serverTimingValue(now));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: headers });
}

async function trimCache(cacheName, max, keep) {
  if (killed) return;
  try {
    var cache = await caches.open(cacheName);
    var keys = await cache.keys(); // insertion order: oldest first
    if (keys.length <= max) return;
    var drop = keys.length - (keep || max);
    // Never drop a build file that a saved page names (its build may be gone from the server).
    var guard = cacheName === STATIC_CACHE ? await protectedStaticKeys() : {};
    for (var i = 0; i < keys.length && drop > 0; i++) {
      if (guard[keys[i].url]) continue;
      await cache.delete(keys[i]);
      drop -= 1;
    }
  } catch (e) {
    /* ignore */
  }
}

async function postToWindows(message, filter) {
  try {
    var list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (var i = 0; i < list.length; i++) {
      if (filter && !filter(list[i])) continue;
      list[i].postMessage(message);
    }
  } catch (e) {
    /* ignore */
  }
}

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch (e) {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------
async function wipeCaches() {
  try {
    // Every cache on this origin: this worker's, and anything an earlier worker left.
    var names = await caches.keys();
    await Promise.all(names.map(function (n) { return caches.delete(n); }));
  } catch (e) {
    /* ignore */
  }
}

async function selfDestruct() {
  killed = true;
  await wipeCaches();
  try {
    await self.registration.unregister();
  } catch (e) {
    /* ignore */
  }
  await postToWindows({ type: "ibd-killed" });
  // A request that was already running may still write once. Sweep again.
  await new Promise(function (resolve) { setTimeout(resolve, 800); });
  await wipeCaches();
}

async function checkKillSwitch(force) {
  if (killed || !hasCaches()) return;
  if (!force && Date.now() - lastKillCheckMem < LIMITS.killCheckGapMs && Date.now() >= lastKillCheckMem) return;
  lastKillCheckMem = Date.now();
  try {
    var meta = await caches.open(META_CACHE);
    var stampReq = new Request(self.location.origin + "/__ibd/kill-check");
    if (!force) {
      var last = await meta.match(stampReq);
      var at = last ? Number(await last.text()) : 0;
      if (at && Date.now() - at < LIMITS.killCheckGapMs && Date.now() >= at) return;
    }
    // Stamp first, so a down network does not turn into a check on every request.
    if (killed) return;
    await meta.put(stampReq, new Response(String(Date.now())));
    var res = await fetch("/sw-kill", { cache: "no-store", credentials: "omit" });
    if (res.status === 200 && (await res.text()).trim() === "kill") await selfDestruct();
  } catch (e) {
    /* a failed check never kills the worker */
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
function inShell() {
  try {
    return isShellAgent(self.navigator && self.navigator.userAgent);
  } catch (e) {
    return false;
  }
}

self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    (async function () {
      if (killed) return;
      if (inShell()) return selfDestruct();
      try {
        var keep = [STATIC_CACHE, PAGE_CACHE, DATA_CACHE, META_CACHE];
        var doomed = cachesToDelete(await caches.keys(), keep);
        await Promise.all(doomed.map(function (n) { return caches.delete(n); }));
      } catch (e) {
        /* ignore */
      }
      await trimCache(STATIC_CACHE, LIMITS.maxStaticEntries, LIMITS.trimStaticTo);
      await self.clients.claim();
      await checkKillSwitch(true);
    })(),
  );
});

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------
self.addEventListener("fetch", function (event) {
  if (killed || !hasCaches()) return;
  if (inShell()) {
    event.waitUntil(selfDestruct()); // the app shells never run this worker
    return;
  }
  var request = event.request;
  var c = classify(describeRequest(request));
  if (!c) return; // the browser handles it as if there were no worker
  event.waitUntil(checkKillSwitch(false));
  if (c.kind === "static") {
    event.respondWith(handleStatic(event, request, c));
  } else if (c.kind === "page") {
    event.respondWith(handlePage(event, request, c));
  } else {
    event.respondWith(handleConditions(event, request, c));
  }
});

// -- static: cache first ------------------------------------------------------
async function handleStatic(event, request, c) {
  var cache = await caches.open(STATIC_CACHE);
  var hit = await cache.match(c.key, MATCH_OPTS);
  if (hit) return hit;
  var res = await fetch(request);
  event.waitUntil(putStatic(cache, c.key, res.clone()));
  return res;
}

async function putStatic(cache, key, res) {
  try {
    var facts = responseFacts(res);
    var cl = res.headers.get("content-length");
    facts.contentLength = cl == null ? null : Number(cl);
    var ok = cacheableResponse("static", facts);
    if (killed || !ok || !(await storageOk())) return;
    await cache.put(key, res);
    staticPuts += 1;
    if (staticPuts % 25 === 0) await trimCache(STATIC_CACHE, LIMITS.maxStaticEntries, LIMITS.trimStaticTo);
  } catch (e) {
    /* quota or a broken body: skip it */
  }
}

// -- page: stale while revalidate ---------------------------------------------
async function handlePage(event, request, c) {
  var cache = await caches.open(PAGE_CACHE);
  var existing = await cache.match(c.key, MATCH_OPTS);
  var plan = bypassesCache(request.cache)
    ? { action: existing ? "stale-fallback" : "network", revalidate: false }
    : servePlan("page", cachedAtOf(existing), { now: Date.now(), saveData: saveDataOn(request) });

  if (plan.action === "cache" && existing) {
    if (plan.revalidate) event.waitUntil(refreshPage(c, existing));
    return existing;
  }
  // No usable copy, an expired one, or an explicit reload: ask the network.
  var stored = null;
  var net = fetch(request).then(function (res) {
    stored = storePage(c, res.clone(), existing, request);
    return res;
  });
  // One lifetime promise, registered now: the answer may arrive after the page was served
  // the old copy, and waitUntil cannot be called once the event has settled.
  event.waitUntil(net.then(function () { return stored; }, function () {}));
  if (plan.action !== "stale-fallback" || !existing) return net;
  var winner = null;
  try {
    winner = await Promise.race([net, timeoutAfter(LIMITS.networkTimeoutMs)]);
  } catch (e) {
    /* the network failed: use the old copy */
  }
  return winner || existing;
}

async function storePage(c, res, previous, request) {
  try {
    var ok = cacheableResponse("page", responseFacts(res));
    if (!ok) return;
    var text = await res.text();
    if (killed || !looksCompleteHtml(text) || !(await storageOk())) return;
    var sig = assetSignature(text);
    var cache = await caches.open(PAGE_CACHE);
    await cache.put(c.key, stamped(res, text, { assets: sig, timing: true }));
    await trimCache(PAGE_CACHE, LIMITS.maxPages);
    var oldSig = previous ? previous.headers.get("x-ibd-assets") : null;
    if (oldSig && sig && oldSig !== sig) await notifyBuildChanged(c.path);
    // The build files this page names, while the server still has them: after a deploy
    // they are gone, and the saved page cannot run without them.
    await precacheAssets(referencedAssets(text), request);
  } catch (e) {
    /* ignore */
  }
}

/**
 * Save the build files a page names that the static cache does not hold yet. Not with
 * Save-Data or on 2g / slow-2g, and only after LIMITS.precacheDelayMs: by then the page has
 * loaded its own files through this worker (cached on the way), so nothing is fetched twice.
 */
async function precacheAssets(paths, request) {
  if (killed || !paths.length || slowOrSaveData(request)) return;
  if (LIMITS.precacheDelayMs > 0) await new Promise(function (r) { setTimeout(r, LIMITS.precacheDelayMs); });
  try {
    var statics = await caches.open(STATIC_CACHE);
    var origin = self.location.origin;
    for (var i = 0; i < paths.length; i++) {
      if (killed) return;
      var key = origin + paths[i];
      if (await statics.match(key, MATCH_OPTS)) continue;
      try {
        await putStatic(statics, key, await fetch(key, { cache: "force-cache", credentials: "omit" }));
      } catch (e) {
        /* skip this file */
      }
    }
  } catch (e) {
    /* ignore */
  }
}

/** Static keys that a saved page names: trimming must keep them. */
async function protectedStaticKeys() {
  var keep = {};
  try {
    var pages = await caches.open(PAGE_CACHE);
    var reqs = await pages.keys();
    for (var i = 0; i < reqs.length; i++) {
      var r = await pages.match(reqs[i], MATCH_OPTS);
      if (!r) continue;
      var list = referencedAssets(await r.text());
      for (var j = 0; j < list.length; j++) keep[self.location.origin + list[j]] = 1;
    }
  } catch (e) {
    /* ignore */
  }
  return keep;
}

/** Background refresh of a page that was just served from the cache. */
async function refreshPage(c, previous) {
  try {
    var res = await fetch(c.key, {
      cache: "no-store",
      credentials: "same-origin",
      redirect: "manual",
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    await storePage(c, res, previous);
  } catch (e) {
    /* offline: the old copy stays */
  }
}

function notifyBuildChanged(path) {
  return postToWindows({ type: "ibd-build-changed", path: path }, function (client) {
    return pathOf(client.url) === path;
  });
}

// -- conditions data: the first call of a page load is stale-while-revalidate ---
async function handleConditions(event, request, c) {
  var cache = await caches.open(DATA_CACHE);
  // The page says which call is its first of a page load. Worker memory cannot: it is
  // emptied whenever the browser stops the worker, and then a poll or Refresh would be
  // answered from the saved copy.
  var first = request.headers.get(FIRST_CALL_HEADER) === "1";
  var existing = await cache.match(c.key, MATCH_OPTS);
  var plan = bypassesCache(request.cache)
    ? { action: existing ? "network-first" : "network", revalidate: false }
    : servePlan("conditions", cachedAtOf(existing), {
        now: Date.now(),
        saveData: saveDataOn(request),
        firstForClient: first,
      });

  if (plan.action === "cache" && existing) {
    if (plan.revalidate) event.waitUntil(refreshConditions(c, existing));
    return existing;
  }

  // The page may be handed the old copy while the network is still busy; then the answer
  // that arrives later is posted to the page instead of returned.
  var state = { late: false };
  var after = null;
  var net = fetch(request).then(function (res) {
    if (res.status >= 500 && existing) throw new Error("server " + res.status);
    after = afterConditionsFetch(c, res.clone(), existing, first, state);
    return res;
  });
  event.waitUntil(
    net.then(
      function () { return after; },
      function () {
        if (first) return postToWindows({ type: "ibd-fresh-failed", kind: "conditions", slug: c.slug });
      },
    ),
  );
  if (!existing) return net;
  if (plan.action === "stale-fallback") {
    var winner = null;
    try {
      winner = await Promise.race([net, timeoutAfter(LIMITS.networkTimeoutMs)]);
    } catch (e) {
      /* use the old copy */
    }
    if (winner) return winner;
    state.late = true;
    return existing;
  }
  try {
    return await net; // network-first: the old copy only if the network fails
  } catch (e) {
    return existing;
  }
}

async function afterConditionsFetch(c, res, existing, first, state) {
  var data = await storeConditions(c, res, existing);
  if (!first || !res.ok) return;
  await postToWindows({
    type: "ibd-fresh",
    kind: "conditions",
    slug: c.slug,
    changed: !!data && data.changed,
    delivered: !state.late,
    data: state.late && data ? data.json : undefined,
  });
}

/** Store a good conditions answer. Returns { changed, json } or null. */
async function storeConditions(c, res, existing) {
  try {
    if (!cacheableResponse("conditions", responseFacts(res))) return null;
    var text = await res.text();
    if (killed || !looksLikeConditions(text) || !(await storageOk())) return null;
    var hash = hashText(text);
    var cache = await caches.open(DATA_CACHE);
    await cache.put(c.key, stamped(res, text, { hash: hash }));
    await trimCache(DATA_CACHE, LIMITS.maxData);
    var before = existing ? existing.headers.get("x-ibd-hash") : null;
    return { changed: before !== hash, json: JSON.parse(text) };
  } catch (e) {
    return null;
  }
}

/** Background refresh of conditions data that was just served from the cache. */
async function refreshConditions(c, existing) {
  var failed = { type: "ibd-fresh-failed", kind: "conditions", slug: c.slug };
  try {
    var res = await fetch(c.key, { cache: "no-store", credentials: "same-origin" });
    var data = res.ok ? await storeConditions(c, res, existing) : null;
    if (!data) return await postToWindows(failed);
    // Always send the snapshot: the page decides if it is newer than what it shows.
    await postToWindows({
      type: "ibd-fresh",
      kind: "conditions",
      slug: c.slug,
      changed: data.changed,
      delivered: false,
      data: data.json,
    });
  } catch (e) {
    await postToWindows(failed);
  }
}

// ---------------------------------------------------------------------------
// Messages from the page
// ---------------------------------------------------------------------------
self.addEventListener("message", function (event) {
  var msg = event.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "ibd-ping" && event.source) {
    event.source.postMessage({ type: "ibd-pong", version: VERSION, schema: SW_SCHEMA, killed: killed });
    return;
  }
  if (msg.type === "ibd-kill") {
    // The page asks the worker to stop (?nosw=1). It wipes its own caches, so no late write can bring them back.
    event.waitUntil(selfDestruct());
    return;
  }
  if (msg.type === "ibd-warm" && !killed && hasCaches()) {
    event.waitUntil(warm(msg));
  }
});

/**
 * First visit: the page was loaded before the worker took over, so nothing is cached yet.
 * The page lists the build files and the conditions call it made, and its own path.
 * Fetching them now (the build files come from the browser's own cache) makes the SECOND
 * open instant.
 */
async function warm(msg) {
  try {
    if (!(await storageOk())) return;
    var origin = self.location.origin;
    var saveData = saveDataOn(null);
    var assets = Array.isArray(msg.assets) ? msg.assets.slice(0, 60) : [];
    var statics = await caches.open(STATIC_CACHE);
    for (var i = 0; i < assets.length; i++) {
      if (typeof assets[i] !== "string") continue;
      var c = classify({ method: "GET", url: assets[i], origin: origin, mode: "no-cors", hasAuth: false, hasRange: false });
      if (!c) continue;
      try {
        if (c.kind === "static") {
          if (await statics.match(c.key, MATCH_OPTS)) continue;
          await putStatic(statics, c.key, await fetch(c.key, { cache: "force-cache", credentials: "omit" }));
        } else if (c.kind === "conditions" && !saveData) {
          var data = await caches.open(DATA_CACHE);
          if (await data.match(c.key, MATCH_OPTS)) continue;
          var res = await fetch(c.key, { cache: "no-store", credentials: "same-origin" });
          if (res.ok) await storeConditions(c, res, null);
        }
      } catch (e) {
        /* skip this file */
      }
    }
    if (saveData || typeof msg.path !== "string") return;
    var pc = classify({ method: "GET", url: origin + msg.path, origin: origin, mode: "navigate", hasAuth: false, hasRange: false });
    if (!pc || pc.kind !== "page") return;
    var pages = await caches.open(PAGE_CACHE);
    var have = await pages.match(pc.key, MATCH_OPTS);
    var at = cachedAtOf(have);
    if (have && at && Date.now() - at < 60 * 1000) return;
    await refreshPage(pc, have);
  } catch (e) {
    /* ignore */
  }
}
