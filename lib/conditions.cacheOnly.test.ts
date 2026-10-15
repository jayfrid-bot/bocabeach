// getCachedConditions reads the shared 120-s cache and NEVER builds: no source fetches on a miss,
// and the entry a normal getConditions call wrote is the one it reads. Like
// conditions.budgetAborted.test.ts, only next/cache's unstable_cache is faked, with the real
// contract: write on success, nothing written when the callback throws.
import { afterEach, describe, expect, it, vi } from "vitest";

const { cacheStore } = vi.hoisted(() => ({ cacheStore: new Map<string, unknown>() }));

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...a: unknown[]) => Promise<unknown>, keyParts: string[]) => {
    const key = keyParts.join(":");
    return async (...args: unknown[]) => {
      if (cacheStore.has(key)) return cacheStore.get(key);
      const result = await fn(...args);
      cacheStore.set(key, result);
      return result;
    };
  },
}));

import { getCachedConditions, getConditions } from "@/lib/conditions";

describe("getCachedConditions", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    cacheStore.clear();
    vi.restoreAllMocks();
  });

  it("returns null on a miss, starts no build and writes nothing", async () => {
    globalThis.fetch = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;
    expect(await getCachedConditions("boca-raton")).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(cacheStore.size).toBe(0);
  });

  it("returns null for an unknown beach", async () => {
    expect(await getCachedConditions("atlantis")).toBeNull();
  });

  it("reads back the entry a normal call wrote, with no new fetches", async () => {
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const built = await getConditions("boca-raton");
    expect(built).not.toBeNull();
    const calls = vi.mocked(globalThis.fetch).mock.calls.length;
    const hit = await getCachedConditions("boca-raton");
    expect(hit).toBe(built);
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(calls);
  });
});
