// Regenerate all app icons from assets/icon.svg.
// Usage: node scripts/gen-icons.mjs   (sharp comes in via Next's dependency tree)
import sharp from "sharp";
import { readFileSync } from "node:fs";

const svg = readFileSync(new URL("../assets/icon.svg", import.meta.url));

const targets = [
  { out: "app/icon.png", size: 256 },
  { out: "app/apple-icon.png", size: 180 },
  { out: "public/icon-192.png", size: 192 },
  { out: "public/icon-512.png", size: 512 },
  // Maskable: same art, safe because key elements sit inside the inner 80%.
  { out: "public/icon-maskable.png", size: 512 },
];

for (const { out, size } of targets) {
  await sharp(svg, { density: 300 }).resize(size, size).png().toFile(out);
  console.log(`wrote ${out} (${size}x${size})`);
}
