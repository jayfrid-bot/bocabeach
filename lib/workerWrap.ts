// The Worker entry's wrapper (worker.ts). OpenNext's handler returns Next's response as a
// stream, and the platform then sends it `Transfer-Encoding: chunked` with no Content-Length,
// whatever the route set. For the agent surface that is the wrong shape (clients want a complete
// body with a size they can check), so for these paths ONLY we read the whole body, rebuild the
// response with an explicit Content-Length, and drop Next's App Router `Vary` tokens (rsc,
// next-router-*), which do not apply to JSON or text endpoints and only fragment caches.
// Every other path is passed through untouched, so streaming pages keep streaming.
//
// No imports from the app (this file is bundled by wrangler); keep it that way.

/** Exact paths and prefixes that get a buffered, Content-Length response. */
const EXACT_PATHS = new Set(["/mcp", "/llms.txt"]);
const PREFIXES = ["/api/v1/", "/api/watch/"];

export function isBufferedPath(pathname: string): boolean {
  return EXACT_PATHS.has(pathname) || PREFIXES.some((p) => pathname.startsWith(p));
}

/** Vary tokens Next's App Router adds to every response. Vary: Origin and others are kept. */
const NEXT_VARY_TOKENS = new Set([
  "rsc",
  "next-router-state-tree",
  "next-router-prefetch",
  "next-router-segment-prefetch",
  "next-url",
]);

/** `Vary` with Next's tokens removed; null when nothing is left (drop the header). */
export function cleanVary(value: string | null): string | null {
  if (value === null) return null;
  const kept = value
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "" && !NEXT_VARY_TOKENS.has(t.toLowerCase()));
  return kept.length ? kept.join(", ") : null;
}

const NO_BODY_STATUS = new Set([204, 304]);

/**
 * Read the whole body and send it again with an explicit Content-Length. 204 and 304 carry no
 * body and no Content-Length. A 1xx/101 or a response with a WebSocket is returned as it is.
 * HEAD keeps the headers the route chose (its body is empty by definition, so a length computed
 * here would be wrong).
 */
export async function bufferResponse(res: Response, method: string): Promise<Response> {
  const headers = new Headers(res.headers);
  headers.delete("Transfer-Encoding");
  const vary = cleanVary(headers.get("Vary"));
  if (vary === null) headers.delete("Vary");
  else headers.set("Vary", vary);

  if (res.status < 200 || (res as { webSocket?: unknown }).webSocket) return res;
  if (NO_BODY_STATUS.has(res.status)) {
    headers.delete("Content-Length");
    return new Response(null, { status: res.status, statusText: res.statusText, headers });
  }
  if (method === "HEAD") {
    return new Response(null, { status: res.status, statusText: res.statusText, headers });
  }
  const buf = await res.arrayBuffer();
  headers.set("Content-Length", String(buf.byteLength)); // 0 for 202 and any empty body
  return new Response(buf, { status: res.status, statusText: res.statusText, headers });
}

export interface WorkerLike<Env, Ctx> {
  fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> | Response;
}

/** Wrap an OpenNext worker so the agent paths come back buffered. Other handlers (scheduled, queue) are kept. */
export function withBufferedAgentResponses<Env, Ctx, W extends WorkerLike<Env, Ctx>>(inner: W): W {
  return {
    ...inner,
    async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
      const res = await inner.fetch(request, env, ctx);
      let pathname: string;
      try {
        pathname = new URL(request.url).pathname;
      } catch {
        return res;
      }
      return isBufferedPath(pathname) ? bufferResponse(res, request.method) : res;
    },
  };
}
