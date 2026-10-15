// Per-IP rate limits for /api/v1/* (scope "rest") and /mcp (scope "mcp"), as two
// separate budgets: REST 60 per minute per IP, MCP 300 per minute per IP. MCP gets
// more because hosted connectors (Claude, ChatGPT) share egress addresses, and one
// connector setup spends several calls (initialize, initialized, tools/list).
//
// Two layers, no new paid service and no Durable Object:
//  1. A Cloudflare Workers Rate Limiting binding per scope (wrangler.jsonc "ratelimits":
//     AGENT_RATE_LIMITER and AGENT_MCP_RATE_LIMITER), when bound. Cloudflare counters
//     are per location and eventually consistent, so this is a brake, not a hard
//     ceiling on cost. The real protection for the data sources is the shared 120-s
//     conditions cache plus the "one cold build per request" rule (beachView.loadMany).
//  2. An in-isolate token bucket, used when the binding is missing (local dev, tests,
//     a deploy that did not add it) or throws. Each isolate has its own buckets.
//
// Never uses KV: a KV write per request would burn the free daily write quota.

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { clientIp } from "@/lib/plus/rateLimit";

export type LimitScope = "rest" | "mcp";

const SCOPES: Record<LimitScope, { binding: string; capacity: number; refillPerSec: number; perMinute: number }> = {
  rest: { binding: "AGENT_RATE_LIMITER", capacity: 40, refillPerSec: 1, perMinute: 60 },
  mcp: { binding: "AGENT_MCP_RATE_LIMITER", capacity: 120, refillPerSec: 5, perMinute: 300 },
};

/** Fallback bucket numbers for REST (kept for tests and docs). */
export const BUCKET_CAPACITY = SCOPES.rest.capacity;
export const BUCKET_REFILL_PER_SEC = SCOPES.rest.refillPerSec;
export const SCOPE_LIMITS = SCOPES;
const MAX_TRACKED_IPS = 5_000;
/** The binding's own period; used for Retry-After when it says no. */
const BINDING_PERIOD_SEC = 60;

export interface AgentLimitResult {
  limited: boolean;
  retryAfterSec: number;
}

interface RateLimitBinding {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

const buckets = new Map<string, { tokens: number; at: number }>();

export function resetAgentRateLimit(): void {
  buckets.clear();
}

/** Take one token from `key`'s bucket. Pure apart from the module-level map. */
export function takeToken(key: string, nowMs: number, scope: LimitScope = "rest"): AgentLimitResult {
  const { capacity, refillPerSec } = SCOPES[scope];
  key = `${scope}:${key}`;
  let b = buckets.get(key);
  if (!b) {
    if (buckets.size >= MAX_TRACKED_IPS) {
      // Drop the oldest quarter. Map keeps insertion order, so the first keys are oldest.
      let drop = Math.floor(MAX_TRACKED_IPS / 4);
      for (const k of buckets.keys()) {
        if (drop-- <= 0) break;
        buckets.delete(k);
      }
    }
    b = { tokens: capacity, at: nowMs };
  } else {
    const elapsedSec = Math.max(0, (nowMs - b.at) / 1000);
    b.tokens = Math.min(capacity, b.tokens + elapsedSec * refillPerSec);
    b.at = nowMs;
    buckets.delete(key); // re-insert so recently used keys sit at the end
  }
  buckets.set(key, b);
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { limited: false, retryAfterSec: 0 };
  }
  return { limited: true, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / refillPerSec)) };
}

async function getBinding(scope: LimitScope): Promise<RateLimitBinding | null> {
  try {
    const ctx = await getCloudflareContext({ async: true });
    const b = (ctx?.env as Record<string, unknown> | undefined)?.[SCOPES[scope].binding] as RateLimitBinding | undefined;
    return b && typeof b.limit === "function" ? b : null;
  } catch {
    return null;
  }
}

export async function checkAgentRateLimit(
  req: Request,
  scope: LimitScope = "rest",
  nowMs: number = Date.now(),
): Promise<AgentLimitResult> {
  const ip = clientIp(req) ?? "unknown";
  const binding = await getBinding(scope);
  if (binding) {
    try {
      const { success } = await binding.limit({ key: ip });
      return success ? { limited: false, retryAfterSec: 0 } : { limited: true, retryAfterSec: BINDING_PERIOD_SEC };
    } catch {
      // Fall through to the bucket: a broken limiter must not turn into no limit at all.
    }
  }
  return takeToken(ip, nowMs, scope);
}
