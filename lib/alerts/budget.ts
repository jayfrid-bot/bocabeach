import { AsyncLocalStorage } from "node:async_hooks";
import { setSubrequestHook } from "@/lib/util";

// A small counter for Workers Free's 50-outbound-subrequest-per-request
// ceiling (Codex round-2 review #4). `/api/push/run` makes outbound network
// calls from two places in the same request — the home-digest loop
// (app/api/push/run/route.ts) and the at-beach engine (lib/alerts/run.ts) —
// each of which can fan out to dozens of calls (a cold conditions build alone
// fetches up to 21 sources, see lib/conditions.ts's getSnapshotForLocation).
// Blow through 50 and the platform kills the REST of the request outright,
// including whatever Live Activity end-sweep or ordinary alert sends were
// still queued — silently dropping work that had nothing to do with what
// tipped the counter over. This budget is pure bookkeeping (it makes no calls
// itself): every call site that is about to spend one or more subrequests
// checks it FIRST, so a run that is running low degrades on purpose — Live
// Activity sends and low-priority beaches are skipped and left for the next
// tick — rather than being cut off mid-request by the platform.
//
// D1 calls (getStore()'s D1 backend, lib/db/d1Store.ts) do NOT count against
// this ceiling and are never charged here — Cloudflare's subrequest limit
// applies to outbound `fetch()` calls (including calls the runtime makes
// through `fetch` under the hood, like APNs/FCM HTTP sends and every
// lib/sources/*.ts conditions fetch); binding RPCs — D1, KV, R2, Queues,
// Durable Objects — are a separate, much higher-ceilinged mechanism and are
// exempt. See https://developers.cloudflare.com/workers/platform/limits/
// ("Subrequests" — bindings are called out as not counting).
export class SubrequestBudget {
  private remaining: number;
  /** Codex round-5 #1: set true the moment the gate (below) refuses a real
   *  fetch anywhere in this budget's whole request — not per-conditions-build,
   *  since once `remaining` hits 0 every subsequent gate check refuses too, so
   *  a flag on the shared budget instance already answers "did any build
   *  running under me see a refusal" correctly for every build that started
   *  at or after the first refusal. `lib/conditions.ts` reads this after a
   *  cold build to decide whether the resulting (deliberately incomplete)
   *  snapshot may be written to the shared 120-s cache. */
  exhaustedDuringBuild = false;

  constructor(total: number) {
    this.remaining = Math.max(0, total);
  }

  /** True iff `n` more subrequests are still affordable. Read-only — does
   *  not spend anything, so a caller can check before deciding whether to
   *  even attempt the work. */
  reserve(n: number): boolean {
    return n <= this.remaining;
  }

  /** Consume `n` subrequests. Never goes negative — a caller that ends up
   *  spending more than it reserved (a cold build that fetches more sources
   *  than expected, say) just runs the budget to 0 rather than throwing. */
  spend(n: number): void {
    this.remaining = Math.max(0, this.remaining - n);
  }

  /** Convenience for the common "check then spend" call site: reserves and
   *  immediately spends `n` if affordable, or spends nothing and returns
   *  false. */
  take(n: number): boolean {
    if (!this.reserve(n)) return false;
    this.spend(n);
    return true;
  }

  /** What's left — diagnostics only (the JSON response, logging). */
  get left(): number {
    return this.remaining;
  }
}

/** 50 (Workers Free's per-request ceiling) minus a safety margin: the
 *  ceiling is enforced by the platform mid-request with no warning, and this
 *  run makes bookkeeping D1 calls and other incidental work around the
 *  charged fetches — the margin absorbs anything this budget doesn't
 *  explicitly account for. Override with PUSH_RUN_SUBREQUEST_BUDGET for a
 *  paid plan's higher ceiling. */
const DEFAULT_PUSH_RUN_BUDGET = 44;

export function pushRunSubrequestBudget(): number {
  const n = Number(process.env.PUSH_RUN_SUBREQUEST_BUDGET);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_PUSH_RUN_BUDGET;
}

/** How many home beaches (each a full conditions fetch, worst case) one run
 *  will start work on — the rest are left for the next tick rather than
 *  contending for the same shrinking subrequest budget. No persisted
 *  rotation cursor exists for beach slugs (unlike Live Activity rows, which
 *  have `next_send_at` — lib/db/store.ts's `touchLiveActivityCursor`), so
 *  which beaches get in is decided by a round-robin keyed off the clock
 *  instead: deterministic, needs no extra store write, and spreads beaches
 *  evenly across ticks the same way a persisted cursor would. Override with
 *  PUSH_RUN_MAX_BEACHES. */
const DEFAULT_PUSH_RUN_MAX_BEACHES = 2;

export function pushRunMaxBeaches(): number {
  const n = Number(process.env.PUSH_RUN_MAX_BEACHES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_PUSH_RUN_MAX_BEACHES;
}

/** How many DISTINCT 0.05° cells one run's at-beach loop will fetch the
 *  Open-Meteo minutely rain fallback for (lib/alerts/rain.ts's `RainCache`,
 *  Codex round-4 #3) — armed devices past the cap still get evaluated for
 *  every OTHER hazard, they just read "no rain fallback data" this run.
 *  Override with PUSH_RUN_MAX_RAIN_CELLS. */
const DEFAULT_PUSH_RUN_MAX_RAIN_CELLS = 4;

export function pushRunMaxRainCells(): number {
  const n = Number(process.env.PUSH_RUN_MAX_RAIN_CELLS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_PUSH_RUN_MAX_RAIN_CELLS;
}

/**
 * Codex round-3 #4b: the minimum `budget.left` each named stage of
 * `/api/push/run` requires before it even STARTS, checked once up front —
 * not a per-item guess, just enough to make one meaningful unit of progress
 * (one send, or one feed load) worth attempting. A stage short of its
 * reserve is skipped entirely this run (counted as `deferred`, never
 * thrown) and picked back up on the next tick, 5 minutes later, same
 * backstop shape PUSH_RUN_MAX_BEACHES already uses for beach selection.
 * Real per-item spends (a send, a conditions fetch) still degrade
 * gracefully mid-stage via `budget.take()`/`.left` checks even after a
 * stage has been allowed to start — this is only the "is it worth even
 * trying" gate.
 */
export const STAGE_RESERVE = {
  /** One send (APNs/FCM) — a cold conditions build for the slug the loop is
   *  about to visit is real-counted as it happens, not reserved for. */
  homeDigests: 1,
  /** Same reasoning as `homeDigests` — the at-beach loop's own conditions
   *  builds are real-counted, not reserved for. */
  atBeach: 1,
  /** One HTTP call for the shared lightning-strike feed. */
  lightning: 1,
  /** One Live Activity update push. */
  liveActivityUpdates: 1,
  /** One Live Activity end push. */
  liveActivityEnds: 1,
} as const;

/**
 * Round-robin, by clock tick, over a sorted list of keys — no store write
 * needed. `tickMs` should be the cron's own interval (the push-run schedule)
 * so consecutive runs advance the window instead of re-picking the same
 * slice; `nowMs` and `tickMs` are both caller-supplied so this stays pure and
 * clock-injectable for tests.
 */
export function timeRoundRobinSlice<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  max: number,
  nowMs: number,
  tickMs: number,
): T[] {
  if (items.length <= max) return [...items];
  const sorted = [...items].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
  const tick = tickMs > 0 ? Math.floor(nowMs / tickMs) : 0;
  const offset = ((tick % sorted.length) + sorted.length) % sorted.length;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(sorted[(offset + i) % sorted.length]);
  return out;
}

// --- Real subrequest counting (Codex round-3 #4) ----------------------------
//
// Replaces the static "21 subrequests" charged up front by every caller that
// wanted to account for a conditions build — that estimate (a) double-counted
// when the SAME conditions build was reachable from both the home-digest loop
// and the at-beach engine in the same request (app/api/push/run/route.ts
// ~359 and lib/alerts/run.ts ~430, both charging the full 21 for what is, by
// getConditions' own per-slug memoization, actually ONE build), and (b) was a
// worst case regardless of what actually happened — a warm cache, or a
// beach's own conditions.ts cache, spends far fewer than 21 real fetches, and
// this now reads exactly that off the wire.
//
// AsyncLocalStorage carries the current request's budget across every await
// in its call graph, however deeply nested (a source adapter three calls
// inside getConditions), without threading a budget parameter through
// lib/conditions.ts and every lib/sources/*.ts adapter. `lib/util.ts`'s
// `fetchWithTimeout` — the one seam nearly every adapter's outbound fetch
// goes through (`fetchJsonWithRetry` calls it too) — fires a hook on every
// call; this module installs that hook, as a side effect of being imported,
// to spend 1 from whatever budget `runWithBudget` is currently running with.
// lib/util.ts itself never imports this file (or Node/ALS) — see its doc —
// so it stays safe to import from a "use client" component.
const budgetContext = new AsyncLocalStorage<SubrequestBudget>();

/** Run `fn` with `budget` as the ambient subrequest budget for every real
 *  fetch made anywhere in its call graph. Both `/api/push/run` call sites
 *  (the home-digest loop and `runAtBeachAlerts`) run inside the SAME
 *  `runWithBudget` for the whole request, so a fetch made from deep inside
 *  either one spends from the one shared counter exactly once. */
export function runWithBudget<T>(budget: SubrequestBudget, fn: () => Promise<T>): Promise<T> {
  return budgetContext.run(budget, fn);
}

/** Read the ambient budget, if any — used by callers that want to gate on
 *  `.left`/`.reserve()` without having threaded the budget instance down to
 *  where they are (falls back to the caller's own reference when it has
 *  one; this exists for symmetry with `spendAmbientSubrequest`). */
export function currentBudget(): SubrequestBudget | undefined {
  return budgetContext.getStore();
}

// Round-4 #3: a GATE, not just a counter — `reserve` is checked BEFORE
// `spend`, so once the ambient budget hits 0 this returns false and
// `fetchWithTimeout` throws instead of ever calling `fetch()`. The old
// "spend(1) unconditionally, let the platform kill the request later"
// policy let a cold conditions build with parallel sources issue every one
// of its calls regardless of budget.
setSubrequestHook(() => {
  const budget = budgetContext.getStore();
  if (!budget) return true; // no ambient budget (e.g. outside /api/push/run) — unrestricted
  if (!budget.reserve(1)) {
    budget.exhaustedDuringBuild = true; // Codex round-5 #1
    return false;
  }
  budget.spend(1);
  return true;
});
