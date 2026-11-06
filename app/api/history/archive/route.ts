// POST /api/history/archive — the hourly history archiver
// (docs/HISTORY_AND_IMAGERY_PLAN.md Part A, as amended by the "Codex review
// 2026-09-20", "Codex review 2026-09-22", "Codex round-2", and "Codex
// round-3" sections). Hit on a schedule (workers/history-cron) every minute
// with the shared CRON_SECRET — the SAME pattern as app/api/push/run/route.ts,
// but a SEPARATE route: that one 503s without a push transport and
// deliberately skips conditions loads, so it can't double as the archive
// trigger.
//
// Each call BUILDS at most `batch` (default 1, hard cap 1) candidate
// beaches: served beaches (config/locations.ts) with no `beach_hourly` row
// for the CURRENT UTC hour yet, filtered by the daylight rule for
// auto-tier beaches (lib/history/archive.ts `shouldArchiveNow`), and
// ordered fairly (never-archived-at-all first, then oldest-last-row-first,
// ties by slug — `listArchiveCandidates`) so a 2-minute-cadence worst case
// no longer starves the beaches at the end of a fixed config order (Codex
// round-3 finding #1). Ahead of that fair order come the beaches in their
// SUN-FORECAST HOUR (`sunWindowPriority`): the UTC clock hour that contains
// sunrise or sunset minus 60 min, when the app's sun-color score opens
// (lib/sunForecastWindow.ts). Such a beach is a candidate even before
// daylight, so the sunrise forecast of an auto beach gets archived too.
//
// SCANNING vs BUILDING (Codex round-3 finding #2 — head-of-line blocking):
// a beach whose claim is still live from an in-flight or recently-failed
// build used to make EVERY tick pick it (it was always first in some fixed
// order), lose the claim, and exit having built nothing — starving every
// other beach behind it. Fixed by separating "find something claimable"
// from "build it": the route walks candidates IN ORDER (capped at
// ARCHIVE_SCAN_CAP = 20, see that constant) and attempts claimHistoryBuild
// on each — claims are cheap D1 ops, safe to try
// several per request — until one is WON. Only that one beach ever reaches
// a budget reservation or a `getConditions` build; every candidate scanned
// before it is counted `skipped`. If no candidate's claim is won, the route
// returns immediately with `{ archived: 0, claimed: 0, ... }` and does no
// build at all. Beaches are processed SEQUENTIALLY, never Promise.all — a
// single cold `getConditions` build already fans out to ~21 adapters / ~24+
// fetches, and the free Workers plan allows only 50 SUBREQUESTS PER REQUEST
// (not per day) — one cold build (~25 fetches) plus this route's own D1
// reads/writes already eats most of that budget, so building more than 1
// beach per invocation risks tripping the per-request cap outright. Raising
// DEFAULT_BATCH/MAX_BATCH above 1 needs Workers Paid (no per-request
// subrequest cap there), not just a bigger daily budget. The cron itself now
// runs every minute (workers/history-cron/wrangler.jsonc, 1,440 ticks/day) —
// see that file's header for why the cadence moved off */2.
//
// CONCURRENCY: overlapping cron calls (or one call straddling a UTC hour or
// day boundary) used to be able to both read the same budget/candidates and
// both call getConditions before either wrote back — duplicate upstream
// calls, and the daily cap could be exceeded. Fixed with two reservations
// taken BEFORE any fetch, per candidate:
//   (a) claimHistoryBuild(slug, hour_utc) — an atomic INSERT ... ON CONFLICT
//       DO UPDATE into `history_claims` (migrations/0006_history.sql), the
//       same abandonment-window shape as the existing send_claims/claimSend
//       pattern: a claim with no `completed_at` after ABANDONED_CLAIM_MS
//       (10 min) may be re-claimed by a later tick (Codex round-2 finding
//       #4), instead of a failed build losing that (slug, hour) forever.
//   (b) reserveHistoryBuild(day, max) — a single conditional UPSERT on
//       `history_budget` ("increment only if builds < max") for the UTC day
//       AT THE MOMENT OF RESERVATION, so a run that crosses midnight charges
//       each build to its own day, not the run's start day.
// The hour_utc claimed in (a) is computed FRESH per candidate, right before
// claiming — not once at the top of the request — and is what the archived
// row is keyed by (via `rowFromConditions(res, loc, nowMs, { hourUtc })`).
// The build itself is DIRECT (`getConditionsForLocation`), never the ~120-s
// `getConditions` cache: that cache serves its expired entry and revalidates
// in the background, so an archiver reading it paid one budget unit for a
// stale snapshot it had to throw away, then another for the retry — one
// beach-hour cost two units, the 600/day budget ran out around 2 PM ET, and
// every beach lost its afternoon hours (2026-09-23 to 10-06: 600 reserved,
// ~330 rows a day). With a direct build, one reservation is exactly one
// pipeline run, the snapshot is always current for its claimed hour, and
// the day needs ~400 units.
//
// A build that fails after winning both reservations does NOT give the
// budget reservation back (conservative, and simpler than tracking in-flight
// builds) — but the CLAIM itself is now recoverable via the abandonment
// window above, so that slug/hour is retried by a later tick within the same
// hour rather than being lost for good.
//
// Idempotent: `upsertBeachHourly` only replaces an existing (slug, hour_utc)
// row when the new snapshot is strictly newer, so a retried or overlapping
// call can never regress or double-write a row.
//
// FREE-TIER BUDGET GUARD: one `getConditions` build ≈ 10 Open-Meteo calls.
// `HISTORY_MAX_BUILDS_PER_DAY` (default 600) caps how many builds this route
// will run per UTC calendar day, tracked in the `history_budget` D1 table.
// 600 builds ≈ 6,000 calls, which leaves ~4,000/day of Open-Meteo's free
// 10,000 for real visitor traffic. It no longer covers every beach-hour: the
// 63 served beaches want about 28 curated * 24h + 35 auto * ~12 daylight
// hours ≈ 1,090 builds/day, so the budget runs out during the UTC day.
//
// SUN RESERVE: when the budget ran out mid-afternoon Eastern, most beaches
// lost their sunset forecast hour, and the sunset forecast could not be
// graded (2026-11: sunset rows for ~11 of 63 beaches a day). So part of the
// budget is kept back. The ONE daily counter has two caps:
//   - an ordinary build may reserve only while
//     builds < max − (sun builds still due today) − SUN_RESERVE_SLACK;
//   - a sun-forecast build (`sunWindowPriority` at claim time) may reserve
//     while builds < max (600).
// "Sun builds still due today" is `sunBuildsDueToday` (lib/history/archive.ts):
// every beach's forecast hours from the current UTC hour to the end of the UTC
// day, under the same rule as `sunWindowPriority`, counting a current-hour
// beach only while it has no row yet. A day has about 126 of them at 00Z and
// only a handful late in the day, so ordinary builds run on almost to max
// instead of stopping a fixed 140 short (that fixed reserve stopped daytime
// archiving ~2.3 h early and left 72–91 builds a day unused). It is worked
// out once per call, and only when an ordinary build is about to reserve.
// Both caps use the same atomic `reserveHistoryBuild` statement, so the daily
// total can never pass max. Once a cap is spent, the route skips that class
// for the day and reports it — it never errors. The response's
// `sunWindowBuilds` counts the sun-forecast builds this call ran, and
// `budget.sunReserve` the reserve it applied (null when no ordinary build
// tried to reserve).
//
// `HISTORY_ENABLED` (default "on") lets the owner pause archiving instantly
// if the free tier gets tight: "off" makes the route return
// `{ disabled: true }` without touching the store or fetching anything.

import { timingSafeEqual } from "node:crypto";
import { getConditionsForLocation } from "@/lib/conditions";
import { SubrequestBudget, runWithBudget } from "@/lib/alerts/budget";
import { getLocation, listLocations } from "@/config/locations";
import { getStore } from "@/lib/db/store";
import { getD1 } from "@/lib/db/d1Store";
import { hourUtcOf, rowFromConditions, sunBuildsDueToday, sunWindowPriority } from "@/lib/history/archive";
import { sunEventRowsFromConditions } from "@/lib/history/sunPredictions";
import { archiveCamObservations, hasVisionCamFeed } from "@/lib/history/camObservations";
import { runHourlyWatchdog } from "@/lib/quality/watchdog";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Hard-capped at 1 — see the subrequest-budget note in the file header. A
// caller-supplied ?batch= above 1 is clamped, never rejected.
const DEFAULT_BATCH = 1;
const MAX_BATCH = 1;

/** Outbound fetches one direct build may make (Workers Free: 50 per request). */
const ARCHIVE_BUILD_SUBREQUESTS = 44;

// How many fairly-ordered candidates the scan phase will try to claim before
// giving up for this tick (Codex round-3 finding #2). Each try is one D1
// query, and D1 Free allows 50 queries per invocation: 20 tries plus the
// build's own writes stays well under it (40 could reach ~67). Fewer than the
// 63 served beaches, but a claim is only ever held by a build in flight or
// one that failed in the last 10 minutes, so 20 held claims in a row means
// something is badly wrong and the next tick tries again anyway.
const ARCHIVE_SCAN_CAP = 20;

/** Budget units kept back on top of the sun builds still due (see header). */
const SUN_RESERVE_SLACK = 5;

function secretEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function historyEnabled(): boolean {
  const raw = (process.env.HISTORY_ENABLED ?? "on").trim().toLowerCase();
  return raw !== "off" && raw !== "0" && raw !== "false";
}

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json({ error: "history archiver not configured (CRON_SECRET unset)" }, { status: 503 });
  }
  if (!secretEqual(req.headers.get("x-cron-secret") ?? "", secret)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!historyEnabled()) {
    return Response.json({ disabled: true });
  }

  const params = new URL(req.url).searchParams;
  const batchParam = Number(params.get("batch"));
  const batch = Number.isFinite(batchParam) && batchParam > 0 ? Math.min(Math.floor(batchParam), MAX_BATCH) : DEFAULT_BATCH;

  const maxPerDayEnv = Number(process.env.HISTORY_MAX_BUILDS_PER_DAY);
  const maxPerDay = Number.isFinite(maxPerDayEnv) && maxPerDayEnv >= 0 ? maxPerDayEnv : 600;
  const nowMs = Date.now();
  const startDay = utcDay(nowMs);

  const store = await getStore();

  const candidates = await store.listArchiveCandidates(nowMs);
  const scanned = candidates.slice(0, ARCHIVE_SCAN_CAP);

  // Sun reserve (see the file header), worked out at most once per call and
  // only when an ordinary build is about to reserve. Every beach without a row
  // this hour is in `candidates` (a sun-forecast beach skips the daylight
  // rule), so that list says which current-hour sun builds are still due. If
  // the clock has moved into the next hour since the listing, the list is
  // stale, so every current-hour sun build counts as due.
  let sunReserve: number | null = null;
  const ordinaryCapAt = (atMs: number): number => {
    if (sunReserve === null) {
      const pending = hourUtcOf(atMs) === hourUtcOf(nowMs) ? new Set(candidates.map((c) => c.slug)) : null;
      sunReserve = Math.min(maxPerDay, sunBuildsDueToday(listLocations(), atMs, pending) + SUN_RESERVE_SLACK);
    }
    return maxPerDay - sunReserve;
  };

  let archived = 0;
  let deduped = 0;
  let skipped = 0;
  let claimed = 0;
  let sunWindowBuilds = 0;
  // Two caps, so two flags: once the ordinary share is spent, a sun-forecast
  // winner may still reserve; once the whole budget is spent, nothing may.
  let ordinaryExhausted = false;
  let budgetExhausted = false;
  // The UTC day of the LAST successful budget reservation this run, and
  // whether a second (earlier) day was also touched — a run straddling UTC
  // midnight charges builds to more than one day (Codex round-2 finding #6).
  let lastReservedDay = startDay;
  let touchedEarlierDay = false;

  // --- Scan phase (Codex round-3 finding #2): walk fairly-ordered
  // candidates trying a claim on each, until one is WON. `batch` (hard-
  // capped at 1, see MAX_BATCH) is how many winners get built this call —
  // today always at most one — so as soon as that many winners are found,
  // scanning stops; ARCHIVE_SCAN_CAP bounds the worst case where nothing is
  // claimable at all. Every candidate whose claim attempt loses (or which
  // has no config entry) here is counted `skipped` — a beach that's held by
  // an earlier, still-live claim no longer blocks every beach behind it.
  const winners: Array<{
    slug: string;
    loc: NonNullable<ReturnType<typeof getLocation>>;
    hourUtc: string;
    sunWindow: boolean;
  }> = [];
  for (const c of scanned) {
    if (winners.length >= batch) break;
    const loc = getLocation(c.slug);
    if (!loc) {
      skipped += 1;
      continue;
    }

    // The claimed hour is computed FRESH per candidate, right before
    // claiming — never reused from the top of the request — because it is
    // what the eventual row must be keyed by (see file header, finding #1).
    const claimNowMs = Date.now();
    const claimedHourUtc = hourUtcOf(claimNowMs);

    const won = await store.claimHistoryBuild(c.slug, claimedHourUtc, claimNowMs);
    if (!won) {
      skipped += 1;
      continue;
    }
    claimed += 1;
    // Sun-forecast class is judged at the CLAIM instant, the same instant the
    // row's hour is keyed by, so the two always agree. The listing already
    // worked it out for its own hour; only a claim in a later hour recomputes.
    const sunWindow =
      claimedHourUtc === hourUtcOf(nowMs) ? c.sunEventMs !== undefined : sunWindowPriority(c, claimNowMs);
    winners.push({ slug: c.slug, loc, hourUtc: claimedHourUtc, sunWindow });
  }

  const remaining = candidates.length - winners.length;

  // --- Build phase: only a WON claim ever reaches a budget reservation or a
  // getConditions call. If no candidate's claim was won, this loop simply
  // doesn't run and the response below reports `{ archived: 0, claimed: 0 }`.
  for (const { slug, loc, hourUtc: claimedHourUtc, sunWindow } of winners) {
    if (budgetExhausted || (ordinaryExhausted && !sunWindow)) {
      // Budget already ran out earlier in this same loop — the claim above
      // is deliberately kept (its abandonment window still applies), this
      // slug just won't be built this hour by this run.
      skipped += 1;
      continue;
    }

    // Reserve one budget unit for the day AT reservation time, so a run
    // that crosses UTC midnight charges each build to its own day. Same
    // atomic statement for both classes; only the cap differs.
    const reserveNowMs = Date.now();
    const day = utcDay(reserveNowMs);
    const reserved = await store.reserveHistoryBuild(day, sunWindow ? maxPerDay : ordinaryCapAt(reserveNowMs));
    if (!reserved) {
      if (sunWindow) budgetExhausted = true;
      else ordinaryExhausted = true;
      skipped += 1;
      continue;
    }
    if (day !== lastReservedDay) touchedEarlierDay = true;
    lastReservedDay = day;

    // One reservation, one real build (see the file header): never the
    // cached getConditions, whose expired entry would cost a second unit.
    // The build runs under its own subrequest budget: a cold build is ~25
    // outbound calls, but a broad upstream outage can retry every source at
    // once and cross Workers' 50-per-request ceiling, which kills the
    // request with no warning. 44 leaves room for the cam-feed fetch below.
    // A build the gate had to cut short is incomplete in a way the row
    // can't record, so it is not archived; the claim ages out and a later
    // tick retries.
    const buildBudget = new SubrequestBudget(ARCHIVE_BUILD_SUBREQUESTS);
    let res;
    try {
      res = await runWithBudget(buildBudget, () => getConditionsForLocation(loc));
      if (buildBudget.exhaustedDuringBuild) {
        console.error("history: build hit the subrequest budget, not archived", slug);
        res = null;
      }
    } catch (e) {
      console.error("history: conditions build failed", slug, e);
      res = null;
    }
    if (!res) {
      skipped += 1;
      continue;
    }

    try {
      const row = rowFromConditions(res, loc, nowMs, { hourUtc: claimedHourUtc });
      const { written } = await store.upsertBeachHourly(row);
      // Sun-event prediction log (migrations/0013): the next sunrise + sunset,
      // same pass. Best-effort — a failure here logs and is skipped; it must
      // never fail the beach_hourly row that already landed above.
      try {
        const sunRows = sunEventRowsFromConditions(res, loc, nowMs, { hourUtc: claimedHourUtc });
        if (sunRows.length) {
          // The beach_hourly row just landed, which takes this beach out of the
          // candidate list for the hour — so nothing later would retry a
          // transient D1 failure here. Retry the (idempotent) upsert once
          // inline; a second failure falls to the catch below and is skipped.
          try {
            await store.upsertSunEventPredictions(sunRows);
          } catch (first) {
            console.error("history: sun-event predictions write failed, retrying once", slug, first);
            await store.upsertSunEventPredictions(sunRows);
          }
        }
      } catch (e) {
        console.error("history: sun-event predictions failed", slug, e);
      }
      // Cam reads (cam_observations + cam_reads, migrations 0006/0014): keep the
      // cam archive current from the beach's published vision feed. Same rule —
      // a feed that is down or malformed logs and is skipped, never failing the
      // beach_hourly row.
      if (hasVisionCamFeed(slug)) {
        try {
          await archiveCamObservations(store, slug);
        } catch (e) {
          console.error("history: cam observations failed", slug, e);
        }
      }
      // Quality watchdog (docs/QUALITY_PLAN.md): compare this hour to the last for
      // an unexplained jump in score, surf, sand or clarity, and record an alert. It sends
      // nothing: the owner push is queued and sent by the drain step (POST /api/quality/drain).
      // Only on a row that really landed. Same rule as the steps above: a
      // watchdog failure logs and is skipped, never failing the beach_hourly row.
      if (written) {
        try {
          const db = await getD1();
          if (db) await runHourlyWatchdog(db, row, Date.now());
        } catch (e) {
          console.error("history: quality watchdog failed", slug, e);
        }
      }
      await store.completeHistoryClaim(slug, claimedHourUtc, Date.now());
      if (written) archived += 1;
      else deduped += 1;
      if (sunWindow) sunWindowBuilds += 1;
    } catch (e) {
      console.error("history: archive failed", slug, e);
      skipped += 1;
      // Claim deliberately left incomplete — its abandonment window lets a
      // later tick retry this (slug, hour) within the same hour.
    }
  }

  // Reporting only: a failed read here must not turn a finished archive pass
  // into a 500 (the row, claim and budget unit have already landed).
  const usedOf = async (day: string): Promise<number | null> => {
    try {
      return await store.getHistoryBudget(day);
    } catch (e) {
      console.error("history: budget read for the report failed", day, e);
      return null;
    }
  };
  const usedStartDay = await usedOf(startDay);
  const budget =
    touchedEarlierDay || lastReservedDay !== startDay
      ? {
          day: lastReservedDay,
          used: lastReservedDay === startDay ? usedStartDay : await usedOf(lastReservedDay),
          max: maxPerDay,
          sunReserve,
          alsoDay: startDay,
          alsoUsed: usedStartDay,
        }
      : { day: startDay, used: usedStartDay, max: maxPerDay, sunReserve };

  return Response.json({
    archived,
    deduped,
    skipped,
    claimed,
    remaining,
    sunWindowBuilds,
    budget,
    ...(budgetExhausted
      ? { note: "daily build budget reached" }
      : ordinaryExhausted
        ? { note: "ordinary build budget reached; sun reserve kept for sun-forecast builds" }
        : {}),
  });
}
