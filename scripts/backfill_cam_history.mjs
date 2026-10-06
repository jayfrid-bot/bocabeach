#!/usr/bin/env node
// Backfill `cam_observations` (migrations/0006_history.sql) from the already-
// published cam-vision feeds — the rolling `history` array each beach's
// cam_seaweed.<slug>.json already carries (see lib/sources/sargassum.ts /
// busyness.ts / clarity.ts, which read the same feeds for the live UI).
//
// This NEVER creates beach_hourly rows — cam reads alone (crowd/seaweed/
// clarity) are not a Beach Day score, and fabricating one from cam data only
// would misrepresent history that was never actually shown to a visitor.
//
// Usage:
//   node scripts/backfill_cam_history.mjs                  # print SQL to stdout
//   node scripts/backfill_cam_history.mjs --slug boca-raton # one beach only
//   node scripts/backfill_cam_history.mjs --apply-local     # also run it against
//                                                            # the local D1 (wrangler)
//
// Feeds (see lib/sources/camFeed.ts for the same URLs the live app reads):
//   boca-raton        cam_seaweed.json                  (legacy single-file feed)
//   everyone else      cam_seaweed.<slug>.json
//
// Each `history` entry's `t` field is an offset-bearing local ISO timestamp,
// e.g. "2026-06-04T13:00-04:00" — `parseCapturedAtUtc` converts it to a UTC
// ISO string, which is what `cam_observations.captured_at_utc` (and the
// primary key) is keyed by. Needs migration 0014 applied (crowd_level,
// uw_level columns). The hourly archiver keeps this table current from here on.

import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FEED_BASE =
  process.env.CAM_SEAWEED_FEED_BASE ??
  "https://raw.githubusercontent.com/jayfrid-bot/bocabeach/sargassum-data";

/** Beaches known to publish a cam-vision feed today (docs/HISTORY_AND_IMAGERY_PLAN.md
 *  measured this 2026-09-20: Boca 1,073 reads, Deerfield 17, Fort Lauderdale 4). */
export const KNOWN_SLUGS = ["boca-raton", "deerfield-beach", "fort-lauderdale"];

/** Feed URL for one slug — boca-raton uses the legacy single-file feed, per
 *  the ticket; every other beach uses its own per-beach file. */
export function feedUrlFor(slug) {
  return slug === "boca-raton" ? `${FEED_BASE}/cam_seaweed.json` : `${FEED_BASE}/cam_seaweed.${slug}.json`;
}

// parseCapturedAtUtc / rowFromHistoryEntry live in ONE shared module, also
// imported by the hourly archiver (lib/history/camObservations.ts), so the
// one-shot backfill and the continuous writer can never drift.
import { parseCapturedAtUtc, rowFromHistoryEntry } from "../lib/history/camObservationRow.mjs";
export { parseCapturedAtUtc, rowFromHistoryEntry };

/** SQL-escape a string literal (single-quote doubling — the only special
 *  character SQLite string literals need escaped). */
function sqlStr(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}
function sqlVal(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return sqlStr(v);
}

const COLS = [
  "slug", "captured_at_utc", "crowd_pct", "people", "seaweed_level", "cov_pct",
  "clarity_pct", "water_word", "uw_pct", "source", "raw_json", "crowd_level", "uw_level",
];

/** One row -> an idempotent INSERT statement (PK collision = already imported). */
export function insertSqlFor(row) {
  const values = COLS.map((c) => sqlVal(row[c])).join(", ");
  return `INSERT OR IGNORE INTO cam_observations (${COLS.join(", ")}) VALUES (${values});`;
}

async function fetchFeed(slug) {
  const url = feedUrlFor(slug);
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`  ${slug}: ${url} -> HTTP ${res.status}, skipping`);
    return null;
  }
  return res.json();
}

async function main() {
  const args = process.argv.slice(2);
  const slugArg = args.includes("--slug") ? args[args.indexOf("--slug") + 1] : null;
  const applyLocal = args.includes("--apply-local");
  const slugs = slugArg ? [slugArg] : KNOWN_SLUGS;

  const statements = [];
  let totalEntries = 0;
  let totalSkipped = 0;

  for (const slug of slugs) {
    const feed = await fetchFeed(slug);
    const history = Array.isArray(feed?.history) ? feed.history : [];
    let kept = 0;
    let skipped = 0;
    for (const entry of history) {
      const row = rowFromHistoryEntry(slug, entry, feed);
      if (!row) {
        skipped += 1;
        continue;
      }
      statements.push(insertSqlFor(row));
      kept += 1;
    }
    totalEntries += kept;
    totalSkipped += skipped;
    console.log(`${slug}: ${kept} reads (${skipped} skipped, unparseable t)`);
  }

  console.log(`\nTotal: ${totalEntries} cam_observations rows, ${totalSkipped} skipped.`);

  if (!statements.length) return;

  if (applyLocal) {
    const dir = mkdtempSync(join(tmpdir(), "cam-backfill-"));
    const file = join(dir, "backfill.sql");
    writeFileSync(file, statements.join("\n") + "\n");
    console.log(`\nApplying to local D1 (isitbeachday-plus) via wrangler...`);
    execSync(`npx wrangler d1 execute isitbeachday-plus --local --file=${file}`, {
      stdio: "inherit",
      cwd: new URL("..", import.meta.url).pathname,
    });
  } else {
    console.log("\n-- SQL (re-run with --apply-local to execute against the local D1) --\n");
    for (const s of statements) console.log(s);
  }
}

// Only run when invoked directly (`node scripts/backfill_cam_history.mjs`) —
// not when imported by a test for its exported pure functions.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
