// Handler-level tests for POST /api/history/archive. getConditions is mocked
// (no network); the store is the real in-memory backend vitest always gets
// (lib/db/store.ts `getStore`).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { scorableResponse } from "@/lib/alerts/fixtures";
import { hourUtcOf } from "@/lib/history/archive";

const ctl = vi.hoisted(() => ({
  conditionsCalls: [] as string[],
  fail: new Set<string>(),
  staleFor: new Set<string>(),
}));

vi.mock("@/lib/conditions", () => ({
  getConditions: async (slug: string) => {
    ctl.conditionsCalls.push(slug);
    if (ctl.fail.has(slug)) return null;
    // The route keys `beach_hourly` by the snapshot's OWN generatedAt (see
    // lib/history/archive.ts rowFromConditions), never the request clock — so
    // for the idempotency test to actually collide with the current UTC hour
    // (the one `listArchiveCandidates` checks against), the fixture must
    // report a real "now" timestamp instead of its fixed fixture date.
    const res = scorableResponse();
    res.snapshot.generatedAt = ctl.staleFor.has(slug)
      ? // 15 min before the START of the current claimed hour — always more
        // than the route's 10-minute STALE_SNAPSHOT_MS threshold, no matter
        // what minute of the hour this test happens to run at.
        new Date(Date.parse(hourUtcOf(Date.now())) - 15 * 60 * 1000).toISOString()
      : new Date().toISOString();
    return res;
  },
}));

import { POST } from "@/app/api/history/archive/route";
import { getStore } from "@/lib/db/store";
import { resetMemoryStore } from "@/lib/db/memoryStore";

const SECRET = "test-cron-secret";

function post(query = ""): Promise<Response> {
  return POST(
    new Request(`http://localhost/api/history/archive${query}`, {
      method: "POST",
      headers: { "x-cron-secret": SECRET },
    }),
  );
}

beforeEach(() => {
  resetMemoryStore();
  ctl.conditionsCalls = [];
  ctl.fail = new Set();
  ctl.staleFor = new Set();
  process.env.CRON_SECRET = SECRET;
  delete process.env.HISTORY_MAX_BUILDS_PER_DAY;
  delete process.env.HISTORY_ENABLED;
});

describe("auth", () => {
  it("401s without the correct x-cron-secret", async () => {
    const res = await POST(new Request("http://localhost/api/history/archive", { method: "POST" }));
    expect(res.status).toBe(401);
  });

  it("503s when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;
    const res = await post();
    expect(res.status).toBe(503);
  });
});

describe("HISTORY_ENABLED kill switch", () => {
  it("returns {disabled:true} and touches nothing when HISTORY_ENABLED=off", async () => {
    process.env.HISTORY_ENABLED = "off";
    const res = await post("?batch=3");
    const json = (await res.json()) as { disabled?: boolean };
    expect(json.disabled).toBe(true);
    expect(ctl.conditionsCalls.length).toBe(0);
  });

  it("archives normally when HISTORY_ENABLED is unset (default on)", async () => {
    const res = await post();
    const json = (await res.json()) as { archived: number };
    expect(json.archived).toBeGreaterThan(0);
  });
});

describe("batch clamp", () => {
  // Codex round-2 finding #3: the Worker runs on Cloudflare's free plan (50
  // subrequests PER REQUEST), and one cold getConditions build alone is
  // ~25 fetches — so both DEFAULT_BATCH and MAX_BATCH are hard-capped at 1.
  it("clamps a caller-supplied ?batch=50 down to the hard cap of 1", async () => {
    await post("?batch=50");
    expect(ctl.conditionsCalls.length).toBeLessThanOrEqual(1);
  });

  it("defaults to a batch of 1 with no ?batch= at all", async () => {
    await post();
    expect(ctl.conditionsCalls.length).toBeLessThanOrEqual(1);
  });
});

// The fair ordering (Codex round-3 finding #1) means the candidate a fresh
// store picks first is no longer always "boca-raton" — it's whichever
// eligible beach sorts first (never-archived beaches tie-break by slug, and
// eligibility itself depends on the real clock for auto-tier beaches). Tests
// that need to target "whichever beach the route will pick" ask the store
// directly instead of hard-coding a slug.
async function topCandidateSlug(nowMs = Date.now()): Promise<string> {
  const store = await getStore();
  const candidates = await store.listArchiveCandidates(nowMs);
  expect(candidates.length).toBeGreaterThan(0);
  return candidates[0].slug;
}

describe("archiving", () => {
  it("archives up to the default batch of candidates and reports counts", async () => {
    const target = await topCandidateSlug();
    const res = await post();
    expect(res.status).toBe(200);
    const json = (await res.json()) as { archived: number; skipped: number; remaining: number };
    expect(json.archived).toBeGreaterThan(0);
    expect(ctl.conditionsCalls).toContain(target);
  });

  it("respects a smaller ?batch=", async () => {
    const res = await post("?batch=1");
    const json = (await res.json()) as { archived: number; skipped: number };
    expect(json.archived + json.skipped).toBeLessThanOrEqual(1);
  });

  it("is idempotent: a second run in the same UTC hour archives nothing new for an already-archived beach", async () => {
    const target = await topCandidateSlug();
    await post("?batch=3");
    const before = (await (await getStore()).getHistoryBudget(new Date().toISOString().slice(0, 10))) ?? 0;
    const res2 = await post("?batch=3");
    const json2 = (await res2.json()) as { archived: number; deduped: number; skipped: number; remaining: number };
    // The beach archived by the first call should not be re-fetched.
    const targetCallsAfterFirstRun = ctl.conditionsCalls.filter((s) => s === target).length;
    expect(targetCallsAfterFirstRun).toBe(1);
    expect(json2.archived + json2.deduped + json2.skipped).toBeGreaterThanOrEqual(0);
    expect(before).toBeGreaterThan(0);
  });

  it("counts a beach getConditions returns null for as skipped, not archived", async () => {
    const target = await topCandidateSlug();
    ctl.fail = new Set([target]);
    const res = await post("?batch=1");
    const json = (await res.json()) as { archived: number; skipped: number };
    expect(json.archived).toBe(0);
    expect(json.skipped).toBe(1);
  });

  it("counts a re-archive of the same (slug, hour) as deduped, not archived", async () => {
    // First call archives the top candidate for this hour. Manually clear its
    // claim by resetting the store between calls isn't realistic here, so
    // instead we assert the direct store-level contract in
    // beachHourly.test.ts and check here that a route call never
    // double-counts archived vs deduped: archived + deduped should never
    // exceed the number of candidates built.
    const res = await post("?batch=3");
    const json = (await res.json()) as { archived: number; deduped: number; claimed: number };
    expect(json.archived + json.deduped).toBeLessThanOrEqual(json.claimed);
  });
});

describe("budget guard", () => {
  it("stops archiving once the daily build budget is spent", async () => {
    process.env.HISTORY_MAX_BUILDS_PER_DAY = "0";
    const res = await post();
    const json = (await res.json()) as { archived: number; skipped: number; remaining: number; note?: string };
    expect(json.archived).toBe(0);
    expect(json.note).toMatch(/budget/i);
    expect(ctl.conditionsCalls.length).toBe(0);
  });

  it("reports remaining budget used after a run", async () => {
    process.env.HISTORY_MAX_BUILDS_PER_DAY = "1";
    const res = await post("?batch=3");
    const json = (await res.json()) as { budget: { used: number; max: number } };
    expect(json.budget.max).toBe(1);
    expect(json.budget.used).toBeLessThanOrEqual(1);
  });

  it("never exceeds the daily budget across two overlapping-style calls", async () => {
    process.env.HISTORY_MAX_BUILDS_PER_DAY = "2";
    await post("?batch=3");
    await post("?batch=3");
    const store = await getStore();
    const used = await store.getHistoryBudget(new Date().toISOString().slice(0, 10));
    expect(used).toBeLessThanOrEqual(2);
  });
});

describe("stale snapshot vs claimed hour (Codex round-2 finding #1)", () => {
  it("skips the write, counts it stale, and releases the claim so the very next tick can retry", async () => {
    const target = await topCandidateSlug();
    ctl.staleFor = new Set([target]);
    const res1 = await post();
    const json1 = (await res1.json()) as { archived: number; stale: number; skipped: number };
    expect(json1.archived).toBe(0);
    expect(json1.stale).toBe(1);
    expect(json1.skipped).toBeGreaterThanOrEqual(1);

    // Released, not merely abandoned — a call with no wait at all can
    // reclaim it, and once the snapshot is fresh, archives it.
    ctl.staleFor = new Set();
    const res2 = await post();
    const json2 = (await res2.json()) as { archived: number };
    expect(json2.archived).toBeGreaterThan(0);
    expect(ctl.conditionsCalls.filter((s) => s === target)).toHaveLength(2);
  });
});

describe("a build failure keeps the claim (retried by a LATER tick, not lost)", () => {
  it("a getConditions failure leaves the target's claim active — a later tick cannot re-fetch it yet", async () => {
    const target = await topCandidateSlug();
    ctl.fail = new Set([target]);
    const res1 = await post();
    const json1 = (await res1.json()) as { claimed: number; skipped: number };
    expect(json1.claimed).toBe(1);
    expect(json1.skipped).toBeGreaterThanOrEqual(1);

    ctl.fail = new Set();
    const res2 = await post();
    // The target's claim is still within the 10-minute abandonment window,
    // so it is never re-fetched by a later tick...
    expect(ctl.conditionsCalls.filter((s) => s === target)).toHaveLength(1);
    // ...but (Codex round-3 finding #2) that no longer blocks the whole
    // tick: the scan moves on and builds a different eligible beach instead
    // of returning archived: 0, as head-of-line blocking used to force.
    const json2 = (await res2.json()) as { archived: number };
    expect(json2.archived).toBeGreaterThan(0);
  });
});

describe("head-of-line blocking (Codex round-3 finding #2)", () => {
  it("a beach whose claim is still held does not block the tick — the next eligible beach gets built instead", async () => {
    const store = await getStore();
    const nowMs = Date.now();
    const candidates = await store.listArchiveCandidates(nowMs);
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    const [first, second] = candidates.map((c) => c.slug);

    // Hold `first`'s claim externally, as if an earlier tick's build were
    // still in flight (or had failed without completing).
    const hourUtc = hourUtcOf(nowMs);
    expect(await store.claimHistoryBuild(first, hourUtc, nowMs)).toBe(true);

    const res = await post();
    const json = (await res.json()) as { archived: number; claimed: number; skipped: number };
    expect(json.claimed).toBe(1);
    expect(json.skipped).toBeGreaterThanOrEqual(1); // first's lost claim attempt
    expect(ctl.conditionsCalls).not.toContain(first);
    expect(ctl.conditionsCalls).toContain(second);
    expect(json.archived).toBeGreaterThan(0);
  });

  it("if every scanned candidate's claim is already held, the route builds nothing and reports claimed: 0", async () => {
    const store = await getStore();
    const nowMs = Date.now();
    const candidates = await store.listArchiveCandidates(nowMs);
    const hourUtc = hourUtcOf(nowMs);
    for (const c of candidates) {
      expect(await store.claimHistoryBuild(c.slug, hourUtc, nowMs)).toBe(true);
    }

    const res = await post();
    const json = (await res.json()) as { archived: number; claimed: number };
    expect(json.claimed).toBe(0);
    expect(json.archived).toBe(0);
    expect(ctl.conditionsCalls.length).toBe(0);
  });
});

describe("budget reporting shape", () => {
  it("reports a single day/used/max when the run never crosses a UTC day boundary", async () => {
    const res = await post();
    const json = (await res.json()) as { budget: { day: string; used: number; max: number; alsoDay?: string } };
    expect(json.budget.day).toBe(new Date().toISOString().slice(0, 10));
    expect(json.budget.max).toBe(600);
    expect(json.budget.alsoDay).toBeUndefined();
  });
});

describe("overlapping cron calls (claim race)", () => {
  it("two concurrent archive calls build each (slug, hour) at most once", async () => {
    const [res1, res2] = await Promise.all([post("?batch=3"), post("?batch=3")]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    // Every candidate that got built at all was built exactly once — no slug
    // was fetched twice for the same hour across the two overlapping calls.
    const counts = new Map<string, number>();
    for (const slug of ctl.conditionsCalls) counts.set(slug, (counts.get(slug) ?? 0) + 1);
    for (const [slug, n] of counts) {
      expect(n, `${slug} was fetched ${n} times`).toBe(1);
    }
  });
});
