/**
 * history-cron — the clock for the hourly beach history archiver.
 *
 * Every minute it POSTs the app's archive route, which does all the
 * thinking: which beaches still need a row for the current UTC hour, the
 * daylight-only rule for auto-tier beaches, and the daily build-budget guard.
 * This Worker holds no state and makes no decisions, so a missed tick just
 * means the next one picks up whatever is still due.
 *
 * WHY A SEPARATE WORKER: same reason as workers/plus-cron — the app runs on
 * OpenNext, whose bundle owns the main Worker's entry point, so there is no
 * place to hang a `scheduled()` handler inside it.
 *
 * WHY A SEPARATE WORKER FROM plus-cron: they trigger two different routes
 * with two different jobs (push notifications vs. history archiving) that
 * should be able to fail, retry, and scale independently of each other.
 *
 * SETUP: `wrangler secret put CRON_SECRET` here with the SAME value the app
 * Worker has, then `wrangler deploy`. Without it every run answers 503 and
 * nothing is archived.
 *
 * GET / runs one pass on demand so the pipeline can be proved with curl — it
 * needs the same `x-cron-secret` header, so the public URL is not a free trigger.
 *
 * DAILY PURGE (webcam archive, docs/CAM_ARCHIVE_PLAN.md R5): there is NO second
 * cron expression (the account is on the Workers Free plan, 5 cron triggers
 * per account, all spoken for). Instead the every-minute tick whose scheduled
 * time is 08:17 UTC first POSTs /api/cam-frames/purge, then runs the normal
 * archive pass. A purge failure is logged and never stops the archive call.
 * GET /?task=purge runs the purge on demand, behind the same secret.
 */

export interface Env {
  CRON_SECRET: string;
  /**
   * How many archive passes one scheduled tick makes, SEQUENTIALLY. Each pass
   * is its own HTTP request to the app, so each gets its own subrequest budget
   * on the app side (one cold conditions build ≈ 25 of the Free plan's 50) —
   * the app route deliberately does one build per request. Default 1. Raise
   * it (e.g. 5 on a five-minute schedule) only if the platform will not run a
   * once-a-minute trigger; a tick stops early once a pass finds nothing to do.
   */
  PASSES_PER_TICK?: string;
}

/** app.isitbeachday.com is the Worker's own hostname (not the marketing site). */
const RUN_URL = "https://app.isitbeachday.com/api/history/archive";
/** Daily cleanup of the webcam archive index (D1 rows past 365 days, stale pending rows). */
const PURGE_URL = "https://app.isitbeachday.com/api/cam-frames/purge";
/** The purge rides the every-minute tick that lands on this UTC time. */
const PURGE_HOUR_UTC = 8;
const PURGE_MINUTE_UTC = 17;

/** True when this tick's scheduled time is 08:17 UTC. */
function isPurgeTick(scheduledTime: number): boolean {
  const t = new Date(scheduledTime);
  return t.getUTCHours() === PURGE_HOUR_UTC && t.getUTCMinutes() === PURGE_MINUTE_UTC;
}

interface RunResult {
  ok: boolean;
  status: number;
  body: string;
}

/** One pass. Never throws — a failed tick is logged and the next one retries. */
async function runOnce(env: Env): Promise<RunResult> {
  if (!env.CRON_SECRET) {
    return { ok: false, status: 0, body: "CRON_SECRET not set on history-cron" };
  }
  try {
    const res = await fetch(RUN_URL, {
      method: "POST",
      headers: { "x-cron-secret": env.CRON_SECRET },
    });
    // The archive route answers a small JSON object; keep it whole in the log
    // so `wrangler tail` shows the counts.
    const body = (await res.text()).slice(0, 2000);
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: `fetch failed: ${(e as Error).message}` };
  }
}

/** One purge call. Never throws — a failed run is logged and tomorrow's retries. */
async function runPurge(env: Env): Promise<RunResult> {
  if (!env.CRON_SECRET) {
    return { ok: false, status: 0, body: "CRON_SECRET not set on history-cron" };
  }
  try {
    const res = await fetch(PURGE_URL, {
      method: "POST",
      headers: { "x-cron-secret": env.CRON_SECRET },
    });
    const body = (await res.text()).slice(0, 2000);
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: `fetch failed: ${(e as Error).message}` };
  }
}

export default {
  async scheduled(ctrl: ScheduledController, env: Env): Promise<void> {
    if (isPurgeTick(ctrl.scheduledTime)) {
      // runPurge never throws; the archive pass below runs whatever it returns.
      console.log("history-cron cam-frames purge:", JSON.stringify(await runPurge(env)));
    }
    const passes = Math.min(10, Math.max(1, Number(env.PASSES_PER_TICK) || 1));
    for (let i = 1; i <= passes; i++) {
      const r = await runOnce(env);
      console.log(`history-cron pass ${i}/${passes}:`, JSON.stringify(r));
      if (!r.ok) break; // a failing app answers the same way next pass — don't hammer it
      // Stop early when the route reports nothing was claimed or archived: every
      // eligible beach already has its row for this hour (or the budget is spent).
      let idle = false;
      try {
        const j = JSON.parse(r.body) as { archived?: number; claimed?: number; disabled?: boolean };
        idle = j.disabled === true || ((j.archived ?? 0) === 0 && (j.claimed ?? 0) === 0);
      } catch {
        idle = true;
      }
      if (idle) break;
    }
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    if (!env.CRON_SECRET || req.headers.get("x-cron-secret") !== env.CRON_SECRET) {
      return new Response("unauthorized", { status: 401 });
    }
    const task = new URL(req.url).searchParams.get("task");
    const r = task === "purge" ? await runPurge(env) : await runOnce(env);
    return Response.json(r, { status: r.ok ? 200 : 502 });
  },
};
