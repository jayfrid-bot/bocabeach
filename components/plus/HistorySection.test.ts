// Pure-logic coverage for components/plus/HistorySection.tsx. Only the
// exported, side-effect-free pieces — no rendering, no SWR, no DOM (see
// components/plus/BeachModeCard.test.ts / Paywall.test.ts for the same
// pattern elsewhere in this codebase).

import { describe, it, expect, vi } from "vitest";
import {
  recordTiles,
  resolveHistoryViewState,
  retryHistoryFetch,
} from "@/components/plus/HistorySection";
import type { HistoryResult } from "@/lib/plus/api";
import type { HistoryRecords } from "@/lib/history/summary";

const OK_RESULT: HistoryResult & { ok: true } = {
  ok: true,
  since: "2026-09-22",
  days: [],
  records: null,
  versions: null,
  archiveStartedAt: null,
  dayCount: 0,
  surfSince: null,
  error: null,
  status: 200,
};

const FAILED_RESULT: HistoryResult = {
  ok: false,
  since: null,
  days: [],
  records: null,
  versions: null,
  archiveStartedAt: null,
  dayCount: 0,
  surfSince: null,
  error: "server",
  status: 500,
};

// Codex round-2 #1: the whole point of this helper is that these four
// states are distinguishable and NONE of them can leave the UI stuck on a
// permanent "Loading…" — a device that finishes bootstrapping with no
// token is a genuine dead end for this feature, not a still-loading one.
describe("resolveHistoryViewState", () => {
  it("is 'loading' before bootstrap has finished, regardless of anything else", () => {
    expect(resolveHistoryViewState({ bootstrapDone: false, installToken: null, data: undefined })).toEqual({
      kind: "loading",
    });
    // Even a stray non-null token or data shouldn't short-circuit this —
    // bootstrapDone is the gate.
    expect(resolveHistoryViewState({ bootstrapDone: false, installToken: "tok", data: OK_RESULT })).toEqual({
      kind: "loading",
    });
  });

  it("is 'no-token-error' once bootstrap finishes with no token — never a dead 'loading'", () => {
    expect(resolveHistoryViewState({ bootstrapDone: true, installToken: null, data: undefined })).toEqual({
      kind: "no-token-error",
    });
  });

  it("is 'loading' once bootstrap has a token but the fetch hasn't resolved yet", () => {
    expect(resolveHistoryViewState({ bootstrapDone: true, installToken: "tok", data: undefined })).toEqual({
      kind: "loading",
    });
  });

  it("is 'fetch-error' when the fetch resolved but failed", () => {
    expect(resolveHistoryViewState({ bootstrapDone: true, installToken: "tok", data: FAILED_RESULT })).toEqual({
      kind: "fetch-error",
    });
  });

  it("is 'data' once bootstrap has a token and the fetch succeeded", () => {
    const state = resolveHistoryViewState({ bootstrapDone: true, installToken: "tok", data: OK_RESULT });
    expect(state).toEqual({ kind: "data", data: OK_RESULT });
  });

  it("bootstrapDone and installToken are tracked independently — a token that arrives late still resolves to loading, not stuck on the earlier no-token-error", () => {
    // Simulates the component's own state sequence across renders: first
    // render after mount (still checking), then bootstrap resolves with no
    // token (a real dead end), then a manual retry starts a NEW bootstrap
    // pass — which must read as "loading" again, not still "no-token-error"
    // from the previous pass, even though `installToken` hasn't changed yet
    // at the instant `bootstrapDone` flips back to false.
    const beforeMount = resolveHistoryViewState({ bootstrapDone: false, installToken: null, data: undefined });
    const afterFailedBootstrap = resolveHistoryViewState({ bootstrapDone: true, installToken: null, data: undefined });
    const duringRetry = resolveHistoryViewState({ bootstrapDone: false, installToken: null, data: undefined });
    expect(beforeMount).toEqual({ kind: "loading" });
    expect(afterFailedBootstrap).toEqual({ kind: "no-token-error" });
    expect(duringRetry).toEqual({ kind: "loading" });
  });
});

const CURRENT = "2026-10-09.1";

const NO_RECORDS: HistoryRecords = {
  bestDay: null,
  hottestSand: null,
  biggestSurf: null,
  quietestDay: null,
  warmestWater: null,
  clearestWater: null,
  bestSunrise: null,
  bestSunset: null,
};

const FULL_RECORDS: HistoryRecords = {
  bestDay: { date: "2026-09-26", score: 93, localHour: 8, engineVersion: CURRENT },
  hottestSand: { date: "2026-09-26", sandTempF: 141, localHour: 14 },
  biggestSurf: { date: "2026-09-21", surfFt: 3.4, localHour: 13 },
  quietestDay: { date: "2026-09-28", crowdPct: 15, localHour: 15 },
  warmestWater: { date: "2026-09-24", waterTempF: 87.4, localHour: 16 },
  clearestWater: { date: "2026-09-30", clarityPct: 91.6, localHour: 11 },
  bestSunrise: { date: "2026-10-02", score: 78, band: "vivid" },
  bestSunset: { date: "2026-10-04", score: 91, band: "epic" },
};

// Records are for THIS beach and all-time across formulas: no cross-beach
// "Best day ever" tile, and no formula wording on any tile.
describe("recordTiles — every record, this beach only", () => {
  it("lists every record in order", () => {
    const tiles = recordTiles(FULL_RECORDS, "2026-09-14", "2026-09-14");
    expect(tiles.map((t) => t.key)).toEqual(["best", "sand", "surf", "quiet", "water", "clear", "sunrise", "sunset"]);
  });

  it("has no cross-beach 'Best day ever' tile", () => {
    const tiles = recordTiles(FULL_RECORDS, "2026-09-14", "2026-09-14");
    expect(tiles.some((t) => t.key === "best-ever" || /ever/i.test(t.label))).toBe(false);
  });

  it("Best day shows the score with its day and hour, and no formula note", () => {
    const best = recordTiles(FULL_RECORDS, "2026-09-14", "2026-09-14")[0];
    expect(best).toMatchObject({ label: "Best day", value: "93", sub: "Sept 26, 8 AM" });
    expect(best.note).toBeUndefined();
  });

  it("an old-formula record reads exactly like a current one: nothing marks it", () => {
    const old = recordTiles(
      { ...FULL_RECORDS, bestDay: { ...FULL_RECORDS.bestDay!, engineVersion: "2026-10-06.1" } },
      "2026-09-14",
      "2026-09-14",
    );
    const current = recordTiles(FULL_RECORDS, "2026-09-14", "2026-09-14");
    expect(old).toEqual(current);
  });

  it("no tile or note anywhere mentions a formula or 'since' a formula date", () => {
    for (const t of recordTiles(FULL_RECORDS, "2026-09-14", "2026-09-14")) {
      expect(`${t.label} ${t.sub} ${t.note ?? ""}`).not.toMatch(/formula/i);
    }
  });

  it("Warmest water rounds to whole degrees, Clearest water to a whole percent", () => {
    const tiles = recordTiles(FULL_RECORDS, null, null);
    expect(tiles.find((t) => t.key === "water")).toMatchObject({
      label: "Warmest water",
      value: "87°",
      sub: "Sept 24, 4 PM",
    });
    expect(tiles.find((t) => t.key === "clear")).toMatchObject({
      label: "Clearest water",
      value: "92%",
      sub: "Sept 30, 11 AM",
    });
  });

  it("Best sunrise and Best sunset show the color score and the day", () => {
    const tiles = recordTiles(FULL_RECORDS, null, null);
    expect(tiles.find((t) => t.key === "sunrise")).toMatchObject({ label: "Best sunrise", value: "78", sub: "Oct 2" });
    expect(tiles.find((t) => t.key === "sunset")).toMatchObject({ label: "Best sunset", value: "91", sub: "Oct 4" });
  });

  it("a record the beach has no data for is simply left out", () => {
    const tiles = recordTiles({ ...NO_RECORDS, bestDay: FULL_RECORDS.bestDay, bestSunset: FULL_RECORDS.bestSunset }, null, null);
    expect(tiles.map((t) => t.key)).toEqual(["best", "sunset"]);
  });

  it("an older server that sends none of the new fields still renders the original four", () => {
    const old = {
      bestDay: FULL_RECORDS.bestDay,
      hottestSand: FULL_RECORDS.hottestSand,
      biggestSurf: FULL_RECORDS.biggestSurf,
      quietestDay: FULL_RECORDS.quietestDay,
    } as HistoryRecords;
    expect(recordTiles(old, null, null).map((t) => t.key)).toEqual(["best", "sand", "surf", "quiet"]);
  });

  it("formats midnight and noon hours as 12 AM and 12 PM", () => {
    const mid = recordTiles({ ...FULL_RECORDS, bestDay: { ...FULL_RECORDS.bestDay!, localHour: 0 } }, null, null)[0];
    const noon = recordTiles({ ...FULL_RECORDS, bestDay: { ...FULL_RECORDS.bestDay!, localHour: 12 } }, null, null)[0];
    expect(mid.sub).toBe("Sept 26, 12 AM");
    expect(noon.sub).toBe("Sept 26, 12 PM");
  });
});

// Codex round-2 #2/#3: the "Biggest surf" tile's coverage caption and the
// "Quietest time" rename+caption.
describe("recordTiles", () => {
  it("labels the crowd record 'Quietest time' (not 'day') with a weekday in its caption", () => {
    const tiles = recordTiles(FULL_RECORDS, "2026-09-14", "2026-09-14");
    const quiet = tiles.find((t) => t.key === "quiet");
    expect(quiet?.label).toBe("Quietest time");
    expect(quiet?.value).toBe("15%");
    // 2026-09-28 is a Monday, hour 15 is 3 PM.
    expect(quiet?.sub).toBe("Mon Sept 28, 3 PM");
  });

  it("adds a 'since <date>' note to Biggest surf when surfSince is later than archiveStartedAt", () => {
    const tiles = recordTiles(FULL_RECORDS, "2026-09-14", "2026-09-20");
    const surf = tiles.find((t) => t.key === "surf");
    expect(surf?.note).toBe("since Sept 20");
  });

  it("omits the note when surf coverage starts with the archive itself", () => {
    const tiles = recordTiles(FULL_RECORDS, "2026-09-14", "2026-09-14");
    const surf = tiles.find((t) => t.key === "surf");
    expect(surf?.note).toBeUndefined();
  });

  it("omits the note when either date is missing — never a fabricated comparison", () => {
    const noArchiveDate = recordTiles(FULL_RECORDS, null, "2026-09-20");
    const noSurfSince = recordTiles(FULL_RECORDS, "2026-09-14", null);
    expect(noArchiveDate.find((t) => t.key === "surf")?.note).toBeUndefined();
    expect(noSurfSince.find((t) => t.key === "surf")?.note).toBeUndefined();
  });

  it("never invents a wave_ft fallback — a null biggestSurf record simply has no surf tile", () => {
    const tiles = recordTiles({ ...FULL_RECORDS, biggestSurf: null }, "2026-09-14", null);
    expect(tiles.find((t) => t.key === "surf")).toBeUndefined();
  });

  it("skips a tile entirely for any record that's null, and returns [] when all are", () => {
    expect(recordTiles(NO_RECORDS, null, null)).toEqual([]);
  });
});

// The bug this guards against: a single "Try again" handler used to force a
// token refresh on EVERY retry. /api/devices mints an install token exactly
// ONCE per device, so forceRefresh's clearInstallToken() on a plain
// network/429/500 failure (a `fetch-error`, where the token is presumably
// fine) could permanently strip a device of its only token — no
// server-side recovery exists, breaking history, hazards, and Live
// Activities for good. The single forced refresh belongs ONLY inside
// fetchHistoryWithRetry's own 401 handling, never here.
describe("retryHistoryFetch", () => {
  it("fetch-error: only revalidates — never calls bootstrap, forced or not", async () => {
    const bootstrap = vi.fn();
    const mutate = vi.fn().mockResolvedValue(undefined);
    const result = await retryHistoryFetch("fetch-error", { bootstrap, mutate });
    expect(bootstrap).not.toHaveBeenCalled();
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });

  it("no-token-error: calls bootstrap WITHOUT forceRefresh, then revalidates", async () => {
    const bootstrap = vi.fn().mockResolvedValue({ token: "tok" });
    const mutate = vi.fn().mockResolvedValue(undefined);
    const result = await retryHistoryFetch("no-token-error", { bootstrap, mutate });
    expect(bootstrap).toHaveBeenCalledTimes(1);
    // No arguments at all — in particular, never `{ forceRefresh: true }`.
    expect(bootstrap).toHaveBeenCalledWith();
    const [callArgs] = bootstrap.mock.calls[0] as [{ forceRefresh?: boolean } | undefined];
    expect(callArgs?.forceRefresh).not.toBe(true);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ token: "tok" });
  });

  it("no-token-error: bootstrap runs before mutate, not the other way around", async () => {
    const order: string[] = [];
    const bootstrap = vi.fn().mockImplementation(async () => {
      order.push("bootstrap");
      return { token: null };
    });
    const mutate = vi.fn().mockImplementation(async () => {
      order.push("mutate");
    });
    await retryHistoryFetch("no-token-error", { bootstrap, mutate });
    expect(order).toEqual(["bootstrap", "mutate"]);
  });

  it("no-token-error still resolves the (possibly still-null) token, never throwing when bootstrap finds nothing", async () => {
    const bootstrap = vi.fn().mockResolvedValue({ token: null });
    const result = await retryHistoryFetch("no-token-error", { bootstrap, mutate: vi.fn() });
    expect(result).toEqual({ token: null });
  });
});
