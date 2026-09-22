#!/usr/bin/env node
// Classifies NDBC station ids by whether their realtime2 feed currently reports
// significant wave height (WVHT, column index 8, 0-based, whitespace-split).
//
// Usage:
//   node scripts/ndbc_classify.mjs ID [ID...]
//   node scripts/ndbc_classify.mjs --file path/to/ids.txt   (one id per line)
//
// Prints one line per station: ID  waves=true|false|offline  detail
//
// "reports waves" = any of the newest 24 rows of the feed has a numeric WVHT.
// "offline" = the feed 404s or has no data rows at all.
//
// This is a read-only probe against https://www.ndbc.noaa.gov/data/realtime2/.
// It does not write anything — callers record the result in
// lib/sources/ndbcStations.ts's NDBC_STATION_REPORTS_WAVES map by hand.

function feedReportsWaves(text) {
  const rows = text
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .slice(0, 24);
  if (rows.length === 0) return { waves: false, offline: true };
  const waves = rows.some((row) => {
    const wvht = row.trim().split(/\s+/)[8];
    return wvht !== undefined && wvht !== "MM" && Number.isFinite(Number(wvht));
  });
  return { waves, offline: false };
}

async function classify(id) {
  const upper = id.toUpperCase();
  const url = `https://www.ndbc.noaa.gov/data/realtime2/${upper}.txt`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return { id, waves: false, offline: true, detail: `HTTP ${res.status}` };
    }
    const text = await res.text();
    const { waves, offline } = feedReportsWaves(text);
    return { id, waves, offline, detail: offline ? "no data rows" : `WVHT ${waves ? "numeric" : "MM"} on recent rows` };
  } catch (err) {
    return { id, waves: false, offline: true, detail: `fetch error: ${err.message}` };
  }
}

async function main() {
  const args = process.argv.slice(2);
  let ids = [];
  if (args[0] === "--file") {
    const fs = await import("node:fs");
    ids = fs
      .readFileSync(args[1], "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } else {
    ids = args;
  }
  if (ids.length === 0) {
    console.error("usage: node scripts/ndbc_classify.mjs ID [ID...]  |  --file ids.txt");
    process.exit(1);
  }
  for (const id of ids) {
    const r = await classify(id);
    console.log(`${r.id}\twaves=${r.offline ? "offline" : r.waves}\t${r.detail}`);
  }
}

main();
