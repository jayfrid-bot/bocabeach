// Browser tests for the repeat-open service worker (public/sw.js, docs/SERVICE_WORKER.md).
// Needs a production build, so it is skipped unless PW_SW_BASE_URL is set:
//   PW_SW_BASE_URL=http://localhost:8788 npx playwright test -c playwright.sw.config.ts
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const BASE = process.env.PW_SW_BASE_URL;
test.skip(!BASE, "set PW_SW_BASE_URL to a running production build to run the service worker tests");
test.describe.configure({ mode: "serial" });

const SCORE = '[aria-label="Beach Day score factors"]';

async function readyWorker(page: Page) {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 15_000 })
    .toBe(true);
}

/** Every URL in every ibd-* cache. */
async function cachedUrls(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const out: string[] = [];
    for (const n of await caches.keys()) {
      if (!n.startsWith("ibd-")) continue;
      const c = await caches.open(n);
      for (const r of await c.keys()) out.push(new URL(r.url).pathname);
    }
    return out;
  });
}

async function firstVisit(context: BrowserContext, path = "/") {
  const page = await context.newPage();
  await page.goto(path);
  await expect(page.locator(SCORE)).toBeVisible();
  await page.waitForFunction(() => !!navigator.serviceWorker, null, { timeout: 5000 });
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  // idle registration + claim + the warm-up fetches
  await expect.poll(async () => (await cachedUrls(page)).some((u) => u === path), { timeout: 20_000 }).toBe(true);
  return page;
}

test("registers, takes control, and warms the cache on the first visit", async ({ context }) => {
  const page = await firstVisit(context);
  await page.reload();
  await readyWorker(page);
  await expect.poll(async () => (await cachedUrls(page)).some((u) => u.startsWith("/api/conditions/")), { timeout: 15_000 }).toBe(true);
  const urls = await cachedUrls(page);
  expect(urls).toContain("/");
  expect(urls.some((u) => u.startsWith("/_next/static/"))).toBe(true);
});

test("a repeat open comes from the worker, shows the score at once, then updates in place", async ({ context }) => {
  const page = await firstVisit(context);
  await page.reload();
  await readyWorker(page);
  await page.close();

  // Age the saved data so the next open has something to catch up on: an older snapshot, saved 2 minutes ago.
  const seed = await context.newPage();
  await seed.goto("/");
  await readyWorker(seed);
  await seed.waitForTimeout(2500); // let this load's own background refresh finish before we age the copy
  const oldIso = await seed.evaluate(async () => {
    const names = (await caches.keys()).filter((n) => n.startsWith("ibd-data-"));
    const c = await caches.open(names[0]);
    const key = (await c.keys())[0];
    const res = (await c.match(key))!;
    const json = await res.clone().json();
    const old = new Date(Date.parse(json.snapshot.generatedAt) - 2 * 3600_000).toISOString();
    json.snapshot.generatedAt = old;
    const headers = new Headers(res.headers);
    headers.set("x-ibd-cached-at", String(Date.now() - 120_000));
    headers.set("x-ibd-hash", "old");
    await c.put(key, new Response(JSON.stringify(json), { status: 200, headers }));
    return old;
  });
  await seed.close();

  const again = await context.newPage();
  // Record every message the worker posts to the page.
  await again.addInitScript(() => {
    const w = window as unknown as { __msgs: { type: string; at?: string }[] };
    w.__msgs = [];
    navigator.serviceWorker.addEventListener("message", (e) =>
      w.__msgs.push({ type: e.data?.type, at: e.data?.data?.snapshot?.generatedAt }),
    );
  });
  await again.goto("/");
  await expect(again.locator(SCORE)).toBeVisible();
  const timing = await again.evaluate(() => {
    const n = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    return n.serverTiming.map((e) => e.name);
  });
  expect(timing).toContain("ibd-sw"); // the page itself came from the worker
  const agedStamp = new Date(oldIso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
  // The worker answered the first data call from its aged copy, then posted the fresh snapshot ...
  await expect
    .poll(() => again.evaluate(() => (window as unknown as { __msgs: { type: string; at?: string }[] }).__msgs.find((m) => m.type === "ibd-fresh")?.at ?? null), { timeout: 20_000 })
    .not.toBeNull();
  const freshAt = await again.evaluate(() => (window as unknown as { __msgs: { type: string; at?: string }[] }).__msgs.find((m) => m.type === "ibd-fresh")!.at!);
  expect(Date.parse(freshAt)).toBeGreaterThan(Date.parse(oldIso));
  // ... and the page now shows the fresh time, not the aged one.
  const footer = again.getByText(/data updated/);
  await expect(footer).toBeVisible();
  await expect(footer).not.toContainText(agedStamp);
});

test("the worker keeps its hands off everything that must stay live", async ({ context }) => {
  const page = await firstVisit(context);
  for (const p of ["/api/version", "/find", "/privacy", "/support", "/admin/review", "/api/history/boca-raton", "/mcp", "/api/v1/beaches", "/llms.txt", "/sw-kill", "/jupiter?x=1", "/api/conditions/boca-raton?fresh=1"]) {
    await page.goto(p).catch(() => {});
    await page.waitForTimeout(150);
  }
  await page.evaluate(() => fetch("/api/devices", { method: "POST", body: "{}" }).catch(() => {}));
  await page.evaluate(() => fetch("/api/version", { headers: { Authorization: "Bearer x" } }).catch(() => {}));
  const urls = await cachedUrls(page);
  const allowed = (u: string) => u === "/" || /^\/[a-z0-9-]+$/.test(u) || u.startsWith("/_next/static/") || u.startsWith("/api/conditions/") || u === "/__ibd/kill-check";
  const bad = urls.filter((u) => !allowed(u) || ["/find", "/privacy", "/support", "/admin", "/mcp", "/sw-kill"].includes(u));
  expect(bad).toEqual([]);
  expect(urls.filter((u) => u.startsWith("/api/") && !u.startsWith("/api/conditions/"))).toEqual([]);
});

test("works offline once visited", async ({ context }) => {
  const page = await firstVisit(context);
  await page.reload();
  await readyWorker(page);
  await page.close();
  await context.setOffline(true);
  const off = await context.newPage();
  await off.goto("/");
  await expect(off.locator(SCORE)).toBeVisible();
  await context.setOffline(false);
});

test("?nosw=1 removes the worker and its caches, and it stays off", async ({ context }) => {
  const page = await firstVisit(context);
  await page.reload();
  await readyWorker(page);
  await page.goto("/?nosw=1");
  await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), { timeout: 15_000 }).toBe(0);
  await expect.poll(async () => (await cachedUrls(page)).length, { timeout: 15_000 }).toBe(0);
  await page.goto("/");
  await page.waitForTimeout(3500);
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
  await page.goto("/?sw=on"); // undo
  await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), { timeout: 20_000 }).toBe(1);
});

// Needs a second production server started with the kill switch on:
//   npx wrangler dev --port 8789 --var SW_KILL:on     then  PW_SW_KILL_URL=http://localhost:8789
test("kill switch: with SW_KILL on, the worker removes itself and its caches", async ({ browser }) => {
  test.skip(!process.env.PW_SW_KILL_URL, "set PW_SW_KILL_URL to a production server running with SW_KILL=on");
  const killUrl = process.env.PW_SW_KILL_URL!;
  const res = await fetch(`${killUrl}/sw-kill`);
  expect(res.status).toBe(200);
  expect((await res.text()).trim()).toBe("kill");
  const context = await browser.newContext({ baseURL: killUrl });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.locator(SCORE)).toBeVisible();
  // The page registers the worker once it is idle; the worker asks /sw-kill when it activates and stops.
  await page.waitForTimeout(6000);
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
  await expect.poll(async () => (await cachedUrls(page)).length, { timeout: 15_000 }).toBe(0);
  await page.goto("/jupiter"); // and the site still works without it
  await expect(page.locator(SCORE)).toBeVisible();
  await context.close();
});
