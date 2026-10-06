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
// round-3 finding #1).
//
// SCANNING vs BUILDING (Codex round-3 finding #2 — head-of-line blocking):
// a beach whose claim is still live from an in-flight or recently-failed
// build used to make EVERY tick pick it (it was always first in some fixed
// order), lose the claim, and exit having built nothing — starving every
// other beach behind it. Fixed by separating "find something claimable"
// from "build it": the route walks candidates IN ORDER (capped at
// ARCHIVE_SCAN_CAP = 40, comfortably above the ~39 served beaches) and
// attempts claimHistoryBuild on each — claims are cheap D1 ops, safe to try
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
// 600 leaves headroom under Open-Meteo's free 10,000/day: the 39 served
// beaches need roughly 3 curated * 24h + 36 auto * ~13 daylight hours ≈ 540
// builds/day, and 600 builds ≈ 6,000 calls still leaves ~4,000/day for real
// visitor traffic. Once the budget is spent, the route stops archiving for
// the day and reports it — it never errors.
//
// `HISTORY_ENABLED` (default "on") lets the owner pause archiving instantly
// if the free tier gets tight: "off" makes the route return
// `{ disabled: true }` without touching the store or fetching anything.

import { timingSafeEqual } from "node:crypto";
import { getConditionsForLocation } from "@/lib/conditions";
import { SubrequestBudget, runWithBudget } from "@/lib/alerts/budget";
import { getLocation } from "@/config/locations";
import { getStore } from "@/lib/db/store";
import { hourUtcOf, rowFromConditions } from "@/lib/history/archive";
import { sunEventRowsFromConditions } from "@/lib/history/sunPredictions";
import { archiveCamObservations, hasVisionCamFeed } from "@/lib/history/camObservations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Hard-capped at 1 — see the subrequest-budget note in the file header. A
// caller-supplied ?batch= above 1 is clamped, never rejected.
const DEFAULT_BATCH = 1;
const MAX_BATCH = 1;

/** Outbound fetches one direct build may make (Workers Free: 50 per request). */
const ARCHIVE_BUILD_SUBREQUESTS = 44;

// How many fairly-ordered candidates the scan phase will try to claim before
// giving up for this tick (Codex round-3 finding #2). Comfortably above the
// ~39 served beaches, so a single tick can always find a winner if ANY
// candidate's claim is free, however many beaches ahead of it are currently
// held by another in-flight/abandoned-but-not-yet-expired claim.
const ARCHIVE_SCAN_CAP = 40;

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

  let archived = 0;
  let deduped = 0;
  let skipped = 0;
  let claimed = 0;
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
  const winners: Array<{ slug: string; loc: NonNullable<ReturnType<typeof getLocation>>; hourUtc: string }> = [];
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
    winners.push({ slug: c.slug, loc, hourUtc: claimedHourUtc });
  }

  const remaining = candidates.length - winners.length;

  // --- Build phase: only a WON claim ever reaches a budget reservation or a
  // getConditions call. If no candidate's claim was won, this loop simply
  // doesn't run and the response below reports `{ archived: 0, claimed: 0 }`.
  for (const { slug, loc, hourUtc: claimedHourUtc } of winners) {
    if (budgetExhausted) {
      // Budget already ran out earlier in this same loop — the claim above
      // is deliberately kept (its abandonment window still applies), this
      // slug just won't be built this hour by this run.
      skipped += 1;
      continue;
    }

    // Reserve one budget unit for the day AT reservation time, so a run
    // that crosses UTC midnight charges each build to its own day.
    const day = utcDay(Date.now());
    const reserved = await store.reserveHistoryBuild(day, maxPerDay);
    if (!reserved) {
      budgetExhausted = true;
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
      await store.completeHistoryClaim(slug, claimedHourUtc, Date.now());
      if (written) archived += 1;
      else deduped += 1;
    } catch (e) {
      console.error("history: archive failed", slug, e);
      skipped += 1;
      // Claim deliberately left incomplete — its abandonment window lets a
      // later tick retry this (slug, hour) within the same hour.
    }
  }

  const usedStartDay = await store.getHistoryBudget(startDay);
  const budget =
    touchedEarlierDay || lastReservedDay !== startDay
      ? {
          day: lastReservedDay,
          used: lastReservedDay === startDay ? usedStartDay : await store.getHistoryBudget(lastReservedDay),
          max: maxPerDay,
          alsoDay: startDay,
          alsoUsed: usedStartDay,
        }
      : { day: startDay, used: usedStartDay, max: maxPerDay };

  return Response.json({
    archived,
    deduped,
    skipped,
    claimed,
    remaining,
    budget,
    ...(budgetExhausted ? { note: "daily build budget reached" } : {}),
  });
}
