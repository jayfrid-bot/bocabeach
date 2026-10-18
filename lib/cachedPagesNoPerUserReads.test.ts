// The edge cache (lib/edgeCache.ts) serves one stored copy of a beach page to everyone who
// asks for the same path and web/native variant. That is safe only while nothing that
// renders those pages reads another request input. This test walks the static import graph
// of everything that renders them (the root layout, the home page and app/[slug]/*, and
// every module they import, server and client) and fails on any such read:
//   - next/headers (headers(), cookies(), draftMode()) anywhere in the server graph, except
//     lib/nativeRequest.ts, which may read the User-Agent only (the key's web/native variant);
//   - `connection()` from next/server (an opt-in to per-request rendering);
//   - `searchParams` in a page, layout or app/[slug] module (the page prop);
//   - `useSearchParams` anywhere (a client component reads the query during server render too).
// RULE: a new per-request read must be added to the edge-cache key or to its bypass rules in
// the same change (lib/edgeCache.ts), and this test updated with the reason.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const ALLOWED_HEADERS_READER = "lib/nativeRequest.ts";

function resolveLocal(spec: string, from: string): string | null {
  const base = spec.startsWith("@/") ? spec.slice(2) : normalize(join(dirname(from), spec));
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (existsSync(join(ROOT, c)) && /\.(ts|tsx)$/.test(c)) return c;
  }
  return null;
}

const ENTRIES = [
  "app/layout.tsx",
  "app/page.tsx",
  ...readdirSync(join(ROOT, "app/[slug]"))
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f))
    .map((f) => `app/[slug]/${f}`),
];

function graph(): { server: Set<string>; client: Set<string>; packagesByFile: Map<string, string[]> } {
  const server = new Set<string>();
  const client = new Set<string>();
  const packagesByFile = new Map<string, string[]>();
  const stack: { f: string; inClient: boolean }[] = ENTRIES.map((f) => ({ f, inClient: false }));
  const re = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/g;
  while (stack.length) {
    const { f, inClient: parentClient } = stack.pop()!;
    const src = readFileSync(join(ROOT, f), "utf8");
    const isClient = parentClient || /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(src);
    const seen = isClient ? client : server;
    if (seen.has(f)) continue;
    seen.add(f);
    const pkgs: string[] = [];
    for (const m of src.matchAll(re)) {
      const spec = m[1];
      if (spec.startsWith("@/") || spec.startsWith(".")) {
        const t = resolveLocal(spec, f);
        if (t) stack.push({ f: t, inClient: isClient });
      } else pkgs.push(spec);
    }
    packagesByFile.set(f, pkgs);
  }
  return { server, client, packagesByFile };
}

describe("the edge-cached pages read no per-user request input", () => {
  const { server, client, packagesByFile } = graph();

  it("the walk reaches the real page code (layouts, the dashboard, the conditions pipeline)", () => {
    expect(server.has("app/layout.tsx")).toBe(true);
    expect(server.has("app/[slug]/page.tsx")).toBe(true);
    expect(server.has("lib/conditions.ts")).toBe(true);
    expect(server.has(ALLOWED_HEADERS_READER)).toBe(true);
    expect(client.has("components/ConditionsDashboard.tsx")).toBe(true);
    expect(server.size + client.size).toBeGreaterThan(80);
  });

  it("no next/headers (headers, cookies, draftMode) except the User-Agent reader", () => {
    const bad = [...server, ...client].filter(
      (f) => f !== ALLOWED_HEADERS_READER && (packagesByFile.get(f) ?? []).includes("next/headers"),
    );
    expect(bad).toEqual([]);
    for (const f of [...server, ...client]) {
      if (f === ALLOWED_HEADERS_READER) continue;
      const src = readFileSync(join(ROOT, f), "utf8");
      expect(src, f).not.toMatch(/\bcookies\s*\(\s*\)|\bdraftMode\s*\(\s*\)|\bheaders\s*\(\s*\)/);
    }
  });

  it("lib/nativeRequest.ts reads the User-Agent and nothing else", () => {
    const src = readFileSync(join(ROOT, ALLOWED_HEADERS_READER), "utf8");
    const reads = [...src.matchAll(/\(await headers\(\)\)\.get\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(reads).toEqual(["user-agent"]);
    expect(src).not.toMatch(/cookies|draftMode|\.entries\(\)|\.forEach\(/);
  });

  it("no connection() opt-in and no useSearchParams in anything the pages render", () => {
    for (const f of [...server, ...client]) {
      const src = readFileSync(join(ROOT, f), "utf8");
      expect(src, f).not.toMatch(/\buseSearchParams\b/);
      expect(src, f).not.toMatch(/import\s*\{[^}]*\bconnection\b[^}]*\}\s*from\s*["']next\/server["']/);
    }
  });

  it("no searchParams page prop in a layout, the home page or app/[slug]", () => {
    for (const f of ENTRIES) {
      expect(readFileSync(join(ROOT, f), "utf8"), f).not.toMatch(/searchParams/);
    }
  });
});
