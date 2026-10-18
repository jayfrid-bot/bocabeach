import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHUNK_RELOAD_GAP_MS,
  CHUNK_RELOAD_KEY,
  chunkFailed,
  isChunkLoadError,
  reloadOnceForChunkError,
  shouldReloadForChunkError,
} from "@/lib/chunkReload";
import { _resetReloadGuardForTests, holdReload } from "@/lib/reloadGuard";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const webpackErr = Object.assign(new Error("Loading chunk 1004 failed.\n(error: https://x/_next/static/chunks/1004.js)"), { name: "ChunkLoadError" });

describe("isChunkLoadError", () => {
  it("knows the missing-file errors of webpack and each browser", () => {
    expect(isChunkLoadError(webpackErr)).toBe(true);
    expect(isChunkLoadError(new Error("Loading CSS chunk 77 failed."))).toBe(true);
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: https://x/a.js"))).toBe(true); // Chrome
    expect(isChunkLoadError(new TypeError("error loading dynamically imported module"))).toBe(true); // Firefox
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true); // Safari
    expect(isChunkLoadError("Loading chunk 5 failed.")).toBe(true);
  });
  it("leaves every other error alone (a failed data fetch is not a missing build file)", () => {
    for (const e of [new TypeError("Failed to fetch"), new Error("500"), new Error("Load failed"), null, undefined, 42, {}]) {
      expect(isChunkLoadError(e)).toBe(false);
    }
  });
});

describe("shouldReloadForChunkError", () => {
  const base = { error: webpackErr, now: NOW, lastReloadAt: null, held: false, storageOk: true };
  it("reloads once for a chunk error", () => {
    expect(shouldReloadForChunkError(base)).toBe(true);
  });
  it("never loops: not again inside the gap", () => {
    expect(shouldReloadForChunkError({ ...base, lastReloadAt: NOW - 1000 })).toBe(false);
    expect(shouldReloadForChunkError({ ...base, lastReloadAt: NOW - CHUNK_RELOAD_GAP_MS + 1 })).toBe(false);
    expect(shouldReloadForChunkError({ ...base, lastReloadAt: NOW - CHUNK_RELOAD_GAP_MS })).toBe(true);
  });
  it("not during a purchase (reload held), not without storage, not for other errors", () => {
    expect(shouldReloadForChunkError({ ...base, held: true })).toBe(false);
    expect(shouldReloadForChunkError({ ...base, storageOk: false })).toBe(false);
    expect(shouldReloadForChunkError({ ...base, error: new Error("boom") })).toBe(false);
  });
});

describe("reloadOnceForChunkError and chunkFailed in a page", () => {
  let store: Map<string, string>;
  let reload: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    store = new Map();
    reload = vi.fn();
    _resetReloadGuardForTests();
    (globalThis as { window?: unknown }).window = {
      sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
      location: { reload },
    };
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("reloads once, then the second failure surfaces as an error (no loop)", async () => {
    expect(reloadOnceForChunkError(webpackErr)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(store.get(CHUNK_RELOAD_KEY)).toBeTruthy();
    // after the reload the same tab fails again: shown, not reloaded
    await expect(chunkFailed(webpackErr)).rejects.toBe(webpackErr);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("a chunk error leaves the import pending while the page reloads; other errors reject", async () => {
    const pending = chunkFailed(webpackErr);
    const raced = await Promise.race([pending.then(() => "settled", () => "settled"), new Promise((r) => setTimeout(() => r("pending"), 20))]);
    expect(raced).toBe("pending");
    const other = new Error("render bug");
    await expect(chunkFailed(other)).rejects.toBe(other);
  });

  it("no reload while a purchase holds one", async () => {
    const release = holdReload();
    await expect(chunkFailed(webpackErr)).rejects.toBe(webpackErr);
    expect(reload).not.toHaveBeenCalled();
    release();
  });
});

// Every lazy import a page makes must handle a missing file. Silent warm-ups (a
// `.catch(() => {})` or the nerd-back warm loader) are allowed: the real load beside each
// of them carries chunkFailed.
describe("every lazy import in the page code handles a missing build file", () => {
  const ROOT = join(__dirname, "..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const rel = join(dir, name);
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(rel);
    }
  };
  walk("components");
  files.push("lib/plus/billing.ts", "lib/push/native.ts", "app/layout.tsx");
  const WARM_UPS = new Set(["components/nerdBackLoader.ts", "components/ConditionsDashboard.tsx:loadPlusSheets"]);

  it("uses chunkFailed (or is a silent warm-up)", () => {
    const bad: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), "utf8");
      for (const m of src.matchAll(/import\(\s*["'][^"']+["']\s*\)/g)) {
        const after = src.slice(m.index!, m.index! + 200);
        const before = src.slice(Math.max(0, m.index! - 60), m.index!);
        const lineStart = src.lastIndexOf("\n", m.index!) + 1;
        const line = src.slice(lineStart, src.indexOf("\n", m.index!));
        if (/chunkFailed/.test(after.split(";")[0])) continue;
        if (/\.catch\(\(\) => \{\}\)/.test(after.split(";")[0])) continue; // silent warm-up
        if (WARM_UPS.has(f)) continue;
        if (/const loadPlusSheets = /.test(line) && WARM_UPS.has(`${f}:loadPlusSheets`)) continue;
        if (/typeof import|vi\.importActual/.test(before + line)) continue;
        bad.push(`${f}: ${line.trim()}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the layout mounts the global handler, and both error boundaries reload for a chunk error", () => {
    expect(readFileSync(join(ROOT, "app/layout.tsx"), "utf8")).toMatch(/<ChunkErrorReload \/>/);
    for (const f of ["app/error.tsx", "app/global-error.tsx"]) {
      expect(readFileSync(join(ROOT, f), "utf8"), f).toMatch(/isChunkLoadError\(error\) && reloadOnceForChunkError\(error\)/);
    }
  });
});
