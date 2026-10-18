#!/usr/bin/env node
// Repeat-open benchmark for the service worker (docs/SERVICE_WORKER.md).
// Run against a PRODUCTION build (the worker only registers in production):
//   npx opennextjs-cloudflare build && npx wrangler dev --port 8788 &
//   node scripts/sw-bench.mjs http://localhost:8788 [runs] [path]
// For each scenario it opens the page N times and reports the median and worst of:
//   score-dom   first moment the score wheel is in the page (MutationObserver)
//   fcp         first contentful paint
//   rendered    the dashboard's own "ibd:score-rendered" mark (after hydration + a paint)
//   ttfb        responseStart of the page request
import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "http://localhost:8788";
const runs = Number(process.argv[3] ?? 7);
const pagePath = process.argv[4] ?? "/";

const SLOW_3G = { offline: false, latency: 400, downloadThroughput: (500 * 1024) / 8, uploadThroughput: (500 * 1024) / 8 };
const FAST = { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };

const INIT = `
  window.__ibd = { scoreDom: null };
  const find = () => document.querySelector('[aria-label="Beach Day score factors"]');
  const note = () => { if (window.__ibd.scoreDom == null && find()) { window.__ibd.scoreDom = performance.now(); return true; } return false; };
  const mo = new MutationObserver(() => { if (note()) mo.disconnect(); });
  mo.observe(document, { childList: true, subtree: true });
`;

async function measure(page, url) {
  await page.addInitScript(INIT);
  const t0 = Date.now();
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => performance.getEntriesByName("ibd:score-rendered").length > 0, null, { timeout: 60000 });
  const m = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const fcp = performance.getEntriesByName("first-contentful-paint")[0];
    const mark = performance.getEntriesByName("ibd:score-rendered")[0];
    const st = nav.serverTiming?.find((e) => e.name === "ibd-sw");
    return {
      scoreDom: window.__ibd.scoreDom,
      fcp: fcp ? fcp.startTime : null,
      rendered: mark ? mark.startTime : null,
      ttfb: nav.responseStart,
      fromWorker: !!st,
    };
  });
  return { ...m, wall: Date.now() - t0 };
}

const med = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN; };
const worst = (a) => { const s = a.filter((x) => x != null); return s.length ? Math.max(...s) : NaN; };
const f = (n) => (Number.isFinite(n) ? `${n.toFixed(0)}ms` : "n/a").padStart(7);

async function scenario(browser, name, { workers, net, offline, warmUp = true }) {
  const ctx = await browser.newContext({ serviceWorkers: workers ? "allow" : "block", viewport: { width: 390, height: 844 }, userAgent: undefined });
  const url = base + pagePath;
  // Visit 1 on a normal network: this is the "last time" visit that fills the caches.
  if (warmUp) {
    const p = await ctx.newPage();
    await p.goto(url, { waitUntil: "load" });
    await p.waitForFunction(() => performance.getEntriesByName("ibd:score-rendered").length > 0, null, { timeout: 60000 });
    if (workers) {
      await p.evaluate(() => navigator.serviceWorker.ready.then(() => true));
      await p.waitForTimeout(4000); // let idle registration, claim and the warm-up fetches finish
    }
    await p.close();
  }
  const rows = [];
  for (let i = 0; i < runs; i++) {
    const p = await ctx.newPage();
    const cdp = await ctx.newCDPSession(p);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", offline ? { ...FAST, offline: true } : net);
    // The HTTP cache is part of what a real repeat visit has, so it is kept.
    rows.push(await measure(p, url));
    await cdp.detach().catch(() => {});
    await p.close();
    await new Promise((r) => setTimeout(r, 1500)); // let the background refresh finish before the next open
  }
  await ctx.close();
  const col = (k) => rows.map((r) => r[k]);
  console.log(
    `${name.padEnd(46)} score-dom ${f(med(col("scoreDom")))} (worst ${f(worst(col("scoreDom")))})  fcp ${f(med(col("fcp")))}  rendered ${f(med(col("rendered")))} (worst ${f(worst(col("rendered")))})  ttfb ${f(med(col("ttfb")))}  fromWorker ${rows.filter((r) => r.fromWorker).length}/${rows.length}`,
  );
  return rows;
}

const browser = await chromium.launch();
console.log(`# ${new Date().toISOString()}  base=${base}  path=${pagePath}  runs=${runs}  chromium ${browser.version()}`);
await scenario(browser, "no worker, fast network (HTTP cache only)", { workers: false, net: FAST });
await scenario(browser, "no worker, Slow 3G", { workers: false, net: SLOW_3G });
await scenario(browser, "service worker, fast network", { workers: true, net: FAST });
await scenario(browser, "service worker, Slow 3G", { workers: true, net: SLOW_3G });
await scenario(browser, "service worker, offline", { workers: true, offline: true });
await browser.close();
