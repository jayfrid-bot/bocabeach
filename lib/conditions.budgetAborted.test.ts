// Codex round-5 #1: a conditions build that runs out of ambient subrequest
// budget partway through must never poison the shared 120-s cache with the
// resulting (deliberately incomplete) snapshot, and must mark the response
// `budgetAborted` so push-run consumers treat it as "no data this run"
// rather than a real reading. This exercises the REAL lib/conditions.ts
// pipeline (every lib/sources/*.ts adapter, unmocked) — only `next/cache`'s
// `unstable_cache` is faked, with the same write-on-success /
// never-write-on-throw contract the real one has, so the test can inspect
// whether a cache entry was written without needing Next's server runtime.
import { describe, it, expect, vi, afterEach } from "vitest";

const { cacheStore } = vi.hoisted(() => ({ cacheStore: new Map<string, unknown>() }));

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...a: unknown[]) => Promise<unknown>, keyParts: string[]) => {
    const key = keyParts.join(":");
    return async (...args: unknown[]) => {
      if (cacheStore.has(key)) return cacheStore.get(key);
      const result = await fn(...args); // a throw here never reaches set() — matches Next's real behavior
      cacheStore.set(key, result);
      return result;
    };
  },
}));

import { SubrequestBudget, runWithBudget } from "@/lib/alerts/budget";
import { getConditions } from "@/lib/conditions";

const SLUG = "boca-raton";

describe("getConditions + subrequest budget exhaustion (Codex round-5 #1)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    cacheStore.clear();
    vi.restoreAllMocks();
  });

  it("an exhausted build is marked budgetAborted and never written to the shared cache", async () => {
    // No real network call should even happen — the budget is already at 0,
    // so every fetchWithTimeout call is gated before fetch() is ever called.
    globalThis.fetch = vi.fn(async () => {
      throw new Error("fetch should never be called — budget is exhausted");
    }) as unknown as typeof fetch;

    const budget = new SubrequestBudget(0);
    const result = await runWithBudget(budget, () => getConditions(SLUG));

    expect(result).not.toBeNull();
    expect(result!.budgetAborted).toBe(true);
    expect(budget.exhaustedDuringBuild).toBe(true);
    expect(cacheStore.has(`conditions:${SLUG}`)).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("a healthy build is not marked budgetAborted and IS written to the shared cache", async () => {
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

    const budget = new SubrequestBudget(100);
    const result = await runWithBudget(budget, () => getConditions(SLUG));

    expect(result).not.toBeNull();
    expect(result!.budgetAborted).toBeUndefined();
    expect(budget.exhaustedDuringBuild).toBe(false);
    expect(cacheStore.has(`conditions:${SLUG}`)).toBe(true);
  });
});
