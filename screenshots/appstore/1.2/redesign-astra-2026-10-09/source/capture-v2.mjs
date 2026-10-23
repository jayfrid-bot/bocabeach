// Full-page real-app captures (390x844 @3x, app UA) for the 2.3.3 rebuild: one PNG per frame plus
// the y offset (in image pixels) of the section each frame should open on.
import { chromium } from "@playwright/test";
import fs from "node:fs";
const ROOT = new URL("..", import.meta.url).pathname;
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 IsItBeachDayApp/ios";
const ONLY = process.argv[2]?.split(",");
const JOBS = [
  ["01", "/fort-myers-beach", null],
  ["04", "/deerfield-beach", "=Rip current risk"],
  ["05", "/boca-raton", "=Lightning — nearest strike"],
  ["06", "/boca-raton", "Beach & surf cams"],
  ["08", "/fort-myers-beach", "Upcoming sun"],
].filter(([n]) => !ONLY || ONLY.includes(n));
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, userAgent: UA, colorScheme: "light", isMobile: true, hasTouch: true });
await ctx.addInitScript(() => { try { localStorage.setItem("campaign-dismissed:woodward-2026", "1"); localStorage.setItem("theme", "light"); } catch {} });
const page = await ctx.newPage();
const offsets = {};
for (const [n, path, anchor] of JOBS) {
  await page.goto("https://app.isitbeachday.com" + path, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  for (let y = 0; y < 9000; y += 600) { await page.evaluate((y) => window.scrollTo(0, y), y); await page.waitForTimeout(150); }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1500);
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("body *")) {
      if (el.childElementCount <= 2 && /^\s*↓?\s*Pull to refresh\s*$/.test(el.textContent || "")) (el.closest("[class*='fixed'],[class*='sticky']") || el).style.display = "none";
    }
  });
  let y = 0;
  if (anchor) y = await page.evaluate((a) => {
    const exact = a.startsWith("=");
    const want = exact ? a.slice(1) : a;
    const els = [...document.querySelectorAll("h2,h3,span,div,p")].filter((e) => e.childElementCount < 4 && (exact ? (e.textContent || "").trim() === want : (e.textContent || "").trim().startsWith(want)));
    const el = exact ? els[els.length - 1] : els[0];
    return el ? Math.max(0, el.getBoundingClientRect().top + window.scrollY - 24) : 0;
  }, anchor);
  offsets[n] = Math.round(y * 3);
  await page.screenshot({ path: `${ROOT}assets/v2-${n}-app.png`, fullPage: true });
  console.log(n, path, anchor, "y", offsets[n]);
}
const prev = fs.existsSync(`${ROOT}assets/v2-offsets.json`) ? JSON.parse(fs.readFileSync(`${ROOT}assets/v2-offsets.json`, "utf8")) : {};
fs.writeFileSync(`${ROOT}assets/v2-offsets.json`, JSON.stringify({ ...prev, ...offsets }, null, 1));
await b.close();
