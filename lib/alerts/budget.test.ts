// Codex round-3 #4: real subrequest counting via AsyncLocalStorage. The
// core claim under test — `runWithBudget` makes every `fetchWithTimeout`
// call anywhere in its (possibly deeply nested, multi-await) call graph
// spend from the SAME budget instance, with no manual charge at any call
// site — plus the plain SubrequestBudget/timeRoundRobinSlice primitives.

import { describe, it, expect, vi, afterEach } from "vitest";
import { SubrequestBudget, runWithBudget, timeRoundRobinSlice, STAGE_RESERVE } from "@/lib/alerts/budget";
import { fetchWithTimeout, fetchJsonWithRetry, SubrequestBudgetExhausted } from "@/lib/util";

describe("SubrequestBudget", () => {
  it("take() spends only when affordable, never goes negative", () => {
    const b = new SubrequestBudget(2);
    expect(b.take(1)).toBe(true);
    expect(b.left).toBe(1);
    expect(b.take(5)).toBe(false); // not affordable — spends nothing
    expect(b.left).toBe(1);
    expect(b.take(1)).toBe(true);
    expect(b.left).toBe(0);
    b.spend(10); // spend() itself can overspend; clamps at 0, never negative
    expect(b.left).toBe(0);
  });

  it("a negative/zero constructor total clamps to 0", () => {
    expect(new SubrequestBudget(-5).left).toBe(0);
    expect(new SubrequestBudget(0).left).toBe(0);
  });
});

describe("runWithBudget + fetchWithTimeout (Codex round-3 #4)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function stubFetch() {
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
  }

  it("a real fetchWithTimeout call inside runWithBudget spends exactly 1, automatically", async () => {
    stubFetch();
    const budget = new SubrequestBudget(10);
    await runWithBudget(budget, async () => {
      await fetchWithTimeout("https://example.test/a");
    });
    expect(budget.left).toBe(9);
  });

  it("counts every real fetch made anywhere in the async call graph, however deeply nested", async () => {
    stubFetch();
    const budget = new SubrequestBudget(10);
    async function innerA() {
      await fetchWithTimeout("https://example.test/a");
    }
    async function innerB() {
      await new Promise((r) => setTimeout(r, 0)); // a real await boundary in between
      await fetchWithTimeout("https://example.test/b");
    }
    async function middle() {
      await innerA();
      await innerB();
    }
    await runWithBudget(budget, async () => {
      await Promise.all([middle(), fetchWithTimeout("https://example.test/c")]);
    });
    expect(budget.left).toBe(7); // 3 real fetches
  });

  it("a fetchWithTimeout call OUTSIDE runWithBudget never throws and spends nothing (no ambient budget)", async () => {
    stubFetch();
    await expect(fetchWithTimeout("https://example.test/outside")).resolves.toBeInstanceOf(Response);
  });

  it("two concurrent runWithBudget calls each spend from their OWN budget, never cross-contaminating", async () => {
    stubFetch();
    const budgetA = new SubrequestBudget(5);
    const budgetB = new SubrequestBudget(5);
    await Promise.all([
      runWithBudget(budgetA, async () => {
        await fetchWithTimeout("https://example.test/a1");
        await fetchWithTimeout("https://example.test/a2");
      }),
      runWithBudget(budgetB, async () => {
        await fetchWithTimeout("https://example.test/b1");
      }),
    ]);
    expect(budgetA.left).toBe(3);
    expect(budgetB.left).toBe(4);
  });

  it("round-4 #3: the hook GATES, not just counts — an exhausted budget throws before fetch() is called", async () => {
    const realFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = realFetch as unknown as typeof fetch;
    const budget = new SubrequestBudget(1);
    await runWithBudget(budget, async () => {
      await fetchWithTimeout("https://example.test/first"); // spends the last unit
      await expect(fetchWithTimeout("https://example.test/second")).rejects.toBeInstanceOf(
        SubrequestBudgetExhausted,
      );
    });
    expect(realFetch).toHaveBeenCalledTimes(1); // the refused call never reached fetch()
    expect(budget.left).toBe(0);
  });

  it("fetchJsonWithRetry does not retry a SubrequestBudgetExhausted rejection", async () => {
    const realFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = realFetch as unknown as typeof fetch;
    const budget = new SubrequestBudget(0);
    await runWithBudget(budget, async () => {
      await expect(fetchJsonWithRetry("https://example.test/x")).rejects.toBeInstanceOf(SubrequestBudgetExhausted);
    });
    expect(realFetch).not.toHaveBeenCalled(); // no fetch, and no 800ms retry attempt either
  });

  it("round-4 #3: a cold build of 21 sources against budget 3 makes exactly 3 real fetches and never throws", async () => {
    stubFetch();
    const budget = new SubrequestBudget(3);
    // Mirrors how every lib/sources/*.ts adapter and lib/conditions.ts's
    // Promise.all already treat a fetch failure: caught per-source, never
    // left to reject the aggregate — the same shape getConditions relies on
    // for "partial/limited result, never throws" under a starved budget.
    const results = await runWithBudget(budget, () =>
      Promise.all(
        Array.from({ length: 21 }, (_, i) =>
          fetchWithTimeout(`https://example.test/source-${i}`).catch(() => null),
        ),
      ),
    );
    expect(results).toHaveLength(21);
    expect(results.filter((r) => r !== null)).toHaveLength(3); // exactly the 3 that got budget
    expect(results.filter((r) => r === null)).toHaveLength(18); // the rest degraded, not thrown
    expect(budget.left).toBe(0);
  });
});

describe("timeRoundRobinSlice", () => {
  it("returns everything when max >= item count", () => {
    expect(timeRoundRobinSlice(["a", "b"], (s) => s, 5, 0, 1000)).toEqual(["a", "b"]);
  });

  it("advances the window as the clock tick advances", () => {
    const items = ["a", "b", "c", "d"];
    const tick0 = timeRoundRobinSlice(items, (s) => s, 2, 0, 1000);
    const tick1 = timeRoundRobinSlice(items, (s) => s, 2, 1000, 1000);
    expect(tick0).not.toEqual(tick1);
  });

  it("is deterministic for the same clock tick", () => {
    const items = ["a", "b", "c", "d", "e"];
    const first = timeRoundRobinSlice(items, (s) => s, 2, 12345, 1000);
    const second = timeRoundRobinSlice(items, (s) => s, 2, 12345, 1000);
    expect(first).toEqual(second);
  });
});

describe("SubrequestBudget.exhaustedDuringBuild (Codex round-5 #1)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("flips true the moment the gate refuses a real fetch", async () => {
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const budget = new SubrequestBudget(1);
    await runWithBudget(budget, async () => {
      expect(budget.exhaustedDuringBuild).toBe(false);
      await fetchWithTimeout("https://example.test/a"); // spends the last unit
      expect(budget.exhaustedDuringBuild).toBe(false); // not exhausted yet — just spent to 0
      await fetchJsonWithRetry("https://example.test/b").catch(() => null); // refused now
      expect(budget.exhaustedDuringBuild).toBe(true);
    });
  });

  it("stays false for a build that never hits a refusal", async () => {
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const budget = new SubrequestBudget(10);
    await runWithBudget(budget, async () => {
      await fetchWithTimeout("https://example.test/a");
    });
    expect(budget.exhaustedDuringBuild).toBe(false);
  });
});

describe("STAGE_RESERVE", () => {
  it("every named stage has a positive reserve", () => {
    for (const v of Object.values(STAGE_RESERVE)) {
      expect(v).toBeGreaterThan(0);
    }
  });
});
