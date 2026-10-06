// Weekly prediction scorecard: compare what the app predicted with what happened.
//
// Run from the repo root:
//   npx vite-node -c vitest.config.ts scripts/scorecard.ts [flags]
//
// It READS production D1 through `wrangler d1 execute ... --remote` (read-only
// SELECTs; it never writes to the database) and writes the report to
// docs/scorecards/YYYY-MM-DD.md and docs/scorecards/latest.md. The Markdown is
// also printed to stdout. Messages about progress go to stderr.
//
// Flags:
//   --days N          days of hourly rows to score (default 14)
//   --out DIR         where to write the report (default docs/scorecards)
//   --json            also print the computed metrics as JSON after the Markdown
//   --from-json FILE  score saved query results instead of querying D1
//   --save-raw FILE   save the query results (for --from-json, tests, offline work)
//
// A query that fails never stops the run: its section prints "Not available —"
// with the first line of the error. All maths lives in lib/scorecard/metrics.ts
// (pure, unit-tested); the Markdown is built in lib/scorecard/report.ts.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getLocation } from "@/config/locations";
import { computeSunTimes } from "@/lib/sources/sun";
import { buildScorecard, renderMarkdown, type RawData, type RawDatasetName } from "@/lib/scorecard/report";
import { errorLineOf, parseWranglerJson } from "@/lib/scorecard/wrangler";
import type { DaylightFn, HourlyRow, SunPredictionRow } from "@/lib/scorecard/metrics";

const DB_NAME = "isitbeachday-plus";
const HOURLY_CHUNK_DAYS = 3;
const SUN_ROW_LIMIT = 20_000;
const DAY_MS = 86_400_000;

const here = (() => {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.cwd(), "scripts");
  }
})();
const ROOT = resolve(here, "..");

// --- Arguments --------------------------------------------------------------

interface Args {
  days: number;
  out: string;
  json: boolean;
  fromJson: string | null;
  saveRaw: string | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { days: 14, out: "docs/scorecards", json: false, fromJson: null, saveRaw: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v == null) throw new Error(`${k} needs a value`);
      return v;
    };
    if (k === "--days") {
      const n = Number(next());
      if (!Number.isInteger(n) || n < 1 || n > 120) throw new Error("--days must be a whole number from 1 to 120");
      a.days = n;
    } else if (k === "--out") a.out = next();
    else if (k === "--json") a.json = true;
    else if (k === "--from-json") a.fromJson = next();
    else if (k === "--save-raw") a.saveRaw = next();
    else throw new Error(`unknown flag ${k}`);
  }
  return a;
}

// --- D1 via wrangler --------------------------------------------------------

type Row = Record<string, unknown>;

function d1(sql: string): Row[] {
  let stdout: string;
  try {
    stdout = execFileSync("npx", ["wrangler", "d1", "execute", DB_NAME, "--remote", "--json", "--command", sql], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
      timeout: 240_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: string };
    if (err.code === "ETIMEDOUT") throw new Error("wrangler timed out");
    // err.message is "Command failed: ..." plus the SQL, so it is not used.
    throw new Error(errorLineOf(`${err.stdout ?? ""}\n${err.stderr ?? ""}`));
  }
  const parsed = parseWranglerJson(stdout) as { results?: Row[]; success?: boolean; error?: unknown }[];
  const first = Array.isArray(parsed) ? parsed[0] : undefined;
  if (!first || first.success === false) {
    throw new Error(errorLineOf(JSON.stringify(first?.error ? { error: first.error } : (parsed ?? "no result"))));
  }
  return first.results ?? [];
}

const sqlStr = (s: string): string => `'${s.replace(/'/g, "''")}'`;

function jsonOf(v: unknown): unknown {
  if (typeof v !== "string") return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

// --- Fetch ------------------------------------------------------------------

const log = (msg: string): void => {
  process.stderr.write(`${msg}\n`);
};

function hourlyQuery(fromIso: string, toIso: string): string {
  // json_extract pulls only the blocks the scorecard reads, so a row is ~100
  // bytes instead of the whole ~2 KB extra_json. `win` not `window`: WINDOW is
  // an SQL keyword.
  return `SELECT slug, hour_utc, local_date, local_hour, score,
  CASE WHEN extra_json IS NULL THEN 0 ELSE 1 END AS has_extra,
  json_extract(extra_json, '$.window') AS win,
  json_extract(extra_json, '$.rain') AS rain,
  json_extract(extra_json, '$.flags') AS flags,
  json_extract(extra_json, '$.outlook') AS outlook,
  json_extract(extra_json, '$.safety') AS safety,
  json_extract(extra_json, '$.rip') AS rip
FROM beach_hourly
WHERE row_kind = 'snapshot' AND hour_utc >= ${sqlStr(fromIso)} AND hour_utc < ${sqlStr(toIso)}
ORDER BY hour_utc, slug`;
}

function toHourly(r: Row): HourlyRow {
  return {
    slug: String(r.slug),
    hour_utc: String(r.hour_utc),
    local_date: String(r.local_date),
    local_hour: Number(r.local_hour),
    score: typeof r.score === "number" ? r.score : null,
    has_extra: Number(r.has_extra) === 1,
    window: jsonOf(r.win) as HourlyRow["window"],
    rain: jsonOf(r.rain) as HourlyRow["rain"],
    flags: jsonOf(r.flags) as HourlyRow["flags"],
    outlook: jsonOf(r.outlook) as HourlyRow["outlook"],
    safety: jsonOf(r.safety) as HourlyRow["safety"],
    rip: jsonOf(r.rip) as HourlyRow["rip"],
  };
}

const SUN_PRED_COLS =
  "slug, event_kind, event_iso, as_of_hour_utc, lead_minutes, score, band, algo_version, observed_score, observed_source";

function fetchRaw(days: number, now: Date): RawData {
  const raw: RawData = {
    asOf: now.toISOString(),
    days,
    hourly: null,
    sunPredictions: null,
    sunObservations: null,
    camLatest: null,
    sunPredictionsLast24h: null,
    errors: {},
  };
  const fail = (name: RawDatasetName, e: unknown): void => {
    const msg = e instanceof Error ? e.message : String(e);
    raw.errors[name] = raw.errors[name] ? raw.errors[name] : msg;
    log(`  ${name}: FAILED — ${msg}`);
  };

  // Hourly rows, a few days per query (each response stays small).
  log(`Reading ${days} days of hourly rows...`);
  const start = Math.floor((now.getTime() - days * DAY_MS) / DAY_MS) * DAY_MS;
  const end = now.getTime() + 3_600_000;
  const rows: HourlyRow[] = [];
  let okChunks = 0;
  for (let t = start; t < end; t += HOURLY_CHUNK_DAYS * DAY_MS) {
    const to = Math.min(t + HOURLY_CHUNK_DAYS * DAY_MS, end);
    try {
      rows.push(...d1(hourlyQuery(new Date(t).toISOString(), new Date(to).toISOString())).map(toHourly));
      okChunks++;
    } catch (e) {
      fail("hourly", e);
    }
  }
  if (okChunks > 0) raw.hourly = rows;
  log(`  hourly: ${rows.length} rows`);

  // Sun-color forecasts: every paired row (all leads), plus each event's call
  // row (latest forecast made >= 60 min ahead) so unpaired events still feed
  // the predicted-distribution check. Bounded: not the whole table.
  log("Reading sun-color forecasts...");
  try {
    const paired = d1(
      `SELECT ${SUN_PRED_COLS} FROM sun_event_predictions WHERE observed_score IS NOT NULL ORDER BY event_iso, as_of_hour_utc LIMIT ${SUN_ROW_LIMIT}`,
    );
    const calls = d1(
      `SELECT ${SUN_PRED_COLS.split(", ").map((c) => `p.${c}`).join(", ")} FROM sun_event_predictions p
WHERE p.lead_minutes >= 60 AND p.as_of_hour_utc = (
  SELECT MAX(q.as_of_hour_utc) FROM sun_event_predictions q
  WHERE q.slug = p.slug AND q.event_kind = p.event_kind AND q.event_iso = p.event_iso AND q.lead_minutes >= 60)
LIMIT ${SUN_ROW_LIMIT}`,
    );
    const seen = new Set<string>();
    const merged: SunPredictionRow[] = [];
    for (const r of [...paired, ...calls]) {
      const k = `${r.slug}|${r.event_kind}|${r.event_iso}|${r.as_of_hour_utc}`;
      if (seen.has(k)) continue;
      seen.add(k);
      merged.push(r as unknown as SunPredictionRow);
    }
    raw.sunPredictions = merged;
    if (paired.length >= SUN_ROW_LIMIT || calls.length >= SUN_ROW_LIMIT) {
      raw.errors.sunPredictions = `Row limit of ${SUN_ROW_LIMIT} reached; older events may be missing.`;
    }
    log(`  sunPredictions: ${merged.length} rows (${paired.length} paired)`);
  } catch (e) {
    fail("sunPredictions", e);
  }

  try {
    raw.sunPredictionsLast24h = Number(
      d1(
        `SELECT COUNT(*) AS n FROM sun_event_predictions WHERE archived_at >= ${sqlStr(new Date(now.getTime() - DAY_MS).toISOString())}`,
      )[0]?.n ?? 0,
    );
  } catch (e) {
    fail("sunPredictionsLast24h", e);
  }

  log("Reading sun-camera readings and camera captures...");
  try {
    raw.sunObservations = d1(
      "SELECT slug, event_kind, event_date_local, cam_id, event_iso, view, observed_score, scored_at FROM sun_event_observations ORDER BY event_iso",
    ) as unknown as RawData["sunObservations"];
  } catch (e) {
    fail("sunObservations", e);
  }
  try {
    raw.camLatest = d1(
      "SELECT slug, MAX(captured_at_utc) AS captured_at_utc FROM cam_observations GROUP BY slug",
    ) as unknown as RawData["camLatest"];
  } catch (e) {
    fail("camLatest", e);
  }
  return raw;
}

// --- Beach facts from config -------------------------------------------------

const localHour = (tz: string, ms: number): number => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).formatToParts(
    new Date(ms),
  );
  return Number(parts.find((p) => p.type === "hour")?.value);
};

/** Daylight hours [sunrise hour, sunset hour) in the beach's own time — the same
 *  rule computeMultiDayWindows uses (the sunset hour itself is left out). */
const daylight: DaylightFn = (slug, date) => {
  const loc = getLocation(slug);
  const [y, m, d] = date.split("-").map(Number);
  if (!loc || !y || !m || !d) return null;
  const t = computeSunTimes(loc.lat, loc.lon, y, m, d);
  if (!t.sunrise || !t.sunset) return null;
  return { from: localHour(loc.timezone, t.sunrise.getTime()), to: localHour(loc.timezone, t.sunset.getTime()) };
};

const tierOf = (slug: string): "curated" | "auto" | undefined => {
  const loc = getLocation(slug);
  return loc ? (loc.tier ?? "curated") : undefined;
};

/** Rows a day a beach should have: all 24 hours for curated beaches, its daylight hours for auto ones. */
const expectedPerDayAt =
  (asOf: string) =>
  (slug: string): number | undefined => {
    if (tierOf(slug) !== "auto") return tierOf(slug) ? 24 : undefined;
    const dl = daylight(slug, asOf.slice(0, 10));
    return dl ? Math.max(0, dl.to - dl.from) : undefined;
  };

// --- Main --------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const abs = (p: string) => (isAbsolute(p) ? p : join(ROOT, p));

  let raw: RawData;
  if (args.fromJson) {
    raw = JSON.parse(readFileSync(abs(args.fromJson), "utf8")) as RawData;
    log(`Scoring saved results from ${args.fromJson} (as of ${raw.asOf}).`);
  } else {
    raw = fetchRaw(args.days, new Date());
  }
  if (args.saveRaw) {
    writeFileSync(abs(args.saveRaw), JSON.stringify(raw));
    log(`Saved query results to ${args.saveRaw}`);
  }

  const card = buildScorecard(raw, { daylight, tierOf, expectedPerDay: expectedPerDayAt(raw.asOf) });
  const md = renderMarkdown(card);

  // If the two main datasets both failed to load, this report says nothing:
  // keep the dated file as a record, but never replace the last good latest.md.
  const nothingLoaded = raw.hourly == null && raw.sunPredictions == null;
  const outDir = abs(args.out);
  mkdirSync(outDir, { recursive: true });
  const dated = join(outDir, `${raw.asOf.slice(0, 10)}.md`);
  writeFileSync(dated, md);
  if (nothingLoaded) {
    log(`Wrote ${dated}. Nothing loaded, so latest.md was left alone.`);
    process.exitCode = 1;
  } else {
    writeFileSync(join(outDir, "latest.md"), md);
    log(`Wrote ${dated} and ${join(outDir, "latest.md")}`);
  }

  process.stdout.write(md);
  if (args.json) process.stdout.write(`\n--- metrics (json) ---\n${JSON.stringify(card, null, 2)}\n`);
}

try {
  main();
} catch (e) {
  process.stderr.write(`scorecard: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
}
