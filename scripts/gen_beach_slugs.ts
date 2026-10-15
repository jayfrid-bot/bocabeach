// Regenerate config/beach-slugs.json from config/locations.ts (the curated list plus the beaches the admin console
// added).
//
//   npx vite-node -c vitest.config.ts scripts/gen_beach_slugs.ts
//
// lib/push/native.ts opens a tapped notification's beach page from this compact set, with nothing to load, so a
// tap works even if a lazy chunk is gone after a deploy. lib/push/beachSlugs.test.ts fails when the file and
// locations.ts differ.

import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listLocations } from "@/config/locations";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "config", "beach-slugs.json");
const slugs = listLocations().map((l) => l.slug).sort();
writeFileSync(out, JSON.stringify(slugs) + "\n");
console.error(`wrote ${out} (${slugs.length} beaches)`);
