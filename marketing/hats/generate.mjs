import { chromium } from "@playwright/test";
import fs from "node:fs";
const OUT = process.argv[2];

// Embroidery rules this art obeys:
//  - FLAT spot colors only. No gradients, no opacity — a needle has one thread.
//  - 5 thread colors max.
//  - Nothing thinner than ~1.5 mm at final size. Canvas is 1200x600 px = 4"x2"
//    at 300 dpi, so 1 mm = 11.8 px and every stroke here is >= 22 px.
//  - Letters at least ~5 mm cap height or they stitch into mush.
const GOLD = "#F5B82E";       // sun + rays
const GOLD_DK = "#E09612";    // sun shadow notch (optional 5th color)
const AQUA = "#4FC3E8";       // top wave
const BLUE = "#1E7BB0";       // mid wave
const NAVY = "#10283A";       // deep wave + wordmark on light fabric
const CREAM = "#FFF6E3";      // wordmark on dark fabric

const fontCss = `@import url('https://fonts.googleapis.com/css2?family=Fredoka:wght@700&display=swap');`;
const FONT = `font-family="Fredoka, 'Arial Rounded MT Bold', Arial, sans-serif" font-weight="700"`;

/** Chunky sun: disc + 8 fat rays. cy/r in px. */
function sun(cx, cy, r) {
  // Five rays across the top arc only (-150deg .. -30deg). The sun is rising out
  // of the water: rays below the horizon read as clutter and tangled with the
  // wave bands in the first proof.
  const rays = Array.from({ length: 5 }, (_, i) => {
    const a = (-150 + i * 30) * (Math.PI / 180);
    const x1 = cx + Math.cos(a) * (r + 26), y1 = cy + Math.sin(a) * (r + 26);
    const x2 = cx + Math.cos(a) * (r + 62), y2 = cy + Math.sin(a) * (r + 62);
    return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${GOLD}" stroke-width="26" stroke-linecap="round"/>`;
  }).join("");
  return `${rays}<circle cx="${cx}" cy="${cy}" r="${r}" fill="${GOLD}"/>`;
}

/** Three fat wave bands, rounded caps, drawn as thick strokes so every line
 *  is a satin-stitch column an embroiderer can actually run. */
function waves(cx, y, w, dark = false) {
  const [c1, c2, c3] = dark ? ["#7FD9F0", "#35A3D4", "#1B7BAE"] : [AQUA, BLUE, NAVY];
  const band = (yy, color, amp) => {
    const half = w / 2, step = w / 4;
    let d = `M ${cx - half} ${yy}`;
    for (let i = 0; i < 4; i++) {
      const x0 = cx - half + i * step;
      d += ` Q ${x0 + step / 4} ${yy - amp} ${x0 + step / 2} ${yy} Q ${x0 + (step * 3) / 4} ${yy + amp} ${x0 + step} ${yy}`;
    }
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="34" stroke-linecap="round"/>`;
  };
  return band(y, c1, 26) + band(y + 52, c2, 26) + band(y + 104, c3, 26);
}

/** `light` = art for a stone/khaki cap (navy letters). Otherwise cream letters
 *  for a navy cap. */
function lockup(light) {
  const ink = light ? NAVY : CREAM;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600" viewBox="0 0 1200 600"><style>${fontCss}</style>
    ${sun(600, 150, 84)}
    ${waves(600, 268, 520, !light)}
    <text ${FONT} font-size="128" letter-spacing="4" fill="${ink}" text-anchor="middle" x="600" y="560">IS IT BEACH DAY?</text>
  </svg>`;
}

/** Icon only, for a side panel or the back. 2" x 1.4". */
function icon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="420" viewBox="0 0 600 420"><style>${fontCss}</style>
    ${sun(300, 130, 76)}
    ${waves(300, 240, 440, false)}
  </svg>`;
}

const art = { "hat-lockup-for-light-cap": lockup(true), "hat-lockup-for-navy-cap": lockup(false), "hat-icon-only": icon() };
const browser = await chromium.launch();
for (const [name, svg] of Object.entries(art)) {
  fs.writeFileSync(`${OUT}/isitbeachday-${name}.svg`, svg);
  const m = svg.match(/width="(\d+)" height="(\d+)"/);
  const w = +m[1], h = +m[2];
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  await page.setContent(`<!doctype html><html><head><style>${fontCss} html,body{margin:0}</style></head><body>${svg}</body></html>`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/isitbeachday-${name}.png`, clip: { x: 0, y: 0, width: w, height: h }, omitBackground: true });
  await page.close();
  console.log("wrote", name);
}

// Previews: the same art composited on real cap-fabric colors, at true size on
// a 4"-wide front panel, so the colour pairing can be judged before ordering.
const swatches = [
  ["preview-navy-cap", "#1B2A44", "hat-lockup-for-navy-cap"],
  ["preview-stone-cap", "#D9CFB8", "hat-lockup-for-light-cap"],
  ["preview-black-cap", "#1A1A1A", "hat-lockup-for-navy-cap"],
];
for (const [name, bg, src] of swatches) {
  const page = await browser.newPage({ viewport: { width: 1300, height: 760 }, deviceScaleFactor: 2 });
  const b64 = fs.readFileSync(`${OUT}/isitbeachday-${src}.png`).toString("base64");
  await page.setContent(`<!doctype html><html><body style="margin:0;background:${bg};display:grid;place-items:center;height:760px">
    <img src="data:image/png;base64,${b64}" style="width:1200px"/></body></html>`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/isitbeachday-${name}.png` });
  await page.close();
  console.log("wrote", name);
}
await browser.close();
