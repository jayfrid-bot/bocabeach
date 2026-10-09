// Pure-logic coverage for components/plus/HistorySection.tsx. Only the
// exported, side-effect-free pieces — no rendering, no SWR, no DOM (see
// components/plus/BeachModeCard.test.ts / Paywall.test.ts for the same
// pattern elsewhere in this codebase).

import { describe, it, expect, vi } from "vitest";
import {
  dayFormulaState,
  formulaChangeNotice,
  recordFormulaNote,
  recordTiles,
  resolveHistoryViewState,
  retryHistoryFetch,
} from "@/components/plus/HistorySection";
import type { HistoryResult } from "@/lib/plus/api";
import type { DaySummary, HistoryBestEver, HistoryRecords, HistoryVersions } from "@/lib/history/summary";

const OK_RESULT: HistoryResult & { ok: true } = {
  ok: true,
  since: "2026-09-22",
  days: [],
  records: null,
  bestEver: null,
  versions: null,
  recordsSince: null,
  recordsFromEarlierFormula: false,
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
  bestEver: null,
  versions: null,
  recordsSince: null,
  recordsFromEarlierFormula: false,
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

const FULL_RECORDS: HistoryRecords = {
  bestDay: { date: "2026-09-26", score: 93, localHour: 8, engineVersion: CURRENT },
  hottestSand: { date: "2026-09-26", sandTempF: 141, localHour: 14 },
  biggestSurf: { date: "2026-09-21", surfFt: 3.4, localHour: 13 },
  quietestDay: { date: "2026-09-28", crowdPct: 15, localHour: 15 },
};

const BEST_EVER: HistoryBestEver = {
  slug: "gulf-shores",
  name: "Gulf Shores",
  date: "2026-09-29",
  score: 98,
  localHour: 13,
  isThisBeach: false,
  engineVersion: CURRENT,
};

// The cross-beach "Best day ever" tile: first in the list, names the beach,
// and says "This beach!" instead when the record belongs to the beach shown.
describe("recordTiles — Best day ever", () => {
  it("leads the list, with this beach's own Best day right after it", () => {
    const tiles = recordTiles(FULL_RECORDS, "2026-09-14", "2026-09-14", BEST_EVER);
    expect(tiles.map((t) => t.key)).toEqual(["best-ever", "best", "sand", "surf", "quiet"]);
  });

  it("shows the score, the beach name, and the local date and hour", () => {
    const [first] = recordTiles(FULL_RECORDS, "2026-09-14", "2026-09-14", BEST_EVER);
    expect(first).toMatchObject({
      icon: "\u{1f947}",
      label: "Best day ever",
      value: "98",
      sub: "Gulf Shores \u00b7 Sept 29, 1 PM",
    });
  });

  it("says 'This beach!' instead of the name when the record is at this beach", () => {
    const [first] = recordTiles(FULL_RECORDS, "2026-09-14", "2026-09-14", { ...BEST_EVER, isThisBeach: true });
    expect(first.sub).toBe("This beach! Sept 29, 1 PM");
    expect(first.sub).not.toContain("Gulf Shores");
  });

  it("formats midnight and noon hours as 12 AM and 12 PM", () => {
    const [mid] = recordTiles(FULL_RECORDS, null, null, { ...BEST_EVER, localHour: 0 });
    const [noon] = recordTiles(FULL_RECORDS, null, null, { ...BEST_EVER, localHour: 12 });
    expect(mid.sub).toBe("Gulf Shores \u00b7 Sept 29, 12 AM");
    expect(noon.sub).toBe("Gulf Shores \u00b7 Sept 29, 12 PM");
  });

  it("is absent when no best-ever record exists — the other four tiles are unchanged", () => {
    const withNull = recordTiles(FULL_RECORDS, "2026-09-14", "2026-09-14", null);
    const withDefault = recordTiles(FULL_RECORDS, "2026-09-14", "2026-09-14");
    expect(withNull.map((t) => t.key)).toEqual(["best", "sand", "surf", "quiet"]);
    expect(withDefault).toEqual(withNull);
  });

  it("still shows alone for a beach with no records of its own yet", () => {
    const tiles = recordTiles(
      { bestDay: null, hottestSand: null, biggestSurf: null, quietestDay: null },
      null,
      null,
      BEST_EVER,
    );
    expect(tiles.map((t) => t.key)).toEqual(["best-ever"]);
  });

  it("keeps the sub line short enough to wrap inside MetricCard's 3-line clamp on a phone", () => {
    // A 2-column tile at 390px has ~138px of text width, about 22 characters
    // of 12px type a line, so 3 lines hold ~66. The longest beach name today
    // is 18 characters; this pads it to 21 and still keeps well under that.
    const [first] = recordTiles(FULL_RECORDS, null, null, {
      ...BEST_EVER,
      name: "Fort Lauderdale Beach",
      localHour: 12,
    });
    expect(first.sub.length).toBeLessThanOrEqual(45);
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

// --- Scoring-formula notices ------------------------------------------------
const EARLIER = "2026-10-06.1";
const SINGLE: HistoryVersions = {
  current: CURRENT,
  inRange: [EARLIER, CURRENT],
  mixed: true,
  boundaries: [{ date: "2026-10-09", version: CURRENT, note: "Strong wind costs more." }],
};

describe("formulaChangeNotice", () => {
  it("names the one change in range", () => {
    expect(formulaChangeNotice(SINGLE)).toBe(
      "Scoring changed on Oct 9 \u2014 days before that were scored by an earlier formula.",
    );
  });

  it("names the most recent change and says 'and earlier' when there are more", () => {
    const many: HistoryVersions = {
      ...SINGLE,
      inRange: ["2026-09-22.1", EARLIER, CURRENT],
      boundaries: [
        { date: "2026-09-28", version: "2026-09-28.1", note: "a" },
        { date: "2026-10-06", version: EARLIER, note: "b" },
        { date: "2026-10-09", version: CURRENT, note: "c" },
      ],
    };
    expect(formulaChangeNotice(many)).toBe(
      "Scoring changed on Oct 9 and earlier \u2014 days before that were scored by earlier formulas.",
    );
  });

  it("two changes on the same date count as one date", () => {
    const sameDay: HistoryVersions = {
      ...SINGLE,
      boundaries: [
        { date: "2026-09-28", version: "2026-09-28.1", note: "a" },
        { date: "2026-09-28", version: "2026-09-28.2", note: "b" },
      ],
    };
    expect(formulaChangeNotice(sameDay)).toBe(
      "Scoring changed on Sept 28 \u2014 days before that were scored by an earlier formula.",
    );
  });

  it("is null when the range holds no change, or there is no versions block", () => {
    expect(formulaChangeNotice({ current: CURRENT, inRange: [CURRENT], mixed: false, boundaries: [] })).toBeNull();
    expect(formulaChangeNotice({ current: CURRENT, inRange: [], mixed: false, boundaries: [] })).toBeNull();
    expect(formulaChangeNotice(null)).toBeNull();
  });

  it("says the change date when every shown day predates the current formula", () => {
    const allOld: HistoryVersions = { current: CURRENT, inRange: [EARLIER], mixed: false, boundaries: [] };
    expect(formulaChangeNotice(allOld)).toBe(
      "Scoring changed on Oct 9 \u2014 these days were scored by an earlier formula.",
    );
  });

  it("never uses the word AI", () => {
    expect(formulaChangeNotice(SINGLE)).not.toMatch(/\bAI\b/);
  });
});

function day(engineVersions: string[]): DaySummary {
  return {
    date: "2026-10-09",
    weekday: "Fri",
    hours: 8,
    best: { score: 80, localHour: 12 },
    worst: { score: 60, localHour: 8 },
    avg: 70,
    airHighF: 85,
    waterF: 84,
    sandMaxF: 120,
    surfMaxFt: 2,
    crowdPeakPct: null,
    seaweedMaxPct: null,
    caps: [],
    partial: false,
    hourly: [],
    engineVersions,
    mixedVersions: engineVersions.length > 1,
  };
}

describe("dayFormulaState", () => {
  it("is 'current' when every row used the current formula", () => {
    expect(dayFormulaState(day([CURRENT]), CURRENT)).toBe("current");
  });
  it("is 'earlier' when no row did", () => {
    expect(dayFormulaState(day([EARLIER]), CURRENT)).toBe("earlier");
    expect(dayFormulaState(day([EARLIER, "2026-09-28.2"]), CURRENT)).toBe("earlier");
  });
  it("is 'mixed' on a day a change landed", () => {
    expect(dayFormulaState(day([EARLIER, CURRENT]), CURRENT)).toBe("mixed");
  });
  it("marks nothing when the server sent no current version or no versions", () => {
    expect(dayFormulaState(day([EARLIER]), null)).toBe("current");
    expect(dayFormulaState(day([]), CURRENT)).toBe("current");
    expect(dayFormulaState({ ...day([]), engineVersions: undefined as unknown as string[] }, CURRENT)).toBe("current");
  });
});

describe("recordFormulaNote / score tiles", () => {
  const FORMULA = { current: CURRENT, recordsSince: "2026-10-09" };

  it("says when the current formula's count started", () => {
    expect(recordFormulaNote(CURRENT, FORMULA)).toBe("since Oct 9 (current\u00a0formula)");
  });
  it("says 'earlier formula' when the record comes from one", () => {
    expect(recordFormulaNote(EARLIER, FORMULA)).toBe("earlier formula");
  });
  it("says nothing without a formula or a start date", () => {
    expect(recordFormulaNote(CURRENT, undefined)).toBeUndefined();
    expect(recordFormulaNote(CURRENT, { current: CURRENT, recordsSince: null })).toBeUndefined();
  });

  it("puts the note on Best day ever and Best day only", () => {
    const tiles = recordTiles(FULL_RECORDS, "2026-09-14", "2026-09-14", BEST_EVER, FORMULA);
    const byKey = Object.fromEntries(tiles.map((t) => [t.key, t]));
    expect(byKey["best-ever"].note).toBe("since Oct 9 (current\u00a0formula)");
    expect(byKey.best.note).toBe("since Oct 9 (current\u00a0formula)");
    expect(byKey.sand.note).toBeUndefined();
    expect(byKey.quiet.note).toBeUndefined();
  });

  it("labels each score tile by its own record's formula", () => {
    const tiles = recordTiles(
      { ...FULL_RECORDS, bestDay: { ...FULL_RECORDS.bestDay!, engineVersion: EARLIER } },
      "2026-09-14",
      "2026-09-14",
      BEST_EVER,
      FORMULA,
    );
    const byKey = Object.fromEntries(tiles.map((t) => [t.key, t]));
    expect(byKey.best.note).toBe("earlier formula");
    expect(byKey["best-ever"].note).toBe("since Oct 9 (current\u00a0formula)");
  });

  it("leaves the tiles bare when no formula is passed (older server)", () => {
    const tiles = recordTiles(FULL_RECORDS, "2026-09-14", "2026-09-14", BEST_EVER);
    expect(tiles.find((t) => t.key === "best")?.note).toBeUndefined();
    expect(tiles.find((t) => t.key === "best-ever")?.note).toBeUndefined();
  });
});
