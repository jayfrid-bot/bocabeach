// Writes ios/App/WatchShared/Beaches.json — the beach list bundled into the
// Apple Watch app (picker + "Nearest"). Run after adding a beach:
//   node scripts/ios-watch/export-beaches.mjs
// The watch app ships this list inside its binary, so a beach added through
// the admin console reaches the watch only with the next iPhone-app release.
import { build } from "esbuild";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const out = join(mkdtempSync(join(tmpdir(), "beaches-")), "locations.mjs");

await build({
  entryPoints: [join(root, "config/locations.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: out,
  alias: { "@": root },
  loader: { ".json": "json" },
  logLevel: "error",
});

const { listLocations, toPublicLocation } = await import(pathToFileURL(out).href);
const round = (n) => Math.round(n * 10000) / 10000;
const beaches = listLocations()
  .map(toPublicLocation)
  .map((b) => ({
    slug: b.slug,
    name: b.name,
    region: b.region,
    lat: round(b.lat),
    lon: round(b.lon),
    ...(b.shore?.length ? { shore: b.shore.map(([la, lo]) => [round(la), round(lo)]) } : {}),
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

writeFileSync(join(root, "ios/App/WatchShared/Beaches.json"), JSON.stringify(beaches, null, 1) + "\n");
console.log(`Wrote ${beaches.length} beaches`);
