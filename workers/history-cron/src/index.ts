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
 */

export interface Env {
  CRON_SECRET: string;
}

/** app.isitbeachday.com is the Worker's own hostname (not the marketing site). */
const RUN_URL = "https://app.isitbeachday.com/api/history/archive";

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

export default {
  async scheduled(_ctrl: ScheduledController, env: Env): Promise<void> {
    const r = await runOnce(env);
    console.log("history-cron:", JSON.stringify(r));
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    if (!env.CRON_SECRET || req.headers.get("x-cron-secret") !== env.CRON_SECRET) {
      return new Response("unauthorized", { status: 401 });
    }
    const r = await runOnce(env);
    return Response.json(r, { status: r.ok ? 200 : 502 });
  },
};
