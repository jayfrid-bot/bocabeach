#!/usr/bin/env node
// One-shot LL2 (Launch Library 2, thespacedevs.com) preprocess script for
// the "Coming up" sky-events launch feed (SKY_EVENTS_PLAN.md §7, §8, §13
// Crew C).
//
// Unlike scripts/rip_nwps.mjs (which itself contains a "try older cycles"
// retry loop), this script is deliberately ONE-SHOT: it fetches LL2 once
// (plus at most one retry on failure, same convention rip_nwps.mjs uses),
// validates + normalizes the result, writes one small launch_data.json, and
// EXITS. The 5-hour/30-minute polling loop this feed needs (§8, matching
// lightning.yml's proven pattern) lives in the WORKFLOW
// (.github/workflows/launch-library.yml), which invokes this script fresh
// on every cycle — the loop never lives inside this script itself.
//
// Rate-limit math (§8's "stays under LL2's unauthenticated hourly limit incl.
// retries"): LL2's unauthenticated tier throttles at ~15 requests/hour —
// confirmed LIVE 2026-09-28 by hitting it during this feature's research
// ("Request was throttled. Expected available in 1282 seconds." after ~11
// requests within a few minutes). This script requests a date/location-
// filtered, bounded set (net__gte/net__lte/location__ids, §7 review item e)
// and PAGINATES via LL2's own `next` link, stopping as soon as a page's
// results run past the 14-day window (results are net-ascending) — but
// bounds worst case with MAX_PAGES regardless, in case the filters are
// silently ignored server side (never assumed honored, same defensive
// stance this script takes toward every other LL2 field). Each page costs
// up to 2 requests (1 + 1 retry), so one invocation costs at most
// MAX_PAGES * 2 requests. At MAX_PAGES=3 that's <=6 requests/invocation; at
// the workflow's 30-min cadence (2 cycles/hour) that's <=12 requests/hour
// WORST CASE — comfortably under the ~15/hour limit even counting an
// occasional manual workflow_dispatch run on top. In practice the early
// stop means most cycles cost just 1-2 requests (one page).
//
// That per-run math assumes cycles land ~30 min apart. Codex round-2 review:
// `concurrency: cancel-in-progress` means a workflow_dispatch (or any fresh
// trigger) CANCELS an in-progress loop and starts a brand-new one whose
// FIRST cycle fires immediately, with none of the in-loop 30-min pacing
// applied yet. If that lands soon after the cancelled loop's own last
// cycle, the two runs' first/last cycles can stack inside one rolling hour
// — e.g. a cycle at :00, another at :30 (12 requests so far), then a
// dispatch at :35 that cancels and immediately fires a THIRD 6-request
// cycle — 18 requests in that rolling hour, over the ~15/hour limit. The
// workflow closes this gap itself (see launch-library.yml's "Pacing gate"
// step, which runs BEFORE this script's loop even starts): it reads the
// currently-published feed's own `generatedAt` and waits out whatever's
// left of a 30-min gap since it, using `computePacingWaitMs` below.
//
// Codex round-3 review (HIGH): pacing from the published feed's
// `generatedAt` ALONE is unsound — a cycle that spends real LL2 requests
// and then FAILS (validation, hitting the page cap, or the publish push
// itself failing) leaves `generatedAt` unchanged at its old value, so the
// pacing gate sees a "stale" feed and computes `wait = 0`, letting an
// immediate restart spend MORE requests on top of the failed cycle's
// already-spent ones. Fix: the workflow now writes a tiny, durable
// `last_attempt.json` ({attemptedAt, requests}) to the SAME launch-data
// branch BEFORE ever contacting LL2 each cycle — a separate small
// commit/push from the feed publish (never bundled with a stale feed write,
// but always co-pushed WITH the branch's other current file so neither
// push ever wipes the other, the same lesson §2 already teaches for
// separate feeds' branches). If that attempt-recording push itself fails,
// the cycle is skipped entirely — LL2 is never contacted without a durable
// record of the attempt existing first. The pacing gate now reads BOTH
// `last_attempt.attemptedAt` and the feed's own `generatedAt`, and paces
// from whichever is more recent (`computePacingWaitMs` takes a list of
// candidates below) — so a failed-but-request-spending cycle still counts
// against future pacing decisions, closing the gap round-2's fix left open.
//
// On failure (LL2 unreachable, a non-2xx/non-JSON response, or the top-level
// shape itself is unusable) this script exits NON-ZERO and writes NOTHING —
// no partial or empty file. The caller (the workflow) only publishes when
// this script exits 0 AND actually wrote --out, so a failed cycle can never
// re-stamp the PREVIOUSLY published feed with a fresh `generatedAt` (§8) —
// the old publish simply stays live, untouched, until a cycle succeeds.
//
// An individual launch that fails validation (a missing/malformed required
// field, an ended/cancelled status, a pad outside our 4 ranges, or an
// unrecognized orbit) is just SKIPPED — same per-row tolerance rip_nwps.mjs
// uses for a bad hourly row — it does not fail the whole run.
//
// A successful run that finds ZERO qualifying launches right now still
// writes a valid, empty payload and exits 0 — "nothing at these 4 ranges in
// the next 14 days" is an honest, publishable state (§8), not a failure.
//
// Usage: node scripts/launch_library.mjs --out path/to/launch_data.json

import fs from "node:fs";
import path from "node:path";

// Overridable so tests (scripts/launch_library.test.ts) can point this at a
// local fixture server instead of the real LL2 API — never hit the live,
// rate-limited endpoint from an automated test run.
const LL2_BASE = process.env.LAUNCH_LIBRARY_LL2_URL ?? "https://ll.thespacedevs.com/2.3.0/launches/upcoming/";
const UA = { "User-Agent": "bocabeach-launch-library/1.0 (jayfrid@gmail.com)" };
const FETCH_TIMEOUT_MS = 15_000;
const WINDOW_DAYS = 14;
const SCHEMA_VERSION = 1;
// See the header's rate-limit math (review item e): bounds worst-case
// request cost per invocation even if LL2 silently ignores the
// net__gte/net__lte/location__ids query filters below.
const MAX_PAGES = 3;

/** The minimum gap this feed's own loop paces cycles apart by (§8) — also
 *  the target `computePacingWaitMs` below waits out before a fresh run's
 *  first cycle (Codex round-2 review). */
const PACING_MIN_GAP_MS = 30 * 60 * 1000; // 30 min

/**
 * How long (ms) a fresh run's FIRST cycle should wait before making any LL2
 * request, given a list of candidate "last LL2 activity" ISO timestamps —
 * the published feed's own `generatedAt` AND the durable `last_attempt.json`
 * record's `attemptedAt` (see this file's header, Codex round-2 AND
 * round-3). Uses whichever candidate is MOST RECENT (an unparseable/missing
 * one is simply skipped, carrying no information either way); an
 * implausibly FUTURE candidate (clock skew/corruption) short-circuits
 * straight to the full conservative wait below, regardless of any other
 * candidate — a suspicious timestamp must never cause an UNDER-wait, only
 * ever an over-cautious one.
 *
 * Round-3 fix: pacing from the published feed's `generatedAt` ALONE is
 * unsound — a cycle that spends real LL2 requests and then FAILS (a
 * validation error, hitting the page cap, or the publish push itself
 * failing) leaves `generatedAt` at its old, unchanged value, so a naive
 * "how long since the feed changed" check sees a stale feed and computes
 * `wait = 0`, letting an immediate restart spend MORE requests on top of
 * the failed cycle's already-spent ones — exceeding the hourly bound. The
 * workflow now records a `last_attempt.json` BEFORE ever contacting LL2
 * (so even a totally-failed cycle leaves a durable trace), and this
 * function paces from whichever of the two candidates is more recent, so a
 * failed-but-request-spending cycle still counts.
 *
 * Capped at `PACING_MIN_GAP_MS` (30 min) when NO candidate is usable at all
 * (first-ever run, or every candidate unreadable/future) — so an
 * unreadable history never blocks longer than one full cycle interval, and
 * never blocks indefinitely. Pure; `nowMs` is an explicit param (§9).
 */
export function computePacingWaitMs(candidateIsoTimestamps, nowMs) {
  let bestT = NaN;
  for (const iso of candidateIsoTimestamps) {
    const t = typeof iso === "string" ? Date.parse(iso) : NaN;
    if (!Number.isFinite(t)) continue; // unreadable candidate — carries no information, just skip it
    if (t > nowMs) return PACING_MIN_GAP_MS; // ANY implausibly-future candidate — immediate conservative full wait
    if (!Number.isFinite(bestT) || t > bestT) bestT = t;
  }
  if (!Number.isFinite(bestT)) return PACING_MIN_GAP_MS; // no usable candidate at all
  const elapsedMs = nowMs - bestT;
  return Math.max(0, Math.min(PACING_MIN_GAP_MS, PACING_MIN_GAP_MS - elapsedMs));
}

/**
 * "Known orbital," precisely (§7): a launch counts as orbital ONLY when
 * LL2's own `mission.orbit.abbrev` matches this small allowlist — NEVER
 * inferred from the rocket/mission name. Verified live 2026-09-28 against
 * 100 upcoming launches: the abbrevs actually seen were Direct-GEO, GTO,
 * LEO, LO, MEO, Mars, N/A, PO, SSO, Sub (plus missing/null `mission`,
 * ~4/100). HEO is in SKY_EVENTS_PLAN.md §7's own explicit example list but
 * wasn't present in that day's sample — kept per spec, since the API
 * documents it as a standard orbit class. "Sub" (suborbital), "N/A", and
 * anything NOT in this list are excluded — a missing/unrecognized orbit
 * means NOT known-orbital, never assumed orbital by default (§7).
 */
const ORBIT_ALLOWLIST = new Set(["LEO", "MEO", "GTO", "Direct-GEO", "GEO", "SSO", "PO", "HEO", "LO", "Mars"]);

/** LL2's real status abbrevs that count as "still upcoming/active" (§7) —
 *  kept in sync BY HAND with lib/sources/launchLibrary.ts's
 *  `ACTIVE_STATUS_MAP` (the adapter re-validates this independently as
 *  untrusted input, §9, so drift here just means the adapter drops an entry
 *  the script shouldn't have published — never the reverse). */
const ACTIVE_STATUS_ABBREVS = new Set(["Go", "TBD", "TBC", "Hold", "In Flight"]);

/** §7's card-display precision enum this script normalizes LL2's raw
 *  `net_precision.name` into (kept in sync by hand with
 *  lib/sources/launchLibrary.ts's `normalizeNetPrecision`, which the
 *  adapter re-applies independently as untrusted input, §9). */
function normalizeNetPrecision(rawName) {
  if (typeof rawName !== "string" || !rawName) return "Unknown";
  const s = rawName.trim().toLowerCase();
  if (s.startsWith("second") || s.startsWith("minute")) return "Minute";
  if (s.startsWith("hour")) return "Hour";
  if (s.startsWith("day")) return "Day";
  if (s.startsWith("month")) return "Month";
  if (s.startsWith("quarter")) return "Quarter";
  if (s.startsWith("year")) return "Year";
  return "Unknown";
}

function sanitizeString(s, maxLen) {
  if (typeof s !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = s.replace(/[\x00-\x1F\x7F]/g, "").trim();
  if (!cleaned) return null;
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

function isIso(s) {
  return typeof s === "string" && Number.isFinite(Date.parse(s));
}

/**
 * Parses config/launchPads.ts for every `locationIds: [...]` array and
 * returns the union as a Set<number> — the LL2 `pad.location.id` values
 * this feed cares about (the 4 ranges, §7). Dependency-free regex parse,
 * the same convention scripts/rip_nwps.mjs's `parseCoverageTs` uses for
 * config/nwpsRip.ts — config/launchPads.ts (TypeScript) is the one source
 * of truth for range membership; this script never duplicates the id list
 * by hand.
 */
export function parseRangeLocationIds(tsPath) {
  const src = fs.readFileSync(tsPath, "utf8");
  const ids = new Set();
  const re = /locationIds:\s*\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(src))) {
    for (const part of m[1].split(",")) {
      const n = Number(part.trim());
      if (Number.isFinite(n)) ids.add(n);
    }
  }
  return ids;
}

async function fetchJsonOnce(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: UA, signal: controller.signal });
    if (!res.ok) return null;
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** One retry on failure/empty response — same convention rip_nwps.mjs uses,
 *  and the ceiling the rate-limit math above (§8) is built around. */
async function fetchJsonWithRetry(url) {
  const first = await fetchJsonOnce(url);
  if (first) return first;
  return fetchJsonOnce(url);
}

/**
 * The first page's URL (review item e): date- and range-bounded server
 * side (`net__gte`/`net__lte`/`location__ids`, `ordering=net`) so a well-
 * behaved LL2 returns only what we need — but every one of those filters is
 * treated as a HINT, never a guarantee: `toFeedEntry` re-validates the
 * window and range membership per launch regardless (§9), and
 * `fetchAllUpcomingPages` below stops paginating using the DATA itself
 * (each page's own `net` values), not by trusting the filters to have
 * narrowed the result set.
 */
export function buildFirstPageUrl(base, rangeLocationIds, now, windowEndMs) {
  const params = new URLSearchParams({
    mode: "detailed",
    limit: "100",
    ordering: "net",
    net__gte: now.toISOString(),
    net__lte: new Date(windowEndMs).toISOString(),
    location__ids: [...rangeLocationIds].sort((a, b) => a - b).join(","),
  });
  return `${base}?${params.toString()}`;
}

function maxNetMsInResults(results) {
  let max = -Infinity;
  for (const r of results) {
    const t = r && Date.parse(r.net);
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max;
}

/**
 * Follows LL2's own `next` link, accumulating `results`, until either (a)
 * a page's results already run past `windowEndMs` — since the "upcoming"
 * endpoint's default order is net-ascending (reinforced by this request's
 * own `ordering=net`), everything on a LATER page is even further out and
 * irrelevant, so this stops right there regardless of whether more pages
 * exist; or (b) LL2 itself reports no further page (`next: null`) — a
 * genuinely complete result. Bounded by `maxPages` as a worst-case backstop
 * (review item e's rate-limit math) in case neither condition is ever met
 * (e.g. the date filters were silently ignored AND launch volume is
 * unexpectedly enormous) — hitting that cap is treated as a FAILURE
 * (`ok: false`), never a silently-truncated "complete" result, since §8's
 * whole point is that a partial pull must never be published as if it were
 * whole.
 */
export async function fetchAllUpcomingPages(firstUrl, windowEndMs, maxPages) {
  let url = firstUrl;
  let allResults = [];
  let pages = 0;
  while (url) {
    if (pages >= maxPages) {
      return { ok: false, reason: "max-pages-exceeded", pages };
    }
    const json = await fetchJsonWithRetry(url);
    if (!json || !Array.isArray(json.results)) {
      return { ok: false, reason: "fetch-failed", pages: pages + 1 };
    }
    pages++;
    allResults = allResults.concat(json.results);
    const pageMaxNet = maxNetMsInResults(json.results);
    if (Number.isFinite(pageMaxNet) && pageMaxNet > windowEndMs) {
      return { ok: true, results: allResults, pages };
    }
    url = typeof json.next === "string" && json.next ? json.next : null;
  }
  return { ok: true, results: allResults, pages };
}

/**
 * One raw LL2 launch result -> one validated `LaunchFeedEntry`, or null to
 * skip it (§7's per-launch validation + reject rule). Every field listed in
 * the crew brief is checked: id, net, window_start, window_end,
 * net_precision, status, pad.id, pad.location.id, last_updated.
 */
function toFeedEntry(raw, rangeLocationIds, now, windowEndMs) {
  if (!raw || typeof raw !== "object") return null;
  const id = sanitizeString(raw.id, 100);
  const name = sanitizeString(raw.name, 200) ?? "Untitled launch";
  if (!id) return null;
  if (!isIso(raw.net) || !isIso(raw.window_start) || !isIso(raw.window_end) || !isIso(raw.last_updated)) return null;
  const netMs = Date.parse(raw.net);
  if (netMs < now.getTime() || netMs > windowEndMs) return null; // outside the 14-day window (§7)

  const statusAbbrev = raw.status && typeof raw.status.abbrev === "string" ? raw.status.abbrev : null;
  if (!statusAbbrev || !ACTIVE_STATUS_ABBREVS.has(statusAbbrev)) return null; // reject cancelled/completed/failed/ended (§7)

  const padId = raw.pad && typeof raw.pad.id === "number" ? raw.pad.id : null;
  const padLocationId = raw.pad && raw.pad.location && typeof raw.pad.location.id === "number" ? raw.pad.location.id : null;
  if (padId == null || padLocationId == null) return null;
  if (!rangeLocationIds.has(padLocationId)) return null; // not one of the 4 ranges (§7)

  const netPrecision = normalizeNetPrecision(raw.net_precision && raw.net_precision.name);

  const rawOrbitAbbrev = raw.mission && raw.mission.orbit && typeof raw.mission.orbit.abbrev === "string" ? raw.mission.orbit.abbrev : null;
  const orbitAbbrev = rawOrbitAbbrev && ORBIT_ALLOWLIST.has(rawOrbitAbbrev) ? rawOrbitAbbrev : null; // §7: unrecognized/missing -> null, never assumed orbital
  // §7 amendment (2026-09-28): classified missions (NROL, USSF) publish
  // orbit "N/A"/"Unknown", which hid e.g. a night Falcon Heavy from every
  // 50-200 mi beach. LL2's own launcher record says whether the VEHICLE is
  // orbital-class: a positive `leo_capacity`. Still data, never the name.
  // A mission LL2 marks "Sub" (suborbital) is never orbital, whatever flies it.
  const config = raw.rocket && raw.rocket.configuration;
  const leoKg = config && config.leo_capacity;
  const orbitalLauncher = rawOrbitAbbrev !== "Sub" && typeof leoKg === "number" && Number.isFinite(leoKg) && leoKg > 0;

  return {
    id,
    name,
    net: raw.net,
    netPrecision,
    windowStart: raw.window_start,
    windowEnd: raw.window_end,
    status: statusAbbrev === "TBC" ? "TBD" : statusAbbrev, // fold TBC into TBD (no TBC variant in the frozen type)
    padId,
    padLocationId,
    orbitAbbrev,
    orbitalLauncher,
    lastUpdated: raw.last_updated,
  };
}

/**
 * Pure: raw LL2 `results` array -> the full `LaunchFeedPayload` shape,
 * given an explicit `now` (never `Date.now()` internally, §9). Separated
 * from `main()` so tests can exercise "empty results -> a valid empty
 * payload" and "a mix of valid/invalid results -> only the valid ones,
 * sorted" without spawning a process or touching the network.
 */
export function buildFeedPayload(rawResults, rangeLocationIds, now) {
  const windowEndMs = now.getTime() + WINDOW_DAYS * 86_400_000;
  const launches = [];
  for (const raw of rawResults) {
    const entry = toFeedEntry(raw, rangeLocationIds, now, windowEndMs);
    if (entry) launches.push(entry);
  }
  launches.sort((a, b) => Date.parse(a.net) - Date.parse(b.net));
  return { schemaVersion: SCHEMA_VERSION, generatedAt: now.toISOString(), launches };
}

/**
 * One full cycle: fetch LL2 (date/range-bounded, paginated up to
 * `maxPages`), validate/normalize, and — ONLY on success — write the
 * payload to `outPath`. Never calls `process.exit` itself (that's
 * `main()`'s job, as the real CLI entry point) so tests can call this
 * directly, in-process, with a stubbed `global.fetch` — the same
 * convention lib/sources/ripNwps.test.ts uses for its adapter, rather than
 * spawning a real subprocess (which can't reach a same-process test fixture
 * server through this environment's per-process network sandboxing).
 * Returns `{ ok: true, payload, pages }` on success or `{ ok: false,
 * reason, pages }` on failure — on failure (including hitting `maxPages`
 * without completing, §8), `outPath` is left completely untouched: never
 * re-stamp a previous publish, never write a partial one.
 */
export async function runOnce({ outPath, now = new Date(), rangeLocationIds, baseUrl = LL2_BASE, maxPages = MAX_PAGES }) {
  const windowEndMs = now.getTime() + WINDOW_DAYS * 86_400_000;
  const firstUrl = buildFirstPageUrl(baseUrl, rangeLocationIds, now, windowEndMs);
  const paged = await fetchAllUpcomingPages(firstUrl, windowEndMs, maxPages);
  if (!paged.ok) {
    return { ok: false, reason: paged.reason, pages: paged.pages };
  }
  const payload = buildFeedPayload(paged.results, rangeLocationIds, now);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload));
  return { ok: true, payload, fetchedCount: paged.results.length, pages: paged.pages };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name, def) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : def;
  };
  const outPath = path.resolve(flag("--out", "launch_data.json"));
  const mapPath = flag("--map", null); // test seam: override config/launchPads.ts with a JSON dump of location ids

  const rangeLocationIds = mapPath
    ? new Set(JSON.parse(fs.readFileSync(mapPath, "utf8")))
    : parseRangeLocationIds(path.resolve("config/launchPads.ts"));

  const result = await runOnce({ outPath, now: new Date(), rangeLocationIds });
  if (!result.ok) {
    console.error(
      `[launch_library] LL2 fetch failed (${result.reason ?? "unknown"}, ${result.pages ?? 0} page(s) attempted) — writing nothing, exiting non-zero`,
    );
    process.exit(1);
  }
  console.log(
    `[launch_library] wrote ${outPath}: ${result.payload.launches.length} launch(es) across the 4 ranges in the next ${WINDOW_DAYS} days (${result.fetchedCount} fetched from LL2 across ${result.pages} page(s))`,
  );
  return result.payload;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { toFeedEntry, normalizeNetPrecision, ORBIT_ALLOWLIST, ACTIVE_STATUS_ABBREVS, WINDOW_DAYS, MAX_PAGES, PACING_MIN_GAP_MS };
