import { chromium } from "@playwright/test";
import fs from "node:fs";
const dir = process.argv[2];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 3000, height: 3000 } });
for (const name of (process.argv[3] ?? "tattoo-black,tattoo-color").split(",")) {
  const svg = fs.readFileSync(`${dir}/${name}.svg`, "utf8").replace(/width="512" height="(\d+)"/, (_, h) => `width="3000" height="${Math.round(3000 * Number(h) / 512)}"`);
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
  await page.locator("svg").screenshot({ path: `${dir}/${name}.png`, omitBackground: true });
}
await browser.close();
