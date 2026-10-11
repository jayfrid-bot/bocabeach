// Regenerate config/archive-cams.json from config/locations.ts.
//
//   npx vite-node -c vitest.config.ts scripts/gen_archive_cams.ts
//
// scripts/cam_seaweed.py reads that JSON (plain stdlib json, no TypeScript).
// lib/camFrames/manifest.test.ts fails when the file and locations.ts differ.

import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildArchiveManifestJson } from "@/lib/camFrames/manifest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "config", "archive-cams.json");
const manifest = buildArchiveManifestJson();
writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
console.error(`wrote ${out} (${manifest.cams.length} cams)`);
