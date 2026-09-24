#!/usr/bin/env node
// One-time (re-runnable) coverage-mapping script for NOAA's NWPS probabilistic
// rip current model. For every beach in config/locations.ts's listLocations(),
// finds which NWS office (WFO) publishes a CG1 5-minute rip-probability grid
// covering it, and the nearest grid point to the beach's shoreline, then
// writes the static result to config/nwpsRip.ts.
//
// Source layout (verified 2026-09-24):
//   https://nomads.ncep.noaa.gov/pub/data/nccf/com/nwps/prod/<region>.<YYYYMMDD>/<office>/<HH>/CG1/nwps.t<HH>z.5m_CG1_ripprob.<office>.txt
// Region dirs (er/sr/wr/pr/ar/ofs) each hold office subdirs; only offices
// whose latest run publishes a CG1 ripprob file actually run the rip model
// (it is not nationwide — coastal Atlantic/Gulf/Pacific/Hawaii WFOs only).
//
// Office lookup uses api.weather.gov/points/{lat},{lon} (NWS's own point
// metadata, properties.cwa) rather than guessing WFO boundaries by hand.
//
// Usage: node scripts/nwps_rip_map.mjs [--out config/nwpsRip.ts]
//
// Network-heavy (one api.weather.gov call + up to one ~2.5MB NOMADS file per
// DISTINCT office) but read-only; safe to re-run any time coverage may have
// changed (new WFO onboarded to the model, beach list grown, etc).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const NOMADS_BASE = "https://nomads.ncep.noaa.gov/pub/data/nccf/com/nwps/prod";
const REGIONS = ["sr", "er", "wr", "pr", "ar"]; // ofs is a different product family, skipped
const MAX_DIST_KM = 3;
const UA = { "User-Agent": "bocabeach-nwps-rip-map/1.0 (jayfrid@gmail.com)" };

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0088;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function fetchText(url, opts = {}) {
  const res = await fetch(url, { headers: UA, ...opts });
  if (!res.ok) return null;
  return res.text();
}

async function fetchJson(url) {
  const text = await fetchText(url, { headers: { ...UA, Accept: "application/geo+json" } });
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** office (3-letter WFO id, lowercase) covering (lat, lon), via NWS points API. */
async function cwaForPoint(lat, lon) {
  const j = await fetchJson(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`);
  const cwa = j?.properties?.cwa;
  return cwa ? cwa.toLowerCase() : null;
}

/** Latest date subdir (YYYYMMDD) listed under a region dir, or null. */
function latestDateDir(html, region) {
  const re = new RegExp(`href="${region}\\.(\\d{8})/"`, "g");
  const dates = [...html.matchAll(re)].map((m) => m[1]);
  if (!dates.length) return null;
  dates.sort();
  return dates[dates.length - 1];
}

/** Offices listed under a region's latest date dir. */
async function officesInRegion(region) {
  const rootHtml = await fetchText(`${NOMADS_BASE}/`);
  if (!rootHtml) return { date: null, offices: [] };
  const date = latestDateDir(rootHtml, region);
  if (!date) return { date: null, offices: [] };
  const dirHtml = await fetchText(`${NOMADS_BASE}/${region}.${date}/`);
  if (!dirHtml) return { date, offices: [] };
  const offices = [...dirHtml.matchAll(/href="([a-z0-9]+)\/"/g)].map((m) => m[1]);
  return { date, offices };
}

/** Latest available run hour (00 or 12, today then yesterday) with a CG1
 *  ripprob file for `region`/`office`, or null. Returns {date, hour, url}. */
async function latestRunFor(region, office, date) {
  for (const hh of ["12", "00"]) {
    const url = `${NOMADS_BASE}/${region}.${date}/${office}/${hh}/CG1/nwps.t${hh}z.5m_CG1_ripprob.${office}.txt`;
    const head = await fetch(url, { method: "HEAD", headers: UA }).catch(() => null);
    if (head?.ok) return { date, hour: hh, url };
  }
  return null;
}

/** Parse a CG1 ripprob file's distinct grid points. The file is laid out
 *  GROUPED BY POINT — each point's ~145 hourly rows appear consecutively,
 *  not grouped by timestamp — so distinct points are found by de-duping the
 *  (lon, lat) columns across the whole file, not by taking the first block
 *  of rows. Columns: DATE Xp(lon+360) Yp(lat) Prob Hs pp mwdsn tide event. */
function distinctPoints(text) {
  const seen = new Map();
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("%")) continue;
    const cols = t.split(/\s+/);
    const lon = Number(cols[1]) - 360; // file uses lon+360
    const lat = Number(cols[2]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const key = `${cols[1]},${cols[2]}`;
    if (!seen.has(key)) seen.set(key, { lon, lat });
  }
  return [...seen.values()];
}

const filePointsCache = new Map(); // url -> {lon, lat}[] (each office's file fetched once, reused per beach)

async function pointsForFile(url) {
  if (filePointsCache.has(url)) return filePointsCache.get(url);
  const text = await fetchText(url);
  const points = text ? distinctPoints(text) : [];
  filePointsCache.set(url, points);
  return points;
}

async function nearestPointInFile(url, lat, lon) {
  const points = await pointsForFile(url);
  if (!points.length) return null;
  let best = null;
  let bestKm = Infinity;
  for (const p of points) {
    const km = haversineKm(lat, lon, p.lat, p.lon);
    if (km < bestKm) {
      bestKm = km;
      best = p;
    }
  }
  if (!best) return null;
  return {
    lon: Math.round(best.lon * 10000) / 10000,
    lat: Math.round(best.lat * 10000) / 10000,
    distKm: Math.round(bestKm * 100) / 100,
  };
}

async function main() {
  const outArgIdx = process.argv.indexOf("--out");
  const outPath = path.resolve(
    ROOT,
    outArgIdx >= 0 ? process.argv[outArgIdx + 1] : "config/nwpsRip.ts",
  );

  // config/locations.ts is TS with no build step in this plain-Node script,
  // so beaches are read via a small regex scrape of the hand-curated file
  // plus the generated JSON (config/locations.generated.json) — the SAME two
  // sources listLocations() merges at runtime — keeping this dependency-free.
  const beaches = scrapeLocations();

  // Cache region office listings + per-office latest run, since many beaches
  // share an office and region dir listings are identical across offices.
  const regionOffices = {};
  for (const r of REGIONS) regionOffices[r] = await officesInRegion(r);

  const officeRegion = {};
  for (const r of REGIONS) for (const o of regionOffices[r].offices) officeRegion[o] = r;

  const runCache = new Map(); // office -> run info | null

  const result = {};
  let covered = 0;
  for (const b of beaches) {
    const cwa = await cwaForPoint(b.lat, b.lon);
    if (!cwa || !officeRegion[cwa]) continue;
    const region = officeRegion[cwa];
    if (!runCache.has(cwa)) {
      const date = regionOffices[region].date;
      const run = date ? await latestRunFor(region, cwa, date) : null;
      runCache.set(cwa, run);
    }
    const run = runCache.get(cwa);
    if (!run) continue;
    // pointsForFile caches the ~2.5MB file by URL, so beaches sharing an
    // office download it once; nearest-point search itself is per-beach.
    const point = await nearestPointInFile(run.url, b.lat, b.lon);
    if (!point || point.distKm > MAX_DIST_KM) continue;
    result[b.slug] = { region, office: cwa, lon: point.lon, lat: point.lat, distKm: point.distKm };
    covered++;
  }

  const lines = [];
  lines.push("// AUTO-GENERATED by scripts/nwps_rip_map.mjs — do not hand-edit.");
  lines.push("// Maps each beach slug to the NOAA NWPS office/region whose probabilistic");
  lines.push("// rip current model (CG1 ripprob grid) covers it, and the nearest model grid");
  lines.push("// point to that beach's shoreline (accepted only when <= 3 km away).");
  lines.push("// Regenerate with: node scripts/nwps_rip_map.mjs");
  lines.push("");
  lines.push("export interface NwpsRipCoverage {");
  lines.push("  region: string;");
  lines.push("  office: string;");
  lines.push("  lon: number;");
  lines.push("  lat: number;");
  lines.push("  distKm: number;");
  lines.push("}");
  lines.push("");
  lines.push("export const NWPS_RIP_COVERAGE: Record<string, NwpsRipCoverage> = {");
  for (const slug of Object.keys(result).sort()) {
    const c = result[slug];
    lines.push(
      `  "${slug}": { region: "${c.region}", office: "${c.office}", lon: ${c.lon}, lat: ${c.lat}, distKm: ${c.distKm} },`,
    );
  }
  lines.push("};");
  lines.push("");
  fs.writeFileSync(outPath, lines.join("\n"));
  console.log(`Wrote ${outPath}`);
  console.log(`Coverage: ${covered}/${beaches.length} beaches`);
  for (const slug of Object.keys(result).sort()) {
    const c = result[slug];
    console.log(`  ${slug}: ${c.office.toUpperCase()} (${c.region}) ${c.distKm} km`);
  }
}

function scrapeLocations() {
  const src = fs.readFileSync(path.join(ROOT, "config/locations.ts"), "utf8");
  const genPath = path.join(ROOT, "config/locations.generated.json");
  const gen = fs.existsSync(genPath) ? JSON.parse(fs.readFileSync(genPath, "utf8")) : [];
  const beaches = [];
  const seen = new Set();
  const blockRe = /slug:\s*"([^"]+)"[\s\S]*?lat:\s*(-?\d+(?:\.\d+)?),\s*\n\s*lon:\s*(-?\d+(?:\.\d+)?)/g;
  let m;
  while ((m = blockRe.exec(src))) {
    const [, slug, lat, lon] = m;
    if (seen.has(slug)) continue;
    seen.add(slug);
    beaches.push({ slug, lat: Number(lat), lon: Number(lon) });
  }
  for (const g of gen) {
    if (g?.slug && !seen.has(g.slug)) {
      seen.add(g.slug);
      beaches.push({ slug: g.slug, lat: g.lat, lon: g.lon });
    }
  }
  return beaches;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
