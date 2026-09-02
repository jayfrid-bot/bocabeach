// Print-ready 2"x2" sticker art for Is It Beach Day. Canvas = 2.25" (2" + 1/8" bleed
// each side). Rendered at 600 DPI (1350 px) — plenty for any vendor; 300 DPI is 675 px.
import { chromium } from "@playwright/test";
import fs from "node:fs";
const OUT = process.argv[2];
const CX = 337.5, R_CUT = 300, R_SAFE = 262.5; // px at 300dpi within a 675 canvas

const defs = `
  <defs>
    <radialGradient id="sky" cx="50%" cy="62%" r="70%">
      <stop offset="0" stop-color="#1E5C8A"/><stop offset="0.55" stop-color="#0F2F4E"/><stop offset="1" stop-color="#081A2C"/>
    </radialGradient>
    <linearGradient id="sun" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFE38A"/><stop offset="0.5" stop-color="#F7C948"/><stop offset="1" stop-color="#F2A93B"/>
    </linearGradient>
    <linearGradient id="w1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5FD0EA"/><stop offset="1" stop-color="#3BB0D6"/></linearGradient>
    <linearGradient id="w2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2C8FC2"/><stop offset="1" stop-color="#1F6FA3"/></linearGradient>
    <linearGradient id="w3" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1A5F90"/><stop offset="1" stop-color="#123F66"/></linearGradient>
    <path id="arcTop" d="M ${CX-208} ${CX} A 208 208 0 0 1 ${CX+208} ${CX}"/>
    <path id="arcBot" d="M ${CX-232} ${CX} A 232 232 0 0 0 ${CX+232} ${CX}"/>
    <clipPath id="cutRound"><circle cx="${CX}" cy="${CX}" r="${R_CUT+38}"/></clipPath>
  </defs>`;

// Sun + rays + three wave bands; shared by both shapes. `sunY` = sun center y.
function scene(sunY, sunR, waveTop, second = true) {
  const rays = Array.from({ length: 16 }, (_, i) => {
    const a = (i / 16) * Math.PI * 2;
    const x1 = CX + Math.cos(a) * (sunR + 18), y1 = sunY + Math.sin(a) * (sunR + 18);
    const x2 = CX + Math.cos(a) * (sunR + 52), y2 = sunY + Math.sin(a) * (sunR + 52);
    return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#F7C948" stroke-width="9" stroke-linecap="round" opacity="${i % 2 ? 0.55 : 0.9}"/>`;
  }).join("");
  const wave = (y, amp, fill, phase) => {
    let d = `M -50 ${y}`;
    for (let x = -50; x <= 725; x += 25) d += ` L ${x} ${(y + Math.sin((x / 725) * Math.PI * 4 + phase) * amp).toFixed(1)}`;
    d += ` L 725 800 L -50 800 Z`;
    return `<path d="${d}" fill="${fill}"/>`;
  };
  return `
    <g>${rays}</g>
    <circle cx="${CX}" cy="${sunY}" r="${sunR}" fill="url(#sun)"/>
    <circle cx="${CX - sunR * 0.28}" cy="${sunY - sunR * 0.3}" r="${sunR * 0.34}" fill="#FFF1B8" opacity="0.55"/>
    ${wave(waveTop, 16, "url(#w1)", 0)}
    ${wave(waveTop + 48, 14, "url(#w2)", 1.6)}
    ${wave(waveTop + 96, 12, "url(#w3)", 3.1)}
    <path d="M ${CX-70} ${waveTop+24} q 18 -14 36 0 q 18 14 36 0" fill="none" stroke="#FFFFFF" stroke-width="7" stroke-linecap="round" opacity="0.9"/>
    ${second ? `<path d="M ${CX+40} ${waveTop+70} q 14 -11 28 0 q 14 11 28 0" fill="none" stroke="#FFFFFF" stroke-width="6" stroke-linecap="round" opacity="0.75"/>` : ""}`;
}

const fontCss = `@import url('https://fonts.googleapis.com/css2?family=Fredoka:wght@700&family=Nunito:wght@800&display=swap');`;
const text = (tag, extra) => `font-family="Fredoka, 'Arial Rounded MT Bold', Arial, sans-serif" font-weight="700" ${extra}`;

function round(guides) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="675" height="675" viewBox="0 0 675 675"><style>${fontCss}</style>${defs}
    <rect width="675" height="675" fill="url(#sky)"/>
    ${scene(392, 118, 468, false)}
    <text ${text()} font-size="54" letter-spacing="3" fill="#FFFFFF"><textPath href="#arcTop" startOffset="50%" text-anchor="middle">IS IT BEACH DAY?</textPath></text>
    <text font-family="Nunito, Arial, sans-serif" font-weight="800" font-size="30" letter-spacing="2" fill="#CFEFFF"><textPath href="#arcBot" startOffset="50%" text-anchor="middle">isitbeachday.com</textPath></text>
    ${guides ? `<circle cx="${CX}" cy="${CX}" r="${R_CUT}" fill="none" stroke="#FF3B3B" stroke-width="2" stroke-dasharray="8 6"/><circle cx="${CX}" cy="${CX}" r="${R_SAFE}" fill="none" stroke="#3BFF7A" stroke-width="2" stroke-dasharray="4 6"/><text x="12" y="24" font-family="Arial" font-size="16" fill="#FF3B3B">red = 2" cut line · green = safe zone · edge = bleed (2.25")</text>` : ""}
  </svg>`;
}

function square(guides) {
  const r = 75; // 0.25" corner radius on the cut
  return `<svg xmlns="http://www.w3.org/2000/svg" width="675" height="675" viewBox="0 0 675 675"><style>${fontCss}</style>${defs}
    <rect width="675" height="675" fill="url(#sky)"/>
    ${scene(400, 112, 470)}
    <text ${text()} font-size="78" letter-spacing="2" fill="#FFFFFF" text-anchor="middle" x="${CX}" y="150">IS IT</text>
    <text ${text()} font-size="78" letter-spacing="2" fill="#FFFFFF" text-anchor="middle" x="${CX}" y="232">BEACH DAY?</text>
    <text font-family="Nunito, Arial, sans-serif" font-weight="800" font-size="30" letter-spacing="2" fill="#CFEFFF" text-anchor="middle" x="${CX}" y="596">isitbeachday.com</text>
    ${guides ? `<rect x="37.5" y="37.5" width="600" height="600" rx="${r}" fill="none" stroke="#FF3B3B" stroke-width="2" stroke-dasharray="8 6"/><rect x="75" y="75" width="525" height="525" rx="${r-30}" fill="none" stroke="#3BFF7A" stroke-width="2" stroke-dasharray="4 6"/><text x="12" y="24" font-family="Arial" font-size="16" fill="#FF3B3B">red = 2" cut line (0.25" corners) · green = safe zone · edge = bleed</text>` : ""}
  </svg>`;
}

const variants = { "round": round(false), "round-guides": round(true), "square": square(false), "square-guides": square(true) };
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 675, height: 675 }, deviceScaleFactor: 2 });
for (const [name, svg] of Object.entries(variants)) {
  fs.writeFileSync(`${OUT}/isitbeachday-sticker-${name}.svg`, svg);
  await page.setContent(`<!doctype html><html><head><style>${fontCss} html,body{margin:0;background:#fff}</style></head><body>${svg}</body></html>`);
  await page.waitForTimeout(1500); // let Google Fonts load
  await page.screenshot({ path: `${OUT}/isitbeachday-sticker-${name}.png`, clip: { x: 0, y: 0, width: 675, height: 675 }, omitBackground: true });
  console.log("wrote", name);
}
await browser.close();
