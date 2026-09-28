/**
 * plus-cron — the clock for Beach Day notifications.
 *
 * Every 5 minutes it POSTs the app's sender, which does all the thinking: the
 * morning summary at beach-local 08:00, the sky-events "coming up" alert
 * (SKY_EVENTS_PLAN.md §10), and safety alerts only for devices with a live
 * presence window. This Worker holds no state and makes no decisions, so a
 * missed tick costs one 5-minute delay and nothing else.
 *
 * MULTIPLE PASSES PER TICK (Codex round-2 HIGH): the app route only starts
 * work on `PUSH_RUN_MAX_BEACHES` (default 2) home beaches per request — real,
 * on purpose, so one request never contends for the shared 50-subrequest
 * Workers Free ceiling across more cold conditions builds than it can afford
 * (lib/alerts/budget.ts). At a single pass per 5-minute tick, that caps a
 * single timezone's whole 8:00 AM hour at ~13 distinct beaches (12 ticks,
 * round-robin window of 2) — with 14+ subscribed beaches in one timezone,
 * some silently never get their morning digest OR their coming-up alert that
 * day. Same fix as workers/history-cron/src/index.ts: run several passes
 * SEQUENTIALLY per scheduled tick, each its own HTTP request to the app (so
 * each gets its OWN fresh subrequest budget — the app deliberately does one
 * cold conditions build's worth of work per request, never batches several
 * into one), stopping early once a pass reports nothing left to do. Default
 * 3 passes × 2 beaches × 12 ticks/hour = 72 beach-visits of capacity per
 * timezone's 8 AM hour — comfortably above this app's beach count.
 *
 * WHY A SEPARATE WORKER: the app runs on OpenNext, whose bundle owns the main
 * Worker's entry point — there is no place to hang a `scheduled()` handler. Same
 * pattern as workers/uw-frame.
 *
 * SETUP: `wrangler secret put CRON_SECRET` here with the SAME value the app
 * Worker has, then `wrangler deploy`. Without it every run answers 503 and
 * nothing is sent.
 *
 * GET / runs one pass on demand so the pipeline can be proved with curl — it
 * needs the same `x-cron-secret` header, so the public URL is not a free trigger.
 */

export interface Env {
  CRON_SECRET: string;
  /**
   * How many `/api/push/run` passes one SCHEDULED tick makes, SEQUENTIALLY —
   * see the module doc above. Each pass is its own HTTP request, so each
   * gets its own subrequest budget on the app side. Default 3, capped at 6
   * (raising it further just spends more of the Worker's own CPU-time
   * budget for a tick that's already found nothing due). The on-demand
   * `fetch()` handler (curl / `GET /`) always makes exactly ONE pass,
   * unaffected by this — it exists to prove the pipeline works, not to
   * replay a whole hour's coverage.
   */
  PASSES_PER_TICK?: string;
}

/** app.isitbeachday.com is the Worker's own hostname (not the marketing site). */
const RUN_URL = "https://app.isitbeachday.com/api/push/run?mode=all";

interface RunResult {
  ok: boolean;
  status: number;
  body: string;
}

/** One pass. Never throws — a failed tick is logged and the next one retries. */
async function runOnce(env: Env): Promise<RunResult> {
  if (!env.CRON_SECRET) {
    return { ok: false, status: 0, body: "CRON_SECRET not set on plus-cron" };
  }
  try {
    const res = await fetch(RUN_URL, {
      method: "POST",
      headers: { "x-cron-secret": env.CRON_SECRET },
    });
    // The sender answers a small JSON object; keep it whole in the log so
    // `wrangler tail` shows the counts.
    const body = (await res.text()).slice(0, 2000);
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: `fetch failed: ${(e as Error).message}` };
  }
}

/**
 * Nothing left for an IMMEDIATE next pass to usefully pick up: no home beach
 * was left waiting on capacity (`beachesDeferred`), and the at-beach engine
 * didn't defer any of its own stages either (`alerts.deferred` — lightning
 * feed load, ordinary alert sends, Live Activity updates/ends, all gated the
 * same way, lib/alerts/budget.ts's `STAGE_RESERVE`). A response this route
 * can't even parse is treated as "not idle" — better an extra harmless pass
 * than silently stopping short on a shape change.
 */
function isIdle(body: string): boolean {
  try {
    const j = JSON.parse(body) as { beachesDeferred?: number; alerts?: { deferred?: number } };
    return (j.beachesDeferred ?? 0) === 0 && (j.alerts?.deferred ?? 0) === 0;
  } catch {
    return false;
  }
}

export default {
  async scheduled(_ctrl: ScheduledController, env: Env): Promise<void> {
    const passes = Math.min(6, Math.max(1, Number(env.PASSES_PER_TICK) || 3));
    for (let i = 1; i <= passes; i++) {
      const r = await runOnce(env);
      console.log(`plus-cron pass ${i}/${passes}:`, JSON.stringify(r));
      if (!r.ok) break; // a failing app answers the same way next pass — don't hammer it
      if (isIdle(r.body)) break; // every due beach and at-beach stage got a turn this tick
    }
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    if (!env.CRON_SECRET || req.headers.get("x-cron-secret") !== env.CRON_SECRET) {
      return new Response("unauthorized", { status: 401 });
    }
    const r = await runOnce(env);
    return Response.json(r, { status: r.ok ? 200 : 502 });
  },
};
