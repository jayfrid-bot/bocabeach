// GET /sw-kill: the service worker's kill switch (public/sw.js, docs/SERVICE_WORKER.md).
//
// The worker asks this URL when it activates and at most every 30 minutes. A 200 "kill"
// answer makes it delete its caches and unregister itself. Anything else (the normal 404,
// a network error, a 500) leaves it running. Turn it on with the Worker variable SW_KILL=on:
//   npx wrangler secret put SW_KILL    (type: on)     -> live in seconds, no code deploy
// Turn it off again with `npx wrangler secret delete SW_KILL`.

import { isFlagOn } from "@/lib/plus/flags";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" };

export async function GET(): Promise<Response> {
  if (isFlagOn(process.env.SW_KILL)) return new Response("kill", { status: 200, headers: HEADERS });
  return new Response("ok", { status: 404, headers: HEADERS });
}
