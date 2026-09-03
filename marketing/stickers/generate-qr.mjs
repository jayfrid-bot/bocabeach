import { chromium } from "@playwright/test";
import fs from "node:fs";
const OUT = process.argv[2];
const CX = 337.5, R_CUT = 300, R_SAFE = 262.5;
const QR = JSON.parse(fs.readFileSync(`${OUT}/qr.json`, "utf8"));

const fontCss = `@import url('https://fonts.googleapis.com/css2?family=Fredoka:wght@700&family=Nunito:wght@800&display=swap');`;
const defs = `<defs>
  <radialGradient id="sky" cx="50%" cy="55%" r="70%"><stop offset="0" stop-color="#1E5C8A"/><stop offset="0.55" stop-color="#0F2F4E"/><stop offset="1" stop-color="#081A2C"/></radialGradient>
  <linearGradient id="sun" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFE38A"/><stop offset="0.5" stop-color="#F7C948"/><stop offset="1" stop-color="#F2A93B"/></linearGradient>
  <linearGradient id="w1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5FD0EA"/><stop offset="1" stop-color="#3BB0D6"/></linearGradient>
  <linearGradient id="w2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2C8FC2"/><stop offset="1" stop-color="#1F6FA3"/></linearGradient>
  <linearGradient id="w3" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1A5F90"/><stop offset="1" stop-color="#123F66"/></linearGradient>
  <path id="arcTop" d="M ${CX-208} ${CX} A 208 208 0 0 1 ${CX+208} ${CX}"/>
  <path id="arcBot" d="M ${CX-232} ${CX} A 232 232 0 0 0 ${CX+232} ${CX}"/>
</defs>`;
const head = (extra = "") => `font-family="Fredoka, 'Arial Rounded MT Bold', Arial, sans-serif" font-weight="700" ${extra}`;

function waves(top) {
  const wave = (y, amp, fill, phase) => { let d = `M -50 ${y}`; for (let x = -50; x <= 725; x += 25) d += ` L ${x} ${(y + Math.sin((x / 725) * Math.PI * 4 + phase) * amp).toFixed(1)}`; return `<path d="${d} L 725 800 L -50 800 Z" fill="${fill}"/>`; };
  return wave(top, 16, "url(#w1)", 0) + wave(top + 48, 14, "url(#w2)", 1.6) + wave(top + 96, 12, "url(#w3)", 3.1);
}

/** QR panel: white rounded square `size` px centered at (cx, cy); 4-module quiet zone
 *  inside the panel; small sun logo over the centre (EC level H tolerates far more). */
function qrPanel(cx, cy, size, sunRays = true) {
  const n = QR.size, quiet = 4, cells = n + quiet * 2, cell = size / cells;
  const x0 = cx - size / 2, y0 = cy - size / 2;
  const logoCells = 9; // 9x9 modules under the logo = ~10% of the symbol, well under H's 30%
  const lo = Math.floor((n - logoCells) / 2), hi = lo + logoCells;
  let rects = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!QR.matrix[r][c]) continue;
    if (r >= lo && r < hi && c >= lo && c < hi) continue; // cleared under the logo
    rects += `<rect x="${(x0 + (c + quiet) * cell).toFixed(2)}" y="${(y0 + (r + quiet) * cell).toFixed(2)}" width="${(cell + 0.15).toFixed(2)}" height="${(cell + 0.15).toFixed(2)}" fill="#0B1E33"/>`;
  }
  const lr = (logoCells * cell) / 2; // logo radius = half the cleared block
  const rays = sunRays ? Array.from({ length: 16 }, (_, i) => { const a = (i / 16) * Math.PI * 2, r1 = size / 2 + 16, r2 = size / 2 + 44; return `<line x1="${(cx + Math.cos(a) * r1).toFixed(1)}" y1="${(cy + Math.sin(a) * r1).toFixed(1)}" x2="${(cx + Math.cos(a) * r2).toFixed(1)}" y2="${(cy + Math.sin(a) * r2).toFixed(1)}" stroke="#F7C948" stroke-width="9" stroke-linecap="round" opacity="${i % 2 ? 0.55 : 0.9}"/>`; }).join("") : "";
  return `${rays}
    <rect x="${x0}" y="${y0}" width="${size}" height="${size}" rx="${size * 0.09}" fill="#FFFFFF"/>
    ${rects}
    <circle cx="${cx}" cy="${cy}" r="${(lr * 0.78).toFixed(1)}" fill="url(#sun)"/>
    <circle cx="${(cx - lr * 0.22).toFixed(1)}" cy="${(cy - lr * 0.24).toFixed(1)}" r="${(lr * 0.26).toFixed(1)}" fill="#FFF1B8" opacity="0.6"/>`;
}

function round(guides) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="675" height="675" viewBox="0 0 675 675"><style>${fontCss}</style>${defs}
    <rect width="675" height="675" fill="url(#sky)"/>
    ${waves(478)}
    ${qrPanel(CX, 352, 262)}
    <text ${head()} font-size="54" letter-spacing="3" fill="#FFFFFF"><textPath href="#arcTop" startOffset="50%" text-anchor="middle">IS IT BEACH DAY?</textPath></text>
    <text font-family="Nunito, Arial, sans-serif" font-weight="800" font-size="30" letter-spacing="2" fill="#FFFFFF"><textPath href="#arcBot" startOffset="50%" text-anchor="middle">isitbeachday.com</textPath></text>
    ${guides ? `<circle cx="${CX}" cy="${CX}" r="${R_CUT}" fill="none" stroke="#FF3B3B" stroke-width="2" stroke-dasharray="8 6"/><circle cx="${CX}" cy="${CX}" r="${R_SAFE}" fill="none" stroke="#3BFF7A" stroke-width="2" stroke-dasharray="4 6"/>` : ""}
  </svg>`;
}
function square(guides) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="675" height="675" viewBox="0 0 675 675"><style>${fontCss}</style>${defs}
    <rect width="675" height="675" fill="url(#sky)"/>
    ${waves(486)}
    ${qrPanel(CX, 372, 262)}
    <text ${head()} font-size="62" letter-spacing="2" fill="#FFFFFF" text-anchor="middle" x="${CX}" y="128">IS IT</text>
    <text ${head()} font-size="62" letter-spacing="2" fill="#FFFFFF" text-anchor="middle" x="${CX}" y="194">BEACH DAY?</text>
    <text font-family="Nunito, Arial, sans-serif" font-weight="800" font-size="30" letter-spacing="2" fill="#FFFFFF" text-anchor="middle" x="${CX}" y="584">isitbeachday.com</text>
    ${guides ? `<rect x="37.5" y="37.5" width="600" height="600" rx="75" fill="none" stroke="#FF3B3B" stroke-width="2" stroke-dasharray="8 6"/><rect x="75" y="75" width="525" height="525" rx="45" fill="none" stroke="#3BFF7A" stroke-width="2" stroke-dasharray="4 6"/>` : ""}
  </svg>`;
}

const variants = { "round-qr": round(false), "round-qr-guides": round(true), "square-qr": square(false), "square-qr-guides": square(true) };
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 675, height: 675 }, deviceScaleFactor: 2 });
for (const [name, svg] of Object.entries(variants)) {
  fs.writeFileSync(`${OUT}/isitbeachday-sticker-${name}.svg`, svg);
  await page.setContent(`<!doctype html><html><head><style>${fontCss} html,body{margin:0;background:#fff}</style></head><body>${svg}</body></html>`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/isitbeachday-sticker-${name}.png`, clip: { x: 0, y: 0, width: 675, height: 675 } });
  console.log("wrote", name);
}
// Scan test: decode the rendered art with jsQR at print size (600px = 2" @300dpi) and at
// phone-camera-ish sizes (300px, 220px) to prove it reads even small/far.
const png = fs.readFileSync(`${OUT}/isitbeachday-sticker-round-qr.png`).toString("base64");
const png2 = fs.readFileSync(`${OUT}/isitbeachday-sticker-square-qr.png`).toString("base64");
await page.setContent(`<script src="https://cdnjs.cloudflare.com/ajax/libs/jsQR/1.4.0/jsQR.min.js"></script><canvas id="c"></canvas>`);
await page.waitForFunction(() => typeof jsQR === "function");
for (const [label, b64] of [["round", png], ["square", png2]]) for (const w of [600, 300, 220, 160]) {
  const out = await page.evaluate(async ({ b64, w }) => {
    const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
    const c = document.getElementById("c"); c.width = w; c.height = w; const g = c.getContext("2d"); g.drawImage(img, 0, 0, w, w);
    const d = g.getImageData(0, 0, w, w); const r = jsQR(d.data, w, w); return r ? r.data : null;
  }, { b64, w });
  console.log(`scan ${label} @${w}px (${(w / 300).toFixed(2)}" at 300dpi):`, out ?? "NOT READ");
}
await browser.close();
