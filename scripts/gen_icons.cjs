// One-off icon generator for the PWA. Renders an inline SVG (dark-ocean
// background + sun + waves, matching the app's #061826 theme) to the PNG sizes
// the manifest / iOS / favicon need. Run: `node scripts/gen_icons.cjs`.
// Uses `sharp` (already present via Next) — no extra dependency.
const sharp = require("sharp");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");

const ROOT = join(__dirname, "..");

// Motif kept within the central ~70% so it survives Android's maskable crop.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0a4f73"/>
      <stop offset="1" stop-color="#061826"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <circle cx="256" cy="206" r="62" fill="#fbbf24"/>
  <g fill="none" stroke-width="24" stroke-linecap="round">
    <path d="M128 300 q32 -30 64 0 t64 0 t64 0 t64 0" stroke="#e8f6ff"/>
    <path d="M128 352 q32 -30 64 0 t64 0 t64 0 t64 0" stroke="#7cc6f2"/>
    <path d="M128 404 q32 -30 64 0 t64 0 t64 0 t64 0" stroke="#3f93c6"/>
  </g>
</svg>`;

const svgBuf = Buffer.from(svg);

async function png(size, outPath) {
  const buf = await sharp(svgBuf).resize(size, size).png().toBuffer();
  writeFileSync(outPath, buf);
  console.log(`wrote ${outPath} (${size}x${size}, ${buf.length} bytes)`);
}

(async () => {
  await png(192, join(ROOT, "public", "icon-192.png"));
  await png(512, join(ROOT, "public", "icon-512.png"));
  await png(512, join(ROOT, "public", "icon-maskable.png"));
  await png(180, join(ROOT, "app", "apple-icon.png")); // iOS home-screen
  await png(256, join(ROOT, "app", "icon.png")); // favicon (Next downscales)
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
