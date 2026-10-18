// The lean wire form of a conditions response (lib/clientConditions.ts).
//
// Four jobs:
//   1. The packing is lossless: unpack(pack(x)) is x, and anything it cannot
//      restore exactly it refuses to pack.
//   2. The page is IDENTICAL whether it is handed the full response or the lean
//      one — same server HTML for two beaches, same personal score for every
//      profile, same derived metrics at several clocks.
//   3. A size budget: the snapshot the page serializes into the HTML may not
//      creep back toward the 160 KB it was.
//   4. The fields the wire form drops stay unread by client code.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, prefetch() {}, back() {}, forward() {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import { ConditionsDashboard } from "@/components/ConditionsDashboard";
import { listLocations, toPublicLocation } from "@/config/locations";
import { fromWire, isWire, packRows, toWire, unpackRows } from "@/lib/clientConditions";
import { computePersonalScore } from "@/lib/plus/personalScore";
import { PROFILE_IDS } from "@/lib/profile/presets";
import { resolveScoring } from "@/lib/profile/resolve";
import { deriveMetrics } from "@/lib/score";
import type { ConditionsResponse } from "@/lib/types";

const FIXTURES = {
  "boca-raton": "lib/__fixtures__/conditions-boca-raton-2026-10-18.json",
  "siesta-key": "lib/__fixtures__/conditions-siesta-key-2026-10-18.json",
} as const;

function load(slug: keyof typeof FIXTURES): ConditionsResponse {
  return JSON.parse(readFileSync(FIXTURES[slug], "utf8")) as ConditionsResponse;
}

/** What the browser sees: the wire object after a JSON round trip, as over the network. */
function overTheWire(res: ConditionsResponse) {
  return JSON.parse(JSON.stringify(toWire(res)));
}

describe("packRows / unpackRows", () => {
  it("round-trips flat rows, restoring absent fields as absent", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      time: new Date(Date.UTC(2026, 9, 18, i)).toISOString(),
      a: i * 3,
      b: i % 2 === 0 ? undefined : 7,
      sky: i < 5 ? "Clear" : "Cloudy",
      flag: i === 4,
    }));
    const packed = packRows(rows);
    const back = unpackRows(JSON.parse(JSON.stringify(packed)));
    const expected = rows.map((r) => JSON.parse(JSON.stringify(r)));
    expect(back).toEqual(expected);
    // Absent stays absent — not a key holding null/undefined.
    expect(Object.keys(back![0])).not.toContain("b");
  });

  it("uses a stride for a regular time column and a dictionary for repeated words", () => {
    const rows = Array.from({ length: 24 }, (_, i) => ({
      time: new Date(Date.UTC(2026, 9, 18, i)).toISOString(),
      sky: i % 3 === 0 ? "Clear" : "Cloudy",
    }));
    const packed = packRows(rows) as { c: Record<string, unknown>[] };
    expect(packed.c[0]).toEqual({ t: [rows[0].time, 3_600_000] });
    expect(Object.keys(packed.c[1])).toEqual(["d", "i"]);
  });

  it("keeps an irregular time column as plain values", () => {
    const rows = [0, 1, 2, 5, 6].map((h) => ({ time: new Date(Date.UTC(2026, 9, 18, h)).toISOString(), v: h }));
    const back = unpackRows(JSON.parse(JSON.stringify(packRows(rows))));
    expect(back).toEqual(rows);
  });

  it("refuses to pack what it cannot restore exactly", () => {
    const withNull = [1, 2, 3, 4, 5].map((i) => ({ i, x: i === 2 ? null : i }));
    expect(packRows(withNull)).toBe(withNull);
    const nested = [1, 2, 3, 4, 5].map((i) => ({ i, o: { a: i } }));
    expect(packRows(nested)).toBe(nested);
    const nan = [1, 2, 3, 4, 5].map((i) => ({ i, x: i === 3 ? NaN : i }));
    expect(packRows(nan)).toBe(nan);
  });

  it("leaves short arrays and missing arrays alone", () => {
    const short = [{ a: 1 }, { a: 2 }];
    expect(packRows(short)).toBe(short);
    expect(packRows(undefined)).toBeUndefined();
    expect(unpackRows(undefined)).toBeUndefined();
    expect(unpackRows(short)).toBe(short);
  });
});

describe("toWire / fromWire", () => {
  for (const slug of Object.keys(FIXTURES) as (keyof typeof FIXTURES)[]) {
    describe(slug, () => {
      it("restores everything except the fields that are deliberately dropped", () => {
        const full = load(slug);
        const back = fromWire(overTheWire(full));
        const expected = JSON.parse(JSON.stringify(full)) as ConditionsResponse;
        expected.hourlyScores = [];
        delete expected.hourlyForecast;
        const buoy = expected.snapshot.buoy?.data;
        if (buoy) delete buoy.waterTempHistory;
        expect(back).toEqual(expected);
      });

      it("is marked as a wire object, and fromWire leaves a plain response untouched", () => {
        const full = load(slug);
        expect(isWire(toWire(full))).toBe(true);
        expect(isWire(full)).toBe(false);
        expect(fromWire(full)).toBe(full);
      });

      it("does not mutate its input", () => {
        const full = load(slug);
        const before = JSON.stringify(full);
        toWire(full);
        expect(JSON.stringify(full)).toBe(before);
      });

      it("never carries server-only fields", () => {
        const full = load(slug);
        const tainted = {
          ...full,
          budgetAborted: true,
          snapshot: { ...full.snapshot, skyAlertCandidates: [{ secret: 1 }] },
        } as unknown as ConditionsResponse;
        const text = JSON.stringify(toWire(tainted));
        expect(text).not.toContain("budgetAborted");
        expect(text).not.toContain("skyAlertCandidates");
      });

      // The budget. Measured 53.5 KB (Boca) and 39.9 KB (Siesta Key) on 2026-10-18,
      // against 160 KB and 142 KB before. Raise it only on purpose, and say why here.
      it("stays inside the size budget the page serializes", () => {
        const full = load(slug);
        const lean = JSON.stringify(toWire(full)).length;
        expect(lean).toBeLessThanOrEqual(60_000);
        expect(lean).toBeLessThan(JSON.stringify(full).length * 0.45);
      });

      it("renders the same server HTML as the full response", () => {
        const full = load(slug);
        const render = (initial: unknown) =>
          renderToString(
            createElement(ConditionsDashboard, {
              slug,
              initial: initial as ConditionsResponse,
              browseHref: "/find",
              isNativeApp: false,
              beaches: listLocations().map(toPublicLocation),
            }),
          );
        const fromFull = render(full);
        const fromLean = render(overTheWire(full));
        expect(fromFull.length).toBeGreaterThan(50_000); // it really rendered the dashboard
        expect(fromLean).toBe(fromFull);
      });

      it("scores the same for every profile, at several clocks", () => {
        const full = load(slug);
        const lean = fromWire(overTheWire(full));
        const gen = Date.parse(full.snapshot.generatedAt);
        for (const hours of [0, 3, 9, 20]) {
          const now = gen + hours * 3_600_000;
          expect(deriveMetrics(lean.snapshot, now)).toEqual(deriveMetrics(full.snapshot, now));
          for (const id of PROFILE_IDS) {
            const opts = resolveScoring({ profiles: [id], heat: "hot", crowds: "high" });
            expect(computePersonalScore(lean, opts, now)).toEqual(computePersonalScore(full, opts, now));
          }
        }
      });
    });
  }
});

// The wire form drops three things. This keeps them from being quietly picked up
// by client code later: if one of these lists grows a name, either the wire form
// must carry that field again or the new reader must go.
describe("fields the wire form drops are not read by client code", () => {
  const ROOTS = ["components", "app", "lib"];
  const SKIP_DIRS = new Set(["__fixtures__", "node_modules", "sources", "agent", "alerts", "push", "admin", "scorecard", "history", "camFrames", "vision"]);

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (!SKIP_DIRS.has(name)) sourceFiles(p, out);
      } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
    }
    return out;
  }
  const files = ROOTS.flatMap((r) => sourceFiles(r));

  function readers(word: string): string[] {
    return files.filter((f) => new RegExp(`\\b${word}\\b`).test(readFileSync(f, "utf8")));
  }

  it("waterTempHistory is only produced and consumed on the server", () => {
    // lib/types.ts declares it, lib/conditions.ts turns it into snapshot.waterTrend,
    // lib/clientConditions.ts is the one that drops it.
    expect(readers("waterTempHistory").sort()).toEqual([
      "lib/clientConditions.ts",
      "lib/conditions.ts",
      "lib/types.ts",
    ]);
  });

  it("hourlyScores / hourlyForecast have no client reader", () => {
    const allowed = new Set([
      "lib/conditions.ts", // builds them
      "lib/types.ts", // declares them
      "lib/plus/personalScore.ts", // makes its own, from the snapshot
      "lib/clientConditions.ts", // drops them
      "lib/push/notify.ts", // server only: the morning push
      "lib/skyEvents.ts",
      "lib/sandTemp.ts",
      "lib/score.ts",
      "lib/skyVisibilityQuality.ts",
      "lib/sunQuality.ts",
    ]);
    const stray = [...readers("hourlyScores"), ...readers("hourlyForecast")].filter((f) => !allowed.has(f));
    expect(stray).toEqual([]);
  });
});
