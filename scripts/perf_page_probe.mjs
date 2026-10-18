#!/usr/bin/env node
// Browser load probe for Is It Beach Day (see docs/benchmarks/2026-10-18-perf/).
//
// scripts/perf_probe.sh times the network (curl). This one loads the page in a real
// Chromium and reports what a phone would feel: first/largest paint, bytes on the
// wire, JavaScript bytes, layout shift, long-task time and when React finished
// hydrating. It starts every run from an empty cache.
//
//   node scripts/perf_page_probe.mjs <base-url> [path] [runs] [profile]
//
//   profile  "none"   no throttling
//            "phone"  Fast 3G (1.6 Mbit/s down, 750 kbit/s up, 150 ms RTT) and 4x slower CPU
//                     (Lighthouse's mobile profile)
//
// The visitor is NOT marked as automated: the real page loads PostHog for people, and
// skips it only for navigator.webdriver, so this probe hides that flag to measure what
// a visitor downloads. Set PROBE_ANALYTICS=0 to leave it visible instead.
//
// The page quietly asks for two share-card pictures ~1 s after load (to warm the server's
// cache). Rendering them is seconds of CPU on a single-process `next start` and would slow
// the next run's first byte, so the probe cancels those requests (and counts them, with
// their method, as shareWarm). Set PROBE_ALLOW_SHARE=1 to let them through.
//
// Output: one JSON object per run on stderr, then a median table on stdout.

import { chromium } from "@playwright/test";

const [base = "http://localhost:3100", path = "/", runsArg = "5", profile = "phone"] = process.argv.slice(2);
const runs = Number(runsArg);
const withAnalytics = process.env.PROBE_ANALYTICS !== "0";

const PROFILES = {
  none: null,
  phone: { down: (1.6 * 1024 * 1024) / 8, up: (750 * 1024) / 8, rtt: 150, cpu: 4 },
};
if (!(profile in PROFILES)) throw new Error(`profile must be one of ${Object.keys(PROFILES).join(", ")}`);

const median = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};

async function once(browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  });
  const page = await context.newPage();
  if (withAnalytics) {
    await page.addInitScript(() => Object.defineProperty(navigator, "webdriver", { get: () => false }));
  }
  const shareWarm = [];
  if (process.env.PROBE_ALLOW_SHARE !== "1") {
    await page.route("**/api/share/**", (route) => {
      shareWarm.push(route.request().method());
      return route.abort();
    });
  }
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  const p = PROFILES[profile];
  if (p) {
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: p.rtt,
      downloadThroughput: p.down,
      uploadThroughput: p.up,
    });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: p.cpu });
  }

  // Bytes on the wire, per request (includes headers), tagged by resource type.
  const reqs = new Map();
  cdp.on("Network.requestWillBeSent", (e) => reqs.set(e.requestId, { url: e.request.url, type: e.type, bytes: 0 }));
  cdp.on("Network.loadingFinished", (e) => {
    const r = reqs.get(e.requestId);
    if (r) r.bytes = e.encodedDataLength;
  });

  await page.addInitScript(() => {
    const m = { lcp: null, lcpEl: null, fcp: null, cls: 0, longTaskMs: 0, hydratedAt: null };
    window.__probe = m;
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        m.lcp = e.startTime;
        m.lcpEl = e.element ? e.element.tagName + (e.element.id ? "#" + e.element.id : "") : null;
      }
    }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (e.name === "first-contentful-paint") m.fcp = e.startTime;
    }).observe({ type: "paint", buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (!e.hadRecentInput) m.cls += e.value;
    }).observe({ type: "layout-shift", buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) m.longTaskMs += Math.max(0, e.duration - 50);
    }).observe({ type: "longtask", buffered: true });
    // React puts __reactFiber$… on every DOM node it has hydrated.
    const t = setInterval(() => {
      const el = document.querySelector("main");
      if (el && Object.keys(el).some((k) => k.startsWith("__reactFiber"))) {
        m.hydratedAt = performance.now();
        clearInterval(t);
      }
    }, 25);
  });

  const t0 = Date.now();
  const resp = await page.goto(base + path, { waitUntil: "load", timeout: 120_000 });
  const loadMs = Date.now() - t0;
  // Let hydration, the first poll and any idle-time chunks finish before reading.
  await page.waitForFunction(() => window.__probe.hydratedAt != null, null, { timeout: 120_000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const probe = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    return {
      ...window.__probe,
      ttfb: nav.responseStart,
      domContentLoaded: nav.domContentLoadedEventEnd,
      loadEvent: nav.loadEventEnd,
    };
  });
  const verdictInHtml = await resp.text().then((h) => /Absolutely!|Yes — good beach day|Decent|Likely not|Definitely not/.test(h)).catch(() => null);

  let total = 0, js = 0, jsN = 0, n = 0, api = 0;
  for (const r of reqs.values()) {
    if (!r.bytes) continue;
    n++;
    total += r.bytes;
    if (r.type === "Script") {
      js += r.bytes;
      jsN++;
    }
    if (/\/api\//.test(r.url)) api += r.bytes;
  }
  await context.close();
  return {
    ttfb: Math.round(probe.ttfb),
    fcp: Math.round(probe.fcp ?? 0),
    lcp: Math.round(probe.lcp ?? 0),
    lcpEl: probe.lcpEl,
    hydratedMs: probe.hydratedAt == null ? null : Math.round(probe.hydratedAt),
    dcl: Math.round(probe.domContentLoaded),
    load: Math.round(probe.loadEvent),
    cls: Number(probe.cls.toFixed(4)),
    longTaskMs: Math.round(probe.longTaskMs),
    requests: n,
    totalKB: Number((total / 1024).toFixed(1)),
    jsKB: Number((js / 1024).toFixed(1)),
    jsFiles: jsN,
    apiKB: Number((api / 1024).toFixed(1)),
    wallMs: loadMs,
    shareWarm: shareWarm.join(","),
    verdictInHtml,
  };
}

const browser = await chromium.launch();
const results = [];
for (let i = 0; i < runs; i++) {
  const r = await once(browser);
  results.push(r);
  console.error(JSON.stringify(r));
}
await browser.close();

const keys = ["ttfb", "fcp", "lcp", "hydratedMs", "load", "cls", "longTaskMs", "requests", "totalKB", "jsKB", "jsFiles", "apiKB"];
console.log(`${base}${path}  profile=${profile}  runs=${runs}  analytics=${withAnalytics ? "on" : "off"}`);
for (const k of keys) console.log(`${k.padEnd(12)} ${median(results.map((r) => r[k]))}`);
console.log(`lcp element  ${results.map((r) => r.lcpEl).join(" ")}`);
console.log(`share warm   ${results[0].shareWarm || "(allowed through)"}`);
console.log(`verdict in server HTML: ${results.every((r) => r.verdictInHtml)}`);
