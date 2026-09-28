// Pure-logic coverage for components/plus/HistorySection.tsx. Only the
// exported, side-effect-free pieces — no rendering, no SWR, no DOM (see
// components/plus/BeachModeCard.test.ts / Paywall.test.ts for the same
// pattern elsewhere in this codebase).

import { describe, it, expect } from "vitest";
import { recordTiles, resolveHistoryViewState } from "@/components/plus/HistorySection";
import type { HistoryResult } from "@/lib/plus/api";
import type { HistoryRecords } from "@/lib/history/summary";

const OK_RESULT: HistoryResult & { ok: true } = {
  ok: true,
  since: "2026-09-22",
  days: [],
  records: null,
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

const FULL_RECORDS: HistoryRecords = {
  bestDay: { date: "2026-09-26", score: 93, localHour: 8 },
  hottestSand: { date: "2026-09-26", sandTempF: 141, localHour: 14 },
  biggestSurf: { date: "2026-09-21", surfFt: 3.4, localHour: 13 },
  quietestDay: { date: "2026-09-28", crowdPct: 15, localHour: 15 },
};

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

  it("skips a tile entirely for any record that's null, and returns [] when all four are", () => {
    expect(
      recordTiles(
        { bestDay: null, hottestSand: null, biggestSurf: null, quietestDay: null },
        null,
        null,
      ),
    ).toEqual([]);
  });
});
