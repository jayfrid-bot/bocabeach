#!/usr/bin/env node
// Batch-seed the generated beach config by running the live resolver over a
// curated list of iconic US beaches (>=1 per coastal state), then writing the
// resolved Location objects to config/locations.generated.json — one file, one
// commit, all beaches live.
//
// Uses the same path the admin console uses: GET /api/resolve against a running
// dev/preview server (default http://localhost:3000). Start the server first:
//   npm run dev   # (or use the preview server)
//   node scripts/seed-locations.mjs
//
// Env:
//   SEED_BASE_URL   base URL of the running server (default http://localhost:3000)
//   SEED_DRY_RUN    if set, print the summary but don't write the file
//
// Idempotent-ish: re-running regenerates the file from scratch. Curated beaches
// already in config/locations.ts are deduped by slug at read time, so anything
// here that collides with a hand-curated slug is harmless — but we skip the few
// known curated ones (Boca) to avoid a confusing near-duplicate.

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BASE = process.env.SEED_BASE_URL ?? "http://localhost:3000";
const DRY = !!process.env.SEED_DRY_RUN;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "config", "locations.generated.json");

// Slugs already hand-curated in config/locations.ts — don't re-seed them.
const CURATED_SLUGS = new Set(["boca-raton"]);

// Curated national list. The Open-Meteo geocoder wants a bare place name (NOT
// "City, State" — the comma form fails to geocode), so these are bare beach /
// town names chosen to be unambiguous. Any that return a pick-list fall back to
// the nearest candidate (pick=0).
const QUERIES = [
  // Northeast / Mid-Atlantic
  "Old Orchard Beach",
  "Hampton Beach",
  "Misquamicut",
  "Hammonasset",
  "Coney Island",
  "Montauk",
  "Asbury Park",
  "Cape May",
  "Rehoboth Beach",
  "Virginia Beach",
  // Southeast
  "Nags Head",
  "Wrightsville Beach",
  "Myrtle Beach",
  "Folly Beach",
  "Tybee Island",
  "Jacksonville Beach",
  "Daytona Beach",
  "Cocoa Beach",
  "Miami Beach",
  "Naples",
  // Gulf
  "Gulf Shores",
  "Biloxi",
  "Galveston",
  "South Padre Island",
  "Grand Isle",
  // West Coast
  "La Jolla",
  "Santa Monica",
  "Huntington Beach",
  "Pismo Beach",
  "Santa Cruz",
  "Long Beach",
  // Pacific Northwest
  "Cannon Beach",
  "Seaside",
  "Ocean Shores",
  // Pacific
  "Waikiki",
];

async function resolveOne(q, pick) {
  const url = `${BASE}/api/resolve?q=${encodeURIComponent(q)}${pick !== undefined ? `&pick=${pick}` : ""}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Coarse US timezone from longitude/latitude — a *fallback only* for the rare
// beach-name-only resolve where the geocoder returned no tz. Every other beach
// keeps its real resolved IANA zone. An empty tz would crash Intl formatting on
// that beach's page, so we never ship one.
function tzFromLonLat(lon, lat) {
  if (lat > 50 && lon < -130) return "America/Anchorage"; // AK
  if (lon < -150) return "Pacific/Honolulu"; // HI
  if (lon < -115) return "America/Los_Angeles";
  if (lon < -101) return "America/Denver";
  if (lon < -87) return "America/Chicago";
  return "America/New_York";
}

function ensureUniqueSlug(slug, state, used) {
  if (!used.has(slug)) return slug;
  const st = (state ?? "").toLowerCase();
  let candidate = st ? `${slug}-${st}` : `${slug}-2`;
  let n = 2;
  while (used.has(candidate)) candidate = `${slug}-${n++}`;
  return candidate;
}

async function main() {
  // Reproducibility: the resolver derives unique slugs against the *currently
  // live* locations (curated + whatever's already in the generated file). If a
  // prior seed left this file populated, every name would collide and pick up an
  // ugly "-state" suffix. Reset to [] first and give the dev server a moment to
  // reload the now-empty file, so a fresh run always produces clean slugs.
  if (!DRY) {
    await writeFile(OUT, "[]\n");
    console.log("reset generated file → []; waiting for server reload…");
    await new Promise((r) => setTimeout(r, 3000));
  }

  const resolved = [];
  const used = new Set();
  const skipped = [];

  for (const q of QUERIES) {
    try {
      let r = await resolveOne(q);
      if (r.status === "pick-list") r = await resolveOne(q, 0); // take nearest candidate
      if (r.status !== "resolved" || !r.location) {
        skipped.push({ q, why: r.status, warnings: (r.warnings ?? []).map((w) => w.code) });
        continue;
      }
      const loc = r.location;
      const state = (loc.region.match(/\b([A-Z]{2})\s*$/) ?? [])[1];
      if (CURATED_SLUGS.has(loc.slug)) {
        skipped.push({ q, why: "curated-duplicate" });
        continue;
      }
      loc.slug = ensureUniqueSlug(loc.slug, state, used);
      if (!loc.timezone) {
        loc.timezone = tzFromLonLat(loc.lon, loc.lat);
        console.log(`    (tz fallback for ${loc.slug}: ${loc.timezone})`);
      }
      used.add(loc.slug);
      resolved.push(loc);
      console.log(`  ✓ ${q.padEnd(40)} → ${loc.slug}  (${loc.region})`);
    } catch (e) {
      skipped.push({ q, why: String(e) });
      console.log(`  ✗ ${q.padEnd(40)} → ${e}`);
    }
  }

  // Stable order for clean diffs: by region, then name.
  resolved.sort((a, b) => (a.region + a.name).localeCompare(b.region + b.name));

  console.log(`\nResolved ${resolved.length}/${QUERIES.length}. Skipped ${skipped.length}:`);
  for (const s of skipped) console.log(`  - ${s.q}: ${s.why}${s.warnings ? ` [${s.warnings.join(",")}]` : ""}`);

  if (DRY) {
    console.log("\n(dry run — not writing)");
    return;
  }
  await writeFile(OUT, JSON.stringify(resolved, null, 2) + "\n");
  console.log(`\nWrote ${resolved.length} beaches → ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
