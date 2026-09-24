#!/usr/bin/env node
// Preprocess job for NOAA's NWPS probabilistic rip current model (see
// scripts/nwps_rip_map.mjs's header for the source/file-layout writeup).
//
// The app must NOT download a ~2.5MB CG1 ripprob file per request, so this
// script (run on a schedule by .github/workflows/rip-nwps.yml, published to
// its OWN `rip-data` branch — deliberately NOT `sargassum-data`, which
// sargassum.yml/backfill-pct.yml force-push as a single-commit orphan every
// ~10 min and would silently wipe anything else published there) does it
// once per office and writes one small rip_nwps.json:
//
//   {
//     generatedAt: ISO,
//     beaches: {
//       <slug>: {
//         office, run (ISO of the model cycle used),
//         point: { lon, lat },
//         hours: [{ t (ISO), prob (0-100), hsFt, periodS, dirDeg }],  // next 72h
//       }
//     }
//   }
//
// For each DISTINCT office in config/nwpsRip.ts, finds the latest available
// run (today 12z -> today 00z -> yesterday 12z -> yesterday 00z), downloads
// its CG1 ripprob file ONCE, and extracts every beach mapped to that office.
// One fetch retry on failure; if an office still fails, that office's
// beaches carry forward their PREVIOUS published data (with its ORIGINAL run
// time — never stamped as fresh) rather than being dropped or faked.
//
// Usage: node scripts/rip_nwps.mjs --out path/to/rip_nwps.json [--prev path/to/previous_rip_nwps.json]
// Pure Node, no deps (matches ndbc_classify.mjs's convention).

import fs from "node:fs";
import path from "node:path";

const NOMADS_BASE = "https://nomads.ncep.noaa.gov/pub/data/nccf/com/nwps/prod";
const UA = { "User-Agent": "bocabeach-rip-nwps/1.0 (jayfrid@gmail.com)" };
const HOURS_TO_KEEP = 72;
const FETCH_TIMEOUT_MS = 20_000; // a ~2.5MB file over a slow link must not hang the job forever
const COVERAGE_HOURS = 24; // an accepted run must cover at least now..+24h somewhere in its grid
const POINT_TOLERANCE_DEG = 0.01; // ~1.1km — a found point must match the CONFIGURED grid point this tightly (item 2)

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0088;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function fetchTextOnce(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: UA, signal: controller.signal });
    if (!res.ok) return null;
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** One retry on failure/empty response, per spec. */
async function fetchTextWithRetry(url) {
  const first = await fetchTextOnce(url).catch(() => null);
  if (first) return first;
  return fetchTextOnce(url).catch(() => null);
}

function ymd(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

/** Candidate (date, hour) cycles in priority order: today 12z, today 00z,
 *  yesterday 12z, yesterday 00z. */
function candidateCycles(now) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const yesterday = new Date(today.getTime() - 86_400_000);
  return [
    { date: ymd(today), hour: "12" },
    { date: ymd(today), hour: "00" },
    { date: ymd(yesterday), hour: "12" },
    { date: ymd(yesterday), hour: "00" },
  ];
}

/**
 * Whether a parsed office file is usable (item 10): a non-empty grid, at
 * least one point whose valid-probability rows span from `now` through
 * `now + COVERAGE_HOURS`, without a gap. A file that downloaded fine but is
 * truncated, all-sentinel, or missing the near-term hours must NOT be
 * accepted as this cycle's run — the caller falls through to an older cycle,
 * and ultimately to carrying forward the previous publish, rather than ever
 * serving a broken or short-horizon file as if it were good.
 */
/** Whether one point's rows cover EVERY hour from `nowMs` through
 *  `+COVERAGE_HOURS`, with no gap. Shared by isRunUsable (office-level: does
 *  ANY point have this) and pointCoversWindow (item 2: does THIS beach's own
 *  configured point have this). */
function hasContinuousCoverage(rows, nowMs) {
  const neededHours = [];
  for (let h = 0; h <= COVERAGE_HOURS; h++) neededHours.push(Math.floor(nowMs / 3_600_000) * 3_600_000 + h * 3_600_000);
  const haveHours = new Set(rows.map((r) => Date.parse(r.t)));
  return neededHours.every((h) => haveHours.has(h));
}

function isRunUsable(byPoint, nowMs) {
  if (byPoint.size === 0) return false;
  for (const entry of byPoint.values()) {
    if (hasContinuousCoverage(entry.rows, nowMs)) return true;
  }
  return false;
}

/** Item 2: does THIS SPECIFIC point (the one matched to a beach's configured
 *  coordinate) have its own continuous now..+24h coverage — not just "some
 *  point in the grid", which isRunUsable already checked at the office level. */
function pointCoversWindow(point, nowMs) {
  return hasContinuousCoverage(point.rows, nowMs);
}

/**
 * Resolve ONE beach's entry for this cycle (item 2). `beach` is `{slug, lat,
 * lon, ...}` where lat/lon are the CONFIGURED grid point (config/nwpsRip.ts)
 * — not the beach's raw pin. Requires the nearest point actually found in
 * `byPoint` to be within POINT_TOLERANCE_DEG of that configured coordinate
 * AND to have its own continuous now..+24h coverage; a file that's
 * truncated/reshuffled and is missing the configured point (or has it but
 * short-horizon) must never silently substitute a different, possibly-
 * distant point. On failure, falls back to `prevEntry` (this beach's own
 * prior published entry, carried forward with its ORIGINAL run) — or `null`
 * when there's nothing to fall back to either.
 */
function resolveBeachEntry(beach, byPoint, prevEntry, nowMs, office, run) {
  const point = nearestPoint(byPoint, beach.lat, beach.lon);
  const withinTolerance =
    point &&
    Math.abs(point.lat - beach.lat) <= POINT_TOLERANCE_DEG &&
    Math.abs(point.lon - beach.lon) <= POINT_TOLERANCE_DEG;
  if (!point || !withinTolerance || !pointCoversWindow(point, nowMs)) {
    if (prevEntry) {
      console.error(`[rip_nwps] ${beach.slug}: configured point ${beach.lat},${beach.lon} not usable in this run — carried forward`);
    }
    return prevEntry ?? null;
  }
  const hours = point.rows
    .filter((r) => Date.parse(r.t) >= nowMs - 3_600_000) // keep the current hour + all future ones
    .sort((a, b2) => Date.parse(a.t) - Date.parse(b2.t))
    .slice(0, HOURS_TO_KEEP)
    .map((r) => ({
      t: r.t,
      prob: Math.round(r.prob * 10) / 10,
      // hsFt/periodS/dirDeg are best-effort (item 7: a bad/sentinel value for
      // one of them drops JUST that field, never the whole row — `prob` is
      // the only field resolution actually depends on).
      ...(Number.isFinite(r.hsFt) ? { hsFt: Math.round(r.hsFt * 100) / 100 } : {}),
      ...(Number.isFinite(r.periodS) ? { periodS: Math.round(r.periodS * 10) / 10 } : {}),
      ...(Number.isFinite(r.dirDeg) ? { dirDeg: Math.round(r.dirDeg) } : {}),
    }));
  return {
    office,
    run,
    point: { lon: Math.round(point.lon * 10000) / 10000, lat: Math.round(point.lat * 10000) / 10000 },
    hours,
  };
}

/** Finds + downloads the latest available, USABLE CG1 ripprob file for
 *  `region`/`office` — a cycle that fetches but fails the coverage/sanity
 *  check (item 10) is treated the same as a fetch failure and skipped in
 *  favor of an older cycle. */
async function latestOfficeFile(region, office, now) {
  for (const { date, hour } of candidateCycles(now)) {
    const url = `${NOMADS_BASE}/${region}.${date}/${office}/${hour}/CG1/nwps.t${hour}z.5m_CG1_ripprob.${office}.txt`;
    const text = await fetchTextWithRetry(url);
    if (!text) continue;
    const byPoint = parseByPoint(text);
    if (!isRunUsable(byPoint, now.getTime())) {
      console.error(`[rip_nwps] ${region}/${office} ${date} ${hour}z: fetched but failed sanity checks — trying an older cycle`);
      continue;
    }
    const runIso = new Date(Date.UTC(...isoParts(date), Number(hour), 0, 0)).toISOString();
    return { url, text, run: runIso, byPoint };
  }
  return null;
}

// `dateStr` is always "YYYYMMDD.HHMM" in UTC (confirmed against the file's
// own runtime — the 00z/12z cycle hour in the filename matches this column's
// first row exactly), so isoParts + Date.UTC below is correct with NO local-
// timezone/DST handling needed — a beach in any US timezone, DST or not,
// just converts this UTC instant to local for display (fmtTimeCompact etc).
function isoParts(yyyymmdd) {
  return [Number(yyyymmdd.slice(0, 4)), Number(yyyymmdd.slice(4, 6)) - 1, Number(yyyymmdd.slice(6, 8))];
}

/**
 * Parses the whole CG1 file into { pointKey: [{t, prob, hsFt, periodS, dirDeg, lon, lat}] },
 * grouped by grid point (file layout: each point's ~145 hourly rows appear
 * consecutively — see nwps_rip_map.mjs's distinctPoints for the same fact).
 *
 * The file's LAST column ("event") is a binary 0/1 flag, NOT currently
 * parsed or used — inspected 2026-09-24 against a real MFL file: event=1
 * rows average ~55% probability vs. ~13% for event=0 (23,397 rows at 0,
 * 3,573 at 1 in one file). This lines up with the Dusek & Seim model paper's
 * "72-hour postwave event window" input term (a forecast made shortly after
 * a significant wave event scores differently) — i.e. `event` likely marks
 * "within that post-event window", not a separate hazard signal of its own.
 * Left unused deliberately (out of scope for this pass): `prob` already
 * reflects whatever the model does with it internally.
 */
function parseByPoint(text) {
  const byPoint = new Map();
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("%")) continue;
    const cols = t.split(/\s+/);
    if (cols.length < 9) continue;
    const [dateStr, xp, yp, prob, hsM, pp, mwdsn] = cols;
    const lon = Number(xp) - 360;
    const lat = Number(yp);
    // Sane geographic bounds — a coastal US/PR/HI grid point, never a
    // sentinel/garbage coordinate slipping through as a "valid" number.
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    const dm = /^(\d{8})\.(\d{4})$/.exec(dateStr);
    if (!dm) continue;
    const [, ymdStr, hm] = dm;
    const hh = Number(hm.slice(0, 2));
    const mm = Number(hm.slice(2, 4));
    if (hh > 23 || mm > 59) continue; // malformed timestamp, not a real hour
    const iso = new Date(Date.UTC(...isoParts(ymdStr), hh, mm, 0)).toISOString();
    if (!Number.isFinite(Date.parse(iso))) continue;
    // Reject an out-of-range or sentinel probability outright — NOAA/NEC grid
    // products commonly fill missing/invalid cells with -999/-9999/9999 or
    // similar; a valid rip probability is always 0-100 inclusive. A bad prob
    // drops JUST this row (the point's other hours, and other points, are
    // unaffected), never gets clamped into range (that would silently invent
    // a plausible-looking but fake number).
    const probNum = Number(prob);
    if (!Number.isFinite(probNum) || probNum < 0 || probNum > 100) continue;
    const hsNum = Number(hsM);
    const ppNum = Number(pp);
    const dirNum = Number(mwdsn);
    const key = `${xp},${yp}`;
    if (!byPoint.has(key)) byPoint.set(key, { lon, lat, rows: [] });
    byPoint.get(key).rows.push({
      t: iso,
      prob: probNum,
      hsFt: Number.isFinite(hsNum) ? hsNum * 3.28084 : undefined,
      periodS: Number.isFinite(ppNum) ? ppNum : undefined,
      dirDeg: Number.isFinite(dirNum) ? dirNum : undefined,
    });
  }
  return byPoint;
}

function nearestPoint(byPoint, lat, lon) {
  let best = null;
  let bestKm = Infinity;
  for (const entry of byPoint.values()) {
    const km = haversineKm(lat, lon, entry.lat, entry.lon);
    if (km < bestKm) {
      bestKm = km;
      best = entry;
    }
  }
  return best;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name, def) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : def;
  };
  const outPath = path.resolve(flag("--out", "rip_nwps.json"));
  const prevPath = flag("--prev", null);
  const mapPath = flag("--map", null);

  const now = new Date();

  // Coverage map: prefer a JSON dump of config/nwpsRip.ts (--map), else parse
  // the TS source directly (dependency-free, mirrors nwps_rip_map.mjs).
  const coverage = mapPath
    ? JSON.parse(fs.readFileSync(mapPath, "utf8"))
    : parseCoverageTs(path.resolve("config/nwpsRip.ts"));

  const prev = prevPath && fs.existsSync(prevPath) ? JSON.parse(fs.readFileSync(prevPath, "utf8")) : null;

  const officeToBeaches = new Map();
  for (const [slug, c] of Object.entries(coverage)) {
    const key = `${c.region}/${c.office}`;
    if (!officeToBeaches.has(key)) officeToBeaches.set(key, []);
    officeToBeaches.get(key).push({ slug, ...c });
  }

  const beaches = {};
  let officesOk = 0;
  let officesFailed = 0;

  for (const [key, list] of officeToBeaches.entries()) {
    const [region, office] = key.split("/");
    const file = await latestOfficeFile(region, office, now);
    if (!file) {
      officesFailed++;
      // Carry forward this office's beaches from the previous publish,
      // keeping their ORIGINAL run time — never faking freshness.
      for (const b of list) {
        const carried = prev?.beaches?.[b.slug];
        if (carried) beaches[b.slug] = carried;
      }
      console.error(`[rip_nwps] ${key}: no run available, carried forward ${list.length} beach(es)`);
      continue;
    }
    officesOk++;
    const byPoint = file.byPoint; // already parsed + sanity-checked in latestOfficeFile
    for (const b of list) {
      const resolved = resolveBeachEntry(b, byPoint, prev?.beaches?.[b.slug], now.getTime(), office, file.run);
      if (resolved) beaches[b.slug] = resolved;
      else if (!prev?.beaches?.[b.slug]) {
        console.error(`[rip_nwps] ${b.slug}: configured point not usable — no previous data either, dropping`);
      }
    }
  }

  const out = { generatedAt: new Date().toISOString(), beaches };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out));
  console.log(
    `[rip_nwps] wrote ${outPath}: ${Object.keys(beaches).length} beach(es), ${officesOk} office(s) fresh, ${officesFailed} carried forward`,
  );
  return out;
}

function parseCoverageTs(tsPath) {
  const src = fs.readFileSync(tsPath, "utf8");
  const out = {};
  const re =
    /"([a-z0-9-]+)":\s*\{\s*region:\s*"([a-z]+)",\s*office:\s*"([a-z]+)",\s*lon:\s*(-?\d+(?:\.\d+)?),\s*lat:\s*(-?\d+(?:\.\d+)?),\s*distKm:\s*(-?\d+(?:\.\d+)?)\s*\}/g;
  let m;
  while ((m = re.exec(src))) {
    const [, slug, region, office, lon, lat, distKm] = m;
    out[slug] = { region, office, lon: Number(lon), lat: Number(lat), distKm: Number(distKm) };
  }
  return out;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export {
  parseByPoint,
  nearestPoint,
  candidateCycles,
  parseCoverageTs,
  isRunUsable,
  pointCoversWindow,
  resolveBeachEntry,
  POINT_TOLERANCE_DEG,
};
