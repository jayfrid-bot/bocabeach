// Per-IP rate limit for /api/v1/* and /mcp.
//
// Two layers, no new paid service and no Durable Object:
//  1. The Cloudflare Workers Rate Limiting binding AGENT_RATE_LIMITER (wrangler.jsonc
//     "ratelimits"), when it is bound. It counts per key across the whole edge
//     location, so it is the real limit.
//  2. An in-isolate token bucket, used when the binding is missing (local dev, tests,
//     a deploy that did not add it) or throws. Each isolate has its own buckets, so a
//     determined caller can get several times the limit; it still stops a tight loop.
// The edge cache on the GET answers (Cache-Control s-maxage) absorbs repeat reads.
//
// Never uses KV: a KV write per request would burn the free daily write quota.

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { clientIp } from "@/lib/plus/rateLimit";

/** Sustained requests per second per IP in the fallback bucket (= 60 per minute). */
export const BUCKET_REFILL_PER_SEC = 1;
/** Burst a quiet client may spend at once. */
export const BUCKET_CAPACITY = 40;
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
export function takeToken(key: string, nowMs: number): AgentLimitResult {
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
    b = { tokens: BUCKET_CAPACITY, at: nowMs };
  } else {
    const elapsedSec = Math.max(0, (nowMs - b.at) / 1000);
    b.tokens = Math.min(BUCKET_CAPACITY, b.tokens + elapsedSec * BUCKET_REFILL_PER_SEC);
    b.at = nowMs;
    buckets.delete(key); // re-insert so recently used keys sit at the end
  }
  buckets.set(key, b);
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { limited: false, retryAfterSec: 0 };
  }
  return { limited: true, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / BUCKET_REFILL_PER_SEC)) };
}

async function getBinding(): Promise<RateLimitBinding | null> {
  try {
    const ctx = await getCloudflareContext({ async: true });
    const b = (ctx?.env as Record<string, unknown> | undefined)?.AGENT_RATE_LIMITER as RateLimitBinding | undefined;
    return b && typeof b.limit === "function" ? b : null;
  } catch {
    return null;
  }
}

export async function checkAgentRateLimit(req: Request, nowMs: number = Date.now()): Promise<AgentLimitResult> {
  const ip = clientIp(req) ?? "unknown";
  const binding = await getBinding();
  if (binding) {
    try {
      const { success } = await binding.limit({ key: ip });
      return success ? { limited: false, retryAfterSec: 0 } : { limited: true, retryAfterSec: BINDING_PERIOD_SEC };
    } catch {
      // Fall through to the bucket: a broken limiter must not turn into no limit at all.
    }
  }
  return takeToken(ip, nowMs);
}
