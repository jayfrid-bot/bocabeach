#!/usr/bin/env node
// Preprocess job for the "king tide" / high-tide-flooding sky event (see
// docs/SKY_EVENTS_PLAN.md §3, §13 Crew D). Run on a schedule by
// .github/workflows/king-tide.yml, published to its OWN `king-tide-data`
// orphan branch — never `sargassum-data` (that branch is force-pushed every
// ~10 min by sargassum.yml/backfill-pct.yml and would silently wipe anything
// else published there; see scripts/rip_nwps.mjs's header for the same
// lesson learned the hard way).
//
// Unlike a live weather/model feed, tide predictions are deterministic
// astronomy — there is no "the model reran with new numbers" staleness risk
// here. `generatedAt` on the published feed exists to prove the PIPELINE
// itself is still alive (the adapter's 30-day/14-day gates, §3/§8, catch a
// broken cron — not stale astronomy), not because the underlying numbers
// decay hour to hour. So this script does NOT need the in-job polling loop
// pattern sargassum.yml/lightning.yml use for genuinely live sources — a
// slow/occasional cron fire is fine (see king-tide.yml's header).
//
// For each DISTINCT NOAA CO-OPS station named in config/tideStations.ts
// (several beaches can share one station, e.g. Santa Monica & Crescent Bay):
//   1. Fetch two full STATION-LOCAL calendar years (current + next) of
//      hi/lo predictions in ONE request, at datum=STND (falling back to
//      MLLW only when a station doesn't support STND — confirmed live that
//      not every station does, e.g. the "type S" subordinate stations used
//      by tybee-island/grand-isle), time_zone=gmt (so every timestamp
//      parses straight to a UTC instant, no local round-trip — §3).
//   2. When the station is flagged `representative: true` in
//      config/tideStations.ts, fetch its own floodlevels.json threshold
//      (nws_minor, falling back to nos_minor when NWS is null — §3) IN THE
//      SAME datum the predictions were just fetched in, so a threshold
//      comparison never mixes datums.
//   3. Compute each station-local year's own top-1%-of-predicted-highs
//      threshold from that year's H-type predictions.
//   4. Classify every predicted high: "validated" (only when representative
//      AND it crosses the flood threshold) beats "very-high" (top 1% of its
//      own year) beats "doesn't qualify" (dropped).
//   5. Deterministically merge qualifying highs into episodes (consecutive
//      highs <=30h apart; a chain never spans more than 72h total, §3).
//
// On a station's total fetch failure, its PREVIOUS published entry is
// carried forward unchanged (original validThrough, never restamped as
// fresh) — same convention scripts/rip_nwps.mjs uses per-office. A station
// that fetches fine but simply has zero qualifying highs still publishes a
// fresh, honest empty `highs: []` — that's a real state, not a failure.
//
// Usage: node scripts/king_tide.mjs --out path/to/king_tide_data.json
//          [--prev path/to/previous_king_tide_data.json] [--now ISO]
//          [--map path/to/tideStations.json] [--tzmap path/to/timezones.json]
// Pure Node, no deps (matches rip_nwps.mjs's convention).

import fs from "node:fs";
import path from "node:path";

const NOAA_BASE = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";
const MDAPI_BASE = "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations";
const UA = { "User-Agent": "bocabeach-king-tide/1.0 (jayfrid@gmail.com)" };
const APPLICATION = "boca-beach-rats";
const FETCH_TIMEOUT_MS = 15_000;
const TOP_PCT = 0.01; // "top 1% of predicted highs" (§3)
const EPISODE_GAP_MS = 30 * 3_600_000; // consecutive qualifying highs merge when <=30h apart (§3)
const EPISODE_MAX_SPAN_MS = 72 * 3_600_000; // a merge chain never spans more than 72h total (§3)
const REQUEST_PAD_DAYS = 3; // outer GMT-date fetch window padding around the exact UTC year boundaries
const REQUEST_STAGGER_MS = 150; // polite spacing between sequential per-station requests

// --- Timezone-aware year boundaries (no deps: Node's built-in Intl/ICU) ----

/** The UTC-offset (ms) of `timeZone` at the instant `utcMs`. */
function tzOffsetMsAt(utcMs, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - utcMs;
}

/** The UTC instant (ms) for a given WALL-CLOCK date/time in `timeZone`. Two
 *  passes converge even across a DST transition (the offset only takes a
 *  handful of stable values); January 1st / December 31st boundaries are
 *  never themselves inside a US DST transition, so one pass would already
 *  be exact for this script's actual use, but two is correct in general. */
export function zonedTimeToUtcMs(year, month, day, hour, minute, second, timeZone) {
  let guess = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 2; i++) {
    const offset = tzOffsetMsAt(guess, timeZone);
    guess = Date.UTC(year, month - 1, day, hour, minute, second) - offset;
  }
  return guess;
}

/** The local calendar year `nowMs` falls in, per `timeZone`. */
export function localYearAt(nowMs, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" });
  return Number(dtf.format(new Date(nowMs)));
}

/**
 * The two station-local calendar years this feed covers (current + next,
 * §3's "mirrors the meteor-shower table's current+next-year rule" so a
 * January event never falls through a year-boundary gap late each
 * December), as exact UTC instant boundaries: `[startMs, midMs)` is
 * `currentYear`, `[midMs, endMs)` is `nextYear`.
 */
export function stationLocalYearBounds(nowMs, timeZone) {
  const currentYear = localYearAt(nowMs, timeZone);
  const nextYear = currentYear + 1;
  const startMs = zonedTimeToUtcMs(currentYear, 1, 1, 0, 0, 0, timeZone);
  const midMs = zonedTimeToUtcMs(nextYear, 1, 1, 0, 0, 0, timeZone);
  const endMs = zonedTimeToUtcMs(nextYear + 1, 1, 1, 0, 0, 0, timeZone);
  return { currentYear, nextYear, startMs, midMs, endMs };
}

function yyyymmdd(ms) {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
}

// --- Config loaders (dependency-free source scrape, matches rip_nwps.mjs) --

/** Parses config/tideStations.ts's `TIDE_STATIONS` map without a TS
 *  compiler — same convention as rip_nwps.mjs's `parseCoverageTs`. */
export function parseTideStationsTs(tsPath) {
  const src = fs.readFileSync(tsPath, "utf8");
  const out = {};
  const re =
    /"([a-z0-9-]+)":\s*\{\s*stationId:\s*"([A-Za-z0-9]+)",[\s\S]*?representative:\s*(true|false),[\s\S]*?thresholdDatum:\s*("STND"|null),/g;
  let m;
  while ((m = re.exec(src))) {
    out[m[1]] = {
      stationId: m[2],
      representative: m[3] === "true",
      thresholdDatum: m[4] === "null" ? null : "STND",
    };
  }
  return out;
}

/** Beach slug -> IANA timezone, scraped from config/locations.ts (the 3
 *  hand-curated beaches) + config/locations.generated.json (the other 36) —
 *  same two-source pattern scripts/nwps_rip_map.mjs's `scrapeLocations`
 *  already uses for lat/lon. */
export function loadBeachTimezones(root) {
  const out = {};
  const curatedSrc = fs.readFileSync(path.join(root, "config/locations.ts"), "utf8");
  const re = /slug:\s*"([^"]+)"[\s\S]*?timezone:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(curatedSrc))) out[m[1]] = m[2];
  const genPath = path.join(root, "config/locations.generated.json");
  if (fs.existsSync(genPath)) {
    const gen = JSON.parse(fs.readFileSync(genPath, "utf8"));
    for (const g of gen) {
      if (g?.slug && g?.timezone && !(g.slug in out)) out[g.slug] = g.timezone;
    }
  }
  return out;
}

/** One roster entry per DISTINCT station (several beaches can share a
 *  station, e.g. crescent-bay-park & santa-monica both use 9410840) — the
 *  feed is keyed by station, not by beach (matches KingTideStationFeed's
 *  shape: no beach slug field at all). Asserts every beach sharing a
 *  station agrees on `representative` and `timezone` (true in every case
 *  configured today) rather than silently picking one. */
export function buildStationRoster(tideStations, beachTimezones) {
  const roster = new Map();
  for (const [slug, { stationId, representative, thresholdDatum }] of Object.entries(tideStations)) {
    const timezone = beachTimezones[slug];
    if (!timezone) {
      console.error(`[king_tide] ${slug}: no timezone found (missing from locations config?) — skipping`);
      continue;
    }
    const existing = roster.get(stationId);
    if (!existing) {
      roster.set(stationId, { timezone, representative, thresholdDatum: thresholdDatum ?? null, beaches: [slug] });
      continue;
    }
    existing.beaches.push(slug);
    if (existing.timezone !== timezone) {
      console.error(
        `[king_tide] station ${stationId}: ${slug} disagrees on timezone (${timezone} vs ${existing.timezone}) — keeping ${existing.timezone}`,
      );
    }
    if (existing.representative !== representative) {
      console.error(
        `[king_tide] station ${stationId}: ${slug} disagrees on representative (${representative} vs ${existing.representative}) — keeping the more conservative false`,
      );
      existing.representative = false;
    }
    if (existing.thresholdDatum !== (thresholdDatum ?? null)) {
      console.error(
        `[king_tide] station ${stationId}: ${slug} disagrees on thresholdDatum (${thresholdDatum} vs ${existing.thresholdDatum})`,
      );
    }
  }
  return roster;
}

// --- NOAA CO-OPS fetch (predictions + floodlevels) --------------------------

async function fetchJsonOnce(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: UA, signal: controller.signal });
    if (!res.ok) return { ok: false, status: res.status };
    const json = await res.json();
    return { ok: true, status: res.status, json };
  } catch {
    return { ok: false, status: null };
  } finally {
    clearTimeout(timer);
  }
}

/** One retry on failure/error-body, matching rip_nwps.mjs's fetch convention. */
async function fetchJsonWithRetry(url) {
  const first = await fetchJsonOnce(url);
  if (first.ok && !first.json?.error) return first.json;
  const second = await fetchJsonOnce(url);
  if (second.ok && !second.json?.error) return second.json;
  return null;
}

/**
 * Fetches one station's full [startMs, endMs) window of hi/lo predictions,
 * trying `datum=STND` first and falling back to `datum=MLLW` only when STND
 * itself fails (confirmed live 2026-09-28: type-"S" subordinate stations
 * like TEC3399/TEC4455 don't support STND at all, but most stations do) —
 * §3's "or the station's own datum, re-checked per station — never assume
 * MLLW". The outer GMT-date request window is padded a few days on each
 * side; the caller filters to the exact `[startMs, endMs)` UTC instants
 * afterward, so the coarse day-level request window never has to line up
 * exactly with the precise station-local year boundary.
 */
export async function fetchStationPredictions(stationId, startMs, endMs) {
  const beginYmd = yyyymmdd(startMs - REQUEST_PAD_DAYS * 86_400_000);
  const endYmd = yyyymmdd(endMs + REQUEST_PAD_DAYS * 86_400_000);
  for (const datum of ["STND", "MLLW"]) {
    const url =
      `${NOAA_BASE}?begin_date=${beginYmd}&end_date=${endYmd}&station=${stationId}` +
      `&product=predictions&datum=${datum}&time_zone=gmt&units=english&interval=hilo` +
      `&format=json&application=${APPLICATION}`;
    const json = await fetchJsonWithRetry(url);
    if (json && Array.isArray(json.predictions) && json.predictions.length) {
      return { datum, raw: json.predictions };
    }
  }
  return null;
}

const NUMERIC_STRING_RE = /^-?\d+(\.\d+)?$/;

/**
 * Accepts ONLY a genuine finite `number`, or a `string` that (after
 * trimming) is nothing but an optionally-signed decimal — nothing else ever
 * becomes a threshold. `null`/`undefined`/a blank string are never handed to
 * `Number()` first, since `Number(null) === 0` and `0` is a perfectly finite
 * number: a floodlevels.json field that's genuinely JSON `null` (the real,
 * live shape for a station like seaside/9413450, whose `nws_minor` is `null`
 * while `nos_minor` is a real value) would otherwise silently become a
 * threshold of `0 ft`, and since every predicted height is positive, EVERY
 * high would then read as crossing it — "validated" (Codex review round 2).
 * A blind `Number(raw)` has the SAME failure mode for other JS-truthy-ish
 * inputs too — `Number(false) === 0`, `Number(true) === 1`,
 * `Number([]) === 0`, `Number([8.39]) === 8.39` — so a boolean, array, or
 * plain object is rejected outright by type, never coerced at all (Codex
 * review round 3); only `typeof raw === "number"` or a strictly-numeric
 * `typeof raw === "string"` ever reaches `Number()`.
 */
export function parseFloodLevelFt(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed || !NUMERIC_STRING_RE.test(trimmed)) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * The station's own published flood threshold, in whatever datum
 * floodlevels.json itself uses for that station — §3's live spot-check
 * (Lake Worth Pier, Miami Beach) and this pass's fuller sweep (see
 * config/tideStations.ts's per-entry comments) found every `representative`
 * station's threshold on the SAME scale as its own `datum=STND` predictions,
 * which is why config/tideStations.ts only marks `representative: true`
 * where that was actually verified — this function does not re-derive or
 * assume that; it just returns the raw published numbers.
 *
 * Returns `{ nwsMinorFt: null, nosMinorFt: null }` for a confirmed "this
 * station simply has no threshold" (404 — the normal case for most
 * stations). Returns `null` for a transient fetch failure (network error,
 * non-404 non-2xx) — distinct so the caller can log it, though both cases
 * degrade the same way today: no threshold comparison this run, never a
 * fabricated one.
 */
export async function fetchFloodThreshold(stationId) {
  const url = `${MDAPI_BASE}/${stationId}/floodlevels.json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: UA, signal: controller.signal });
    if (res.status === 404) return { nwsMinorFt: null, nosMinorFt: null };
    if (!res.ok) return null;
    const json = await res.json();
    return {
      nwsMinorFt: parseFloodLevelFt(json?.nws_minor),
      nosMinorFt: parseFloodLevelFt(json?.nos_minor),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// --- Parsing / classification / merge ---------------------------------------

/** Raw NOAA hi/lo rows -> sanitized `{tMs, heightFt, type}`, filtered to the
 *  exact `[startMs, endMs)` window. Rejects a row whose timestamp/height
 *  don't parse rather than ever guessing (item 7 convention, same as
 *  rip_nwps.mjs's sanitizeBeachEntry). */
export function sanitizePredictions(raw, startMs, endMs) {
  const out = [];
  for (const p of raw ?? []) {
    if (!p || typeof p.t !== "string" || typeof p.v !== "string") continue;
    if (p.type !== "H" && p.type !== "L") continue;
    const tMs = Date.parse(`${p.t.replace(" ", "T")}:00Z`);
    if (!Number.isFinite(tMs)) continue;
    const heightFt = Number(p.v);
    if (!Number.isFinite(heightFt)) continue;
    if (tMs < startMs || tMs >= endMs) continue;
    out.push({ tMs, heightFt, type: p.type });
  }
  out.sort((a, b) => a.tMs - b.tMs);
  return out;
}

/**
 * The height such that this station-local year's top `pct` fraction of
 * predicted HIGHS are >= it (§3: "top 1% of that station's own predicted
 * highs... computed from a fixed station-local calendar-year distribution").
 * `null` when there are no highs to rank. At least 1 high always qualifies
 * (a year with, say, 4 highs still has a well-defined "top 1%": the single
 * highest one) — `Math.ceil` never rounds a fractional count down to 0.
 */
export function percentileThresholdFt(heightsFt, pct = TOP_PCT) {
  if (!heightsFt.length) return null;
  const sorted = [...heightsFt].sort((a, b) => b - a);
  const topCount = Math.max(1, Math.ceil(sorted.length * pct));
  return sorted[topCount - 1];
}

/** "validated" beats "very-high" beats not-qualifying (§3's two tiers). */
export function classifyHigh(heightFt, { thresholdFt, percentileFt, representative }) {
  if (representative && thresholdFt != null && heightFt >= thresholdFt) return "validated";
  if (percentileFt != null && heightFt >= percentileFt) return "very-high";
  return null;
}

/**
 * Whether THIS RUN may fetch/apply a flood-threshold comparison for a
 * station — the enforcement point for "datum never mixes" (§3,
 * config/tideStations.ts's header comment). `representative: true` in
 * config is necessary but NOT sufficient on its own: a station's
 * `thresholdDatum` (hand-verified once, e.g. "STND") must also match
 * `predictionDatum`, THIS RUN's actual fetched datum — a station whose
 * predictions normally succeed at STND can transiently fall back to MLLW
 * (fetchStationPredictions's own fallback) on any given run, and comparing
 * an STND-scale threshold against MLLW-scale predictions would silently
 * fabricate a wrong flood call. A `representative: true` station with no
 * `thresholdDatum` recorded (a config error, never true today) is also
 * treated as not usable, rather than guessing a datum.
 */
export function canUseThresholdForRun({ representative, thresholdDatum, predictionDatum }) {
  return Boolean(representative && thresholdDatum != null && predictionDatum === thresholdDatum);
}

/**
 * Deterministic episode merge (§3): qualifying highs, already sorted
 * ascending by time, merge into one episode while consecutive highs are
 * <=30h apart AND the running span from the episode's first high stays
 * <=72h; either condition failing starts a new episode. An episode's `tier`
 * is "validated" if ANY of its merged highs crossed the flood threshold
 * (never downgraded by a lower-tier neighbor merging in beside it); its
 * `heightFt` is the tallest of its merged highs.
 */
export function mergeEpisodes(qualifyingHighs) {
  const episodes = [];
  let cur = null;
  for (const h of qualifyingHighs) {
    if (cur && h.tMs - cur.lastMs <= EPISODE_GAP_MS && h.tMs - cur.startMs <= EPISODE_MAX_SPAN_MS) {
      cur.lastMs = h.tMs;
      cur.maxHeightFt = Math.max(cur.maxHeightFt, h.heightFt);
      cur.hasValidated = cur.hasValidated || h.tier === "validated";
    } else {
      if (cur) episodes.push(cur);
      cur = { startMs: h.tMs, lastMs: h.tMs, maxHeightFt: h.heightFt, hasValidated: h.tier === "validated" };
    }
  }
  if (cur) episodes.push(cur);
  return episodes.map((e) => ({
    episode: { start: new Date(e.startMs).toISOString(), end: new Date(e.lastMs).toISOString() },
    heightFt: Math.round(e.maxHeightFt * 100) / 100,
    tier: e.hasValidated ? "validated" : "very-high",
  }));
}

// --- Per-station build --------------------------------------------------

/**
 * Builds one station's published feed entry from a successful predictions
 * fetch (+ threshold fetch, if representative). Pure — takes already-fetched
 * data so it's unit-testable without a network call.
 */
export function buildStationEntry(
  stationId,
  { datum, sanitizedHighs, bounds, representative, threshold, generatedAt },
) {
  const currentHighs = sanitizedHighs.filter((h) => h.tMs < bounds.midMs).map((h) => h.heightFt);
  const nextHighs = sanitizedHighs.filter((h) => h.tMs >= bounds.midMs).map((h) => h.heightFt);
  const currentPct = percentileThresholdFt(currentHighs);
  const nextPct = percentileThresholdFt(nextHighs);
  const percentileByYear = {};
  if (currentPct != null) percentileByYear[String(bounds.currentYear)] = Math.round(currentPct * 100) / 100;
  if (nextPct != null) percentileByYear[String(bounds.nextYear)] = Math.round(nextPct * 100) / 100;

  const thresholdFt = threshold?.nwsMinorFt ?? threshold?.nosMinorFt ?? null;

  const classified = sanitizedHighs.map((h) => ({
    tMs: h.tMs,
    heightFt: h.heightFt,
    tier: classifyHigh(h.heightFt, {
      thresholdFt,
      percentileFt: h.tMs < bounds.midMs ? currentPct : nextPct,
      representative,
    }),
  }));
  const qualifying = classified.filter((h) => h.tier != null);
  const highs = mergeEpisodes(qualifying);

  return {
    stationId,
    datum,
    representative,
    nwsMinorFt: threshold?.nwsMinorFt ?? null,
    nosMinorFt: threshold?.nosMinorFt ?? null,
    percentileByYear,
    highs,
    validThrough: new Date(bounds.endMs).toISOString(),
    // Per-station freshness, distinct from the feed's top-level
    // `generatedAt` (§8/review item 4): when this station's fetch fails and
    // its previous entry is carried forward VERBATIM, this timestamp is
    // carried forward with it — never bumped to "now" — so the adapter can
    // gate THIS station's own card (<=30d)/alert (<=14d) eligibility on how
    // stale ITS data actually is, not on whether the job merely ran today.
    // Beyond lib/skyEventsTypes.ts's documented KingTideStationFeed shape
    // (frozen Phase 0 contract, not edited by this crew) — an additive
    // field, harmless to any reader that only knows the documented ones;
    // lib/sources/kingTide.ts reads it via its own extended local type.
    generatedAt,
  };
}

// --- Main --------------------------------------------------------------

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name, def) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : def;
  };
  const root = process.cwd();
  const outPath = path.resolve(flag("--out", "king_tide_data.json"));
  const prevPath = flag("--prev", null);
  const nowMs = flag("--now", null) ? Date.parse(flag("--now")) : Date.now();
  const mapPath = flag("--map", null);
  const tzmapPath = flag("--tzmap", null);

  const tideStations = mapPath
    ? JSON.parse(fs.readFileSync(mapPath, "utf8"))
    : parseTideStationsTs(path.join(root, "config/tideStations.ts"));
  const beachTimezones = tzmapPath
    ? JSON.parse(fs.readFileSync(tzmapPath, "utf8"))
    : loadBeachTimezones(root);
  const roster = buildStationRoster(tideStations, beachTimezones);

  const prev = prevPath && fs.existsSync(prevPath) ? JSON.parse(fs.readFileSync(prevPath, "utf8")) : null;
  const prevByStation = new Map((prev?.stations ?? []).map((s) => [s.stationId, s]));

  // One timestamp for every FRESHLY-built station entry this run, shared
  // with the feed's own top-level `generatedAt` below — a carried-forward
  // entry instead keeps its OWN original timestamp untouched (review item
  // 4): the two only ever match for a station that actually re-fetched
  // successfully this run.
  const runGeneratedAt = new Date().toISOString();

  const stations = [];
  let ok = 0;
  let carried = 0;
  let dropped = 0;

  const stationIds = [...roster.keys()].sort();
  for (const stationId of stationIds) {
    const { timezone, representative, thresholdDatum } = roster.get(stationId);
    const bounds = stationLocalYearBounds(nowMs, timezone);

    const fetched = await fetchStationPredictions(stationId, bounds.startMs, bounds.endMs);
    if (!fetched) {
      const carriedEntry = prevByStation.get(stationId);
      if (carriedEntry) {
        stations.push(carriedEntry);
        carried++;
        console.error(`[king_tide] ${stationId}: predictions fetch failed — carried forward previous publish`);
      } else {
        dropped++;
        console.error(`[king_tide] ${stationId}: predictions fetch failed — no previous data either, dropping`);
      }
      await sleep(REQUEST_STAGGER_MS);
      continue;
    }

    const sanitizedHighs = sanitizePredictions(fetched.raw, bounds.startMs, bounds.endMs).filter(
      (h) => h.type === "H",
    );

    // Datum-matching enforcement (review item 3): `representative: true` in
    // config is NOT enough on its own — this run's actual fetched datum
    // must match the station's hand-verified `thresholdDatum`, or a
    // temporary STND->MLLW fallback would compare an STND-scale threshold
    // against MLLW-scale predictions. `usable` (not the raw config
    // `representative`) is what's fetched/applied/published for this run.
    const usable = canUseThresholdForRun({ representative, thresholdDatum, predictionDatum: fetched.datum });
    if (representative && !usable) {
      console.error(
        `[king_tide] ${stationId}: representative but this run's datum (${fetched.datum}) != thresholdDatum (${thresholdDatum}) — skipping threshold comparison this run`,
      );
    }
    let threshold = null;
    if (usable) {
      threshold = await fetchFloodThreshold(stationId);
      if (!threshold) {
        console.error(`[king_tide] ${stationId}: floodlevels fetch failed this run — no threshold comparison`);
      }
    }

    stations.push(
      buildStationEntry(stationId, {
        datum: fetched.datum,
        sanitizedHighs,
        bounds,
        representative: usable,
        threshold,
        generatedAt: runGeneratedAt,
      }),
    );
    ok++;
    await sleep(REQUEST_STAGGER_MS);
  }

  // A total failure — EVERY station's live NOAA fetch failed this run
  // (`ok === 0`) — must publish NOTHING, even when every station still has
  // rows to carry forward from a previous publish (Codex review round 2):
  // silently re-publishing an all-carried-forward feed forever would mask a
  // systemic outage (wrong URL, blocked User-Agent, NOAA down) indefinitely,
  // with no signal anywhere that live data hasn't actually updated. Never a
  // fresh, misleadingly-timestamped feed either way (review item 4 / §8's
  // "a failed or partial pull leaves the last good publish in place
  // untouched"). A genuinely PARTIAL result (at least one station fetched
  // fresh, others carried/dropped) still publishes, per station, as before.
  if (ok === 0) {
    throw new Error(
      `[king_tide] every station's live NOAA fetch failed this run (${carried} carried forward, ${dropped} dropped) — refusing to publish`,
    );
  }

  const out = { schemaVersion: 1, generatedAt: runGeneratedAt, stations };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out));
  console.log(
    `[king_tide] wrote ${outPath}: ${stations.length} station(s) (${ok} fresh, ${carried} carried forward, ${dropped} dropped)`,
  );
  return out;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { main };
