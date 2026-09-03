import { chromium } from "@playwright/test";
import fs from "node:fs";
const OUT = process.argv[2];
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("data:text/html,<canvas id=c></canvas>");
await page.addScriptTag({ url: "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js" });
await page.waitForFunction(() => typeof jsQR === "function", null, { timeout: 30000 });
for (const label of ["round-qr", "square-qr"]) {
  const b64 = fs.readFileSync(`${OUT}/isitbeachday-sticker-${label}.png`).toString("base64");
  for (const w of [600, 300, 220, 160, 120]) {
    const out = await page.evaluate(async ({ b64, w }) => {
      const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
      const c = document.getElementById("c"); c.width = w; c.height = w; const g = c.getContext("2d"); g.drawImage(img, 0, 0, w, w);
      const d = g.getImageData(0, 0, w, w); const r = jsQR(d.data, w, w); return r ? r.data : null;
    }, { b64, w });
    console.log(`${label} @${String(w).padStart(3)}px (${(w / 300).toFixed(2)}" @300dpi):`, out ?? "NOT READ");
  }
}
await browser.close();
