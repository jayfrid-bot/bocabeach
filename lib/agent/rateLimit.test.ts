import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ctx = vi.hoisted(() => ({ env: {} as Record<string, unknown>, fail: false }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: async () => {
    if (ctx.fail) throw new Error("no context");
    return { env: ctx.env };
  },
}));

import {
  BUCKET_CAPACITY,
  BUCKET_REFILL_PER_SEC,
  checkAgentRateLimit,
  resetAgentRateLimit,
  takeToken,
} from "@/lib/agent/rateLimit";

const reqFrom = (ip: string) => new Request("https://isitbeachday.com/mcp", { headers: { "cf-connecting-ip": ip } });

beforeEach(() => {
  resetAgentRateLimit();
  ctx.env = {};
  ctx.fail = false;
});
afterEach(() => vi.restoreAllMocks());

describe("token bucket (no binding)", () => {
  it("allows a burst, then limits, then refills at the sustained rate", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < BUCKET_CAPACITY; i++) expect(takeToken("a", t0).limited).toBe(false);
    const over = takeToken("a", t0);
    expect(over.limited).toBe(true);
    expect(over.retryAfterSec).toBeGreaterThanOrEqual(1);
    // After 3 seconds, 3 tokens are back.
    for (let i = 0; i < 3 * BUCKET_REFILL_PER_SEC; i++) expect(takeToken("a", t0 + 3000).limited).toBe(false);
    expect(takeToken("a", t0 + 3000).limited).toBe(true);
  });

  it("never refills past the capacity", () => {
    takeToken("b", 0);
    for (let i = 0; i < BUCKET_CAPACITY; i++) expect(takeToken("b", 10_000_000).limited).toBe(false);
    expect(takeToken("b", 10_000_000).limited).toBe(true);
  });

  it("keeps each address separate", async () => {
    for (let i = 0; i < BUCKET_CAPACITY + 1; i++) await checkAgentRateLimit(reqFrom("1.1.1.1"), 5);
    expect((await checkAgentRateLimit(reqFrom("1.1.1.1"), 5)).limited).toBe(true);
    expect((await checkAgentRateLimit(reqFrom("2.2.2.2"), 5)).limited).toBe(false);
  });

  it("uses one shared bucket when there is no address header (local dev)", async () => {
    const bare = () => new Request("https://isitbeachday.com/mcp");
    for (let i = 0; i < BUCKET_CAPACITY; i++) await checkAgentRateLimit(bare(), 9);
    expect((await checkAgentRateLimit(bare(), 9)).limited).toBe(true);
  });

  it("stays bounded when many addresses arrive", () => {
    for (let i = 0; i < 6_000; i++) takeToken(`ip-${i}`, 1);
    // The newest address is still tracked and the oldest was dropped (fresh full bucket again).
    expect(takeToken("ip-5999", 1).limited).toBe(false);
    for (let i = 0; i < BUCKET_CAPACITY; i++) takeToken("ip-0", 1);
    expect(takeToken("ip-0", 1).limited).toBe(true);
  });
});

describe("Workers Rate Limiting binding", () => {
  it("is used when bound, keyed by IP, and its verdict wins", async () => {
    const limit = vi.fn(async ({ key }: { key: string }) => ({ success: key !== "9.9.9.9" }));
    ctx.env = { AGENT_RATE_LIMITER: { limit } };
    expect((await checkAgentRateLimit(reqFrom("8.8.8.8"))).limited).toBe(false);
    const denied = await checkAgentRateLimit(reqFrom("9.9.9.9"));
    expect(denied).toEqual({ limited: true, retryAfterSec: 60 });
    expect(limit).toHaveBeenCalledWith({ key: "8.8.8.8" });
    // The in-isolate bucket is not touched while the binding answers.
    for (let i = 0; i < BUCKET_CAPACITY + 5; i++) await checkAgentRateLimit(reqFrom("8.8.8.8"));
    expect((await checkAgentRateLimit(reqFrom("8.8.8.8"))).limited).toBe(false);
  });

  it("falls back to the bucket when the binding throws", async () => {
    ctx.env = { AGENT_RATE_LIMITER: { limit: async () => { throw new Error("down"); } } };
    for (let i = 0; i < BUCKET_CAPACITY; i++) expect((await checkAgentRateLimit(reqFrom("7.7.7.7"), 1)).limited).toBe(false);
    expect((await checkAgentRateLimit(reqFrom("7.7.7.7"), 1)).limited).toBe(true);
  });

  it("falls back when the Cloudflare context is unavailable", async () => {
    ctx.fail = true;
    expect((await checkAgentRateLimit(reqFrom("6.6.6.6"), 1)).limited).toBe(false);
  });
});
