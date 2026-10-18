// What the dashboard loads up front.
//
// Every phone that opens the page downloads the dashboard's STATIC import graph
// before it can hydrate. Code that only the app, or only a tap, ever runs is kept
// out of that graph with next/dynamic or a dynamic import(). This test walks the
// static graph from the page's client entry and fails if one of those modules
// creeps back in, which would quietly add tens of kilobytes to every first load
// (measured 2026-10-18: first-load JS for "/" 276 kB -> see
// docs/benchmarks/2026-10-18-perf/payload.md).
//
// It follows `import … from` and `export … from` (not `import type`, not `import()`).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { describe, expect, it } from "vitest";

const ENTRIES = ["components/ConditionsDashboard.tsx", "app/layout.tsx"];

function resolveLocal(spec: string, from: string): string | null {
  const base = spec.startsWith("@/") ? spec.slice(2) : normalize(join(dirname(from), spec));
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (existsSync(c) && /\.(ts|tsx)$/.test(c)) return c;
  }
  return null;
}

function staticGraph(entries: string[]): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const stack = [...entries];
  const re = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/g;
  while (stack.length) {
    const f = stack.pop()!;
    if (files.has(f)) continue;
    files.add(f);
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(re)) {
      const spec = m[1];
      if (spec.startsWith("@/") || spec.startsWith(".")) {
        const target = resolveLocal(spec, f);
        if (target) stack.push(target);
      } else {
        packages.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
      }
    }
  }
  return { files, packages };
}

describe("the dashboard's static import graph", () => {
  const { files, packages } = staticGraph(ENTRIES);

  it("reaches the dashboard's real dependencies (the walk is working)", () => {
    expect(files.has("components/ScoreWheel.tsx")).toBe(true);
    expect(files.has("lib/score.ts")).toBe(true);
    expect(packages.has("swr")).toBe(true);
    expect(packages.has("react")).toBe(true);
  });

  const LAZY_FILES = [
    ["lib/nerdInfo.ts", "the flip-card back faces"],
    ["components/NerdBackFor.tsx", "the flip-card back faces"],
    ["components/plus/BeachModeCard.tsx", "Beach Mode (app only)"],
    ["components/plus/HistorySection.tsx", "the look-back section (app only)"],
    ["components/plus/DayViewSheet.tsx", "the day view (opened by a tap)"],
    ["components/plus/PlusSheets.tsx", "the Plus sheets (opened by a tap)"],
    ["components/plus/Paywall.tsx", "the paywall (opened by a tap)"],
    ["components/plus/PlusSettingsSheet.tsx", "Plus settings (opened by a tap)"],
    ["components/plus/PlusOnboarding.tsx", "Plus onboarding (opened by a tap)"],
    ["components/CamLightbox.tsx", "the cam zoom viewer (opened by a tap)"],
    ["components/ZoomableImage.tsx", "the cam zoom viewer (opened by a tap)"],
    ["lib/changelog.ts", "the full changelog (fetched on 'Show all')"],
  ] as const;

  for (const [file, why] of LAZY_FILES) {
    it(`does not statically import ${file} (${why})`, () => {
      expect(files.has(file), `${file} is statically reachable from the first-load bundle`).toBe(false);
    });
  }

  it("does not statically import the analytics or billing SDKs", () => {
    expect(packages.has("posthog-js")).toBe(false);
    expect(packages.has("@revenuecat/purchases-capacitor")).toBe(false);
  });
});
