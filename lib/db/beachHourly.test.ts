// Store-level coverage for the hourly history archive (migrations/0006_history.sql):
// conditional upsert (no stale-write regression), the daylight candidate
// filter, and the per-day build-budget counter. Runs against the in-memory
// store (vitest always gets memoryStore — see lib/db/store.ts `getStore`).

import { describe, it, expect, beforeEach } from "vitest";
import { getStore } from "@/lib/db/store";
import { resetMemoryStore } from "@/lib/db/memoryStore";
import { hourUtcOf } from "@/lib/history/archive";
import type { BeachHourlyRow } from "@/lib/history/types";

function row(over: Partial<BeachHourlyRow> = {}): BeachHourlyRow {
  return {
    slug: "boca-raton",
    hour_utc: hourUtcOf(Date.parse("2026-09-20T14:00:00Z")),
    snapshot_generated_at: "2026-09-20T14:05:00.000Z",
    archived_at: "2026-09-20T14:05:01.000Z",
    local_date: "2026-09-20",
    local_hour: 10,
    utc_offset_minutes: -240,
    timezone: "America/New_York",
    score: 80,
    raw_score: 80,
    rating: "Good",
    available_weight: 1,
    observed_weight: 0.2,
    coverage_tier: "full",
    air_temp_f: 85,
    water_temp_f: 84,
    sand_temp_f: 95,
    wave_ft: 2,
    wave_source: "model",
    wind_mph: 8,
    gust_mph: 12,
    uv: 6,
    cloud_pct: 10,
    rain_now: 0,
    lightning_near: 0,
    tide_state: "rising",
    crowd_pct: null,
    seaweed_pct: 5,
    seaweed_level: "low",
    clarity_pct: null,
    engine_version: "test-1",
    scoring_config_version: "test-1",
    build_sha: "abc123",
    row_kind: "snapshot",
    archive_reason: "cron",
    caps_json: "[]",
    factors_json: "[]",
    missing_json: "[]",
    extra_json: null,
    ...over,
  };
}

beforeEach(() => {
  resetMemoryStore();
});

describe("upsertBeachHourly — conditional on snapshot_generated_at", () => {
  it("writes a fresh (slug, hour_utc) row", async () => {
    const store = await getStore();
    const r = await store.upsertBeachHourly(row());
    expect(r.written).toBe(true);
  });

  it("replaces an existing row when the new snapshot is newer", async () => {
    const store = await getStore();
    await store.upsertBeachHourly(row({ snapshot_generated_at: "2026-09-20T14:05:00.000Z", score: 80 }));
    const r = await store.upsertBeachHourly(row({ snapshot_generated_at: "2026-09-20T14:50:00.000Z", score: 60 }));
    expect(r.written).toBe(true);
  });

  it("refuses to regress a fresher row with a stale (older or equal) snapshot", async () => {
    const store = await getStore();
    await store.upsertBeachHourly(row({ snapshot_generated_at: "2026-09-20T14:50:00.000Z", score: 60 }));
    const stale = await store.upsertBeachHourly(row({ snapshot_generated_at: "2026-09-20T14:05:00.000Z", score: 80 }));
    expect(stale.written).toBe(false);
    const same = await store.upsertBeachHourly(row({ snapshot_generated_at: "2026-09-20T14:50:00.000Z", score: 99 }));
    expect(same.written).toBe(false);
  });

  it("is idempotent: writing the exact same row twice never regresses", async () => {
    const store = await getStore();
    const first = await store.upsertBeachHourly(row());
    const second = await store.upsertBeachHourly(row());
    expect(first.written).toBe(true);
    expect(second.written).toBe(false);
  });
});

describe("listArchiveCandidates — daylight rule", () => {
  it("excludes a beach that already has a row for the current UTC hour", async () => {
    const store = await getStore();
    const nowMs = Date.parse("2026-09-20T17:00:00Z"); // ~1 PM ET — daylight
    await store.upsertBeachHourly(row({ hour_utc: hourUtcOf(nowMs) }));
    const candidates = await store.listArchiveCandidates(nowMs);
    expect(candidates.find((c) => c.slug === "boca-raton")).toBeUndefined();
  });

  it("includes a served beach with no row yet, during daylight", async () => {
    const store = await getStore();
    const nowMs = Date.parse("2026-09-20T17:00:00Z"); // ~1 PM ET
    const candidates = await store.listArchiveCandidates(nowMs);
    expect(candidates.some((c) => c.slug === "boca-raton")).toBe(true);
  });
});

// Codex round-3 finding #1: candidates used to come back in fixed config
// order, reset every UTC hour — with fewer builds/hour possible than
// eligible beaches, the beaches at the end of that order never got a turn.
// Fair ordering instead: never-archived-at-all first, then oldest
// most-recent-row first, ties by slug.
describe("listArchiveCandidates — fair ordering (Codex round-3 finding #1)", () => {
  it("orders never-archived beaches before archived ones, and archived ones oldest-last-row-first", async () => {
    const store = await getStore();
    const nowMs = Date.parse("2026-09-20T17:00:00Z"); // ~1 PM ET — daylight, none archived this hour

    // fort-lauderdale's most recent row is OLDER than deerfield-beach's.
    await store.upsertBeachHourly(
      row({ slug: "fort-lauderdale", hour_utc: hourUtcOf(Date.parse("2026-09-20T10:00:00Z")) }),
    );
    await store.upsertBeachHourly(
      row({ slug: "deerfield-beach", hour_utc: hourUtcOf(Date.parse("2026-09-20T15:00:00Z")) }),
    );
    // boca-raton has never been archived at all.

    const candidates = await store.listArchiveCandidates(nowMs);
    const indexOf = (slug: string) => candidates.findIndex((c) => c.slug === slug);

    expect(indexOf("boca-raton")).toBeGreaterThanOrEqual(0);
    expect(indexOf("fort-lauderdale")).toBeGreaterThanOrEqual(0);
    expect(indexOf("deerfield-beach")).toBeGreaterThanOrEqual(0);

    // Never-archived before archived...
    expect(indexOf("boca-raton")).toBeLessThan(indexOf("fort-lauderdale"));
    expect(indexOf("boca-raton")).toBeLessThan(indexOf("deerfield-beach"));
    // ...and among archived beaches, the OLDER last row comes first.
    expect(indexOf("fort-lauderdale")).toBeLessThan(indexOf("deerfield-beach"));
  });

  it("ties among never-archived beaches (and among equal last-hour beaches) break by slug", async () => {
    const store = await getStore();
    const nowMs = Date.parse("2026-09-20T17:00:00Z");
    const candidates = await store.listArchiveCandidates(nowMs);
    const neverArchived = candidates.filter((c) => ["boca-raton", "deerfield-beach", "fort-lauderdale"].includes(c.slug));
    const slugs = neverArchived.map((c) => c.slug);
    expect(slugs).toEqual([...slugs].sort());
  });
});

describe("reserveHistoryBuild — atomic per-build reservation", () => {
  it("starts at zero and accumulates one reservation per successful call", async () => {
    const store = await getStore();
    expect(await store.getHistoryBudget("2026-09-20")).toBe(0);
    expect(await store.reserveHistoryBuild("2026-09-20", 10)).toBe(true);
    expect(await store.reserveHistoryBuild("2026-09-20", 10)).toBe(true);
    expect(await store.getHistoryBudget("2026-09-20")).toBe(2);
    // A different day is untouched.
    expect(await store.getHistoryBudget("2026-09-21")).toBe(0);
  });

  it("refuses a reservation once the day's builds reach max", async () => {
    const store = await getStore();
    expect(await store.reserveHistoryBuild("2026-09-20", 2)).toBe(true);
    expect(await store.reserveHistoryBuild("2026-09-20", 2)).toBe(true);
    expect(await store.reserveHistoryBuild("2026-09-20", 2)).toBe(false);
    expect(await store.getHistoryBudget("2026-09-20")).toBe(2);
  });

  // Codex round-2 finding #2: max <= 0 must refuse OUTRIGHT — the bug being
  // fixed was that d1Store's first-ever INSERT for a day sets builds = 1
  // unconditionally (the WHERE clause only guards the ON CONFLICT DO UPDATE
  // branch), so max=0 still let exactly one build through on a fresh day.
  it("refuses every reservation when max is 0, even the very first for the day", async () => {
    const store = await getStore();
    expect(await store.reserveHistoryBuild("2026-09-20", 0)).toBe(false);
    expect(await store.getHistoryBudget("2026-09-20")).toBe(0);
  });

  it("refuses every reservation when max is negative", async () => {
    const store = await getStore();
    expect(await store.reserveHistoryBuild("2026-09-20", -1)).toBe(false);
    expect(await store.getHistoryBudget("2026-09-20")).toBe(0);
  });

  it("charges a reservation to the day passed in, not any other clock — a run crossing midnight splits across two days", async () => {
    const store = await getStore();
    await store.reserveHistoryBuild("2026-09-20", 5);
    await store.reserveHistoryBuild("2026-09-20", 5);
    await store.reserveHistoryBuild("2026-09-21", 5);
    expect(await store.getHistoryBudget("2026-09-20")).toBe(2);
    expect(await store.getHistoryBudget("2026-09-21")).toBe(1);
  });

  it("two concurrent reservations for a max of 1 never both succeed", async () => {
    const store = await getStore();
    const [a, b] = await Promise.all([
      store.reserveHistoryBuild("2026-09-20", 1),
      store.reserveHistoryBuild("2026-09-20", 1),
    ]);
    expect([a, b].filter(Boolean).length).toBe(1);
    expect(await store.getHistoryBudget("2026-09-20")).toBe(1);
  });
});

describe("claimHistoryBuild — one build per (slug, hour_utc)", () => {
  it("the first caller wins the claim", async () => {
    const store = await getStore();
    const hourUtc = hourUtcOf(Date.parse("2026-09-20T14:00:00Z"));
    expect(await store.claimHistoryBuild("boca-raton", hourUtc, Date.now())).toBe(true);
  });

  it("a second caller for the same (slug, hour_utc) loses, even after the first", async () => {
    const store = await getStore();
    const hourUtc = hourUtcOf(Date.parse("2026-09-20T14:00:00Z"));
    expect(await store.claimHistoryBuild("boca-raton", hourUtc, Date.now())).toBe(true);
    expect(await store.claimHistoryBuild("boca-raton", hourUtc, Date.now())).toBe(false);
  });

  it("a different hour for the same slug is a separate claim", async () => {
    const store = await getStore();
    const hourA = hourUtcOf(Date.parse("2026-09-20T14:00:00Z"));
    const hourB = hourUtcOf(Date.parse("2026-09-20T15:00:00Z"));
    expect(await store.claimHistoryBuild("boca-raton", hourA, Date.now())).toBe(true);
    expect(await store.claimHistoryBuild("boca-raton", hourB, Date.now())).toBe(true);
  });

  it("two concurrent callers for the same (slug, hour_utc) — exactly one wins", async () => {
    const store = await getStore();
    const hourUtc = hourUtcOf(Date.parse("2026-09-20T14:00:00Z"));
    const now = Date.now();
    const [a, b] = await Promise.all([
      store.claimHistoryBuild("boca-raton", hourUtc, now),
      store.claimHistoryBuild("boca-raton", hourUtc, now),
    ]);
    expect([a, b].filter(Boolean).length).toBe(1);
  });

  // Codex round-2 finding #4: claims get an abandonment window, same shape
  // as send_claims — a claim with no completed_at after 10 minutes may be
  // re-claimed, so a build that timed out/threw/failed its upsert is
  // retried instead of losing that (slug, hour) forever.
  describe("abandonment window (win / lose / abandon / complete)", () => {
    const hourUtc = hourUtcOf(Date.parse("2026-09-20T14:00:00Z"));

    it("a fresh claim is won", async () => {
      const store = await getStore();
      expect(await store.claimHistoryBuild("boca-raton", hourUtc, 1_000_000)).toBe(true);
    });

    it("a second caller loses while the claim is still fresh (not abandoned)", async () => {
      const store = await getStore();
      expect(await store.claimHistoryBuild("boca-raton", hourUtc, 1_000_000)).toBe(true);
      expect(await store.claimHistoryBuild("boca-raton", hourUtc, 1_000_000 + 60_000)).toBe(false); // 1 min later
    });

    it("a stale, never-completed claim is re-claimable after the 10-minute abandonment window", async () => {
      const store = await getStore();
      const claimedAt = 1_000_000;
      expect(await store.claimHistoryBuild("boca-raton", hourUtc, claimedAt)).toBe(true);
      const stillTooSoon = claimedAt + 9 * 60 * 1000;
      expect(await store.claimHistoryBuild("boca-raton", hourUtc, stillTooSoon)).toBe(false);
      const abandoned = claimedAt + 10 * 60 * 1000 + 1;
      expect(await store.claimHistoryBuild("boca-raton", hourUtc, abandoned)).toBe(true);
    });

    it("a COMPLETED claim can never be re-claimed, no matter how old", async () => {
      const store = await getStore();
      const claimedAt = 1_000_000;
      expect(await store.claimHistoryBuild("boca-raton", hourUtc, claimedAt)).toBe(true);
      await store.completeHistoryClaim("boca-raton", hourUtc, claimedAt + 1000);
      const wayLater = claimedAt + 24 * 60 * 60 * 1000;
      expect(await store.claimHistoryBuild("boca-raton", hourUtc, wayLater)).toBe(false);
    });

    it("releaseHistoryClaim deletes the claim outright — an immediate re-claim succeeds, no need to wait out the window", async () => {
      const store = await getStore();
      const claimedAt = 1_000_000;
      expect(await store.claimHistoryBuild("boca-raton", hourUtc, claimedAt)).toBe(true);
      await store.releaseHistoryClaim("boca-raton", hourUtc);
      expect(await store.claimHistoryBuild("boca-raton", hourUtc, claimedAt + 1000)).toBe(true);
    });
  });
});

describe("memory store persistence round-trip", () => {
  it("beach_hourly, history_budget and history_claims survive a save/load cycle", async () => {
    const { createMemoryStore } = await import("@/lib/db/memoryStore");
    const os = await import("node:os");
    const path = await import("node:path");
    const file = path.join(os.tmpdir(), `history-store-test-${Date.now()}-${Math.random()}.json`);
    const hourUtc = hourUtcOf(Date.parse("2026-09-20T14:00:00Z"));

    const store1 = createMemoryStore({ file });
    await store1.upsertBeachHourly(row({ hour_utc: hourUtc }));
    await store1.reserveHistoryBuild("2026-09-20", 10);
    await store1.claimHistoryBuild("boca-raton", hourUtc, Date.now());
    await store1.completeHistoryClaim("boca-raton", hourUtc, Date.now());

    const store2 = createMemoryStore({ file });
    // A fresh store instance backed by the same file must rehydrate all three.
    expect(await store2.getHistoryBudget("2026-09-20")).toBe(1);
    const candidates = await store2.listArchiveCandidates(Date.parse("2026-09-20T14:30:00Z"));
    expect(candidates.find((c) => c.slug === "boca-raton")).toBeUndefined(); // beach_hourly rehydrated
    // completed_at rehydrated too: even a wildly-later, "abandoned-looking"
    // claim attempt must still lose, because the claim it would abandon was
    // actually completed (Codex round-2 finding #4).
    const wayLater = Date.now() + 24 * 60 * 60 * 1000;
    const wonAgain = await store2.claimHistoryBuild("boca-raton", hourUtc, wayLater);
    expect(wonAgain).toBe(false);
  });

  // Codex round-2 finding #5: upsertBeachHourly mutated the in-memory map but
  // never called save() — a successful archive write was silently lost on
  // the next process/file reopen.
  it("upsertBeachHourly persists immediately: reopening the file store right after sees the write", async () => {
    const { createMemoryStore } = await import("@/lib/db/memoryStore");
    const os = await import("node:os");
    const path = await import("node:path");
    const file = path.join(os.tmpdir(), `history-upsert-save-test-${Date.now()}-${Math.random()}.json`);
    const hourUtc = hourUtcOf(Date.parse("2026-09-20T14:00:00Z"));

    const store1 = createMemoryStore({ file });
    const result = await store1.upsertBeachHourly(row({ hour_utc: hourUtc }));
    expect(result.written).toBe(true);

    // Reopen from the same file with no other call in between.
    const store2 = createMemoryStore({ file });
    const candidates = await store2.listArchiveCandidates(Date.parse("2026-09-20T14:30:00Z"));
    expect(candidates.find((c) => c.slug === "boca-raton")).toBeUndefined(); // the row is there
  });
});
