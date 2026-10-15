// Shared HTTP plumbing for the public v1 API: CORS for read-only GET, one error
// shape, rate limiting, a request counter line, and no cookies ever.

import { checkAgentRateLimit } from "@/lib/agent/rateLimit";
import { logAgentRequest } from "@/lib/agent/log";

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Access-Control-Expose-Headers": "Retry-After, Cache-Control",
  "Access-Control-Max-Age": "86400",
};

export type ErrorCode =
  | "bad_request"
  | "not_found"
  | "rate_limited"
  | "unavailable"
  | "method_not_allowed"
  | "internal_error";

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string };
}

export function apiError(
  status: number,
  code: ErrorCode,
  message: string,
  extra: { cacheControl?: string; retryAfterSec?: number } = {},
): Response {
  const headers: Record<string, string> = { "Cache-Control": extra.cacheControl ?? "no-store" };
  if (extra.retryAfterSec != null) headers["Retry-After"] = String(extra.retryAfterSec);
  return Response.json({ error: { code, message } } satisfies ApiErrorBody, { status, headers });
}

export function jsonOk(body: unknown, cacheControl: string): Response {
  return Response.json(body, { headers: { "Cache-Control": cacheControl } });
}

export function withCors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

export function preflight(): Response {
  return withCors(new Response(null, { status: 204 }));
}

/** POST, PUT, PATCH, DELETE on a read-only route: the JSON error shape, with CORS and Allow. */
export function methodNotAllowed(req: Request, route: string): Response {
  const res = apiError(405, "method_not_allowed", "This API is read-only. Use GET.");
  res.headers.set("Allow", "GET, OPTIONS");
  withCors(res);
  logAgentRequest(req, { route, status: 405 });
  return res;
}

/**
 * Run a GET handler behind the rate limit, with CORS on every outcome, an error
 * shape for surprises, and one counter log line.
 */
export async function guardedGet(req: Request, route: string, handler: () => Promise<Response> | Response): Promise<Response> {
  let res: Response;
  let limited = false;
  const limit = await checkAgentRateLimit(req, "rest");
  if (limit.limited) {
    limited = true;
    res = apiError(429, "rate_limited", "Too many requests. Slow down and retry after the Retry-After seconds.", {
      retryAfterSec: limit.retryAfterSec,
    });
  } else {
    try {
      res = await handler();
    } catch (e) {
      console.error("agent_api handler error", route, e instanceof Error ? e.message : "unknown");
      res = apiError(500, "internal_error", "Something went wrong on our side. Try again shortly.");
    }
  }
  withCors(res);
  logAgentRequest(req, { route, status: res.status, limited: limited || undefined });
  return res;
}
