import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHUNK_RELOAD_GAP_MS,
  CHUNK_RELOAD_KEY,
  failedChunkPath,
  isChunkLoadError,
  reloadIfChunkGone,
  serverSaysGone,
  shouldReloadForChunkError,
  type ChunkReloadDeps,
} from "@/lib/chunkReload";
import { _resetReloadGuardForTests, holdReload } from "@/lib/reloadGuard";

const ORIGIN = "https://isitbeachday.com";
const NOW = Date.parse("2026-10-18T12:00:00Z");
const CHUNK = "/_next/static/chunks/1004.d2101b7440d2ffcf.js";
/** What webpack throws: name, request and the URL in the message. */
const webpackErr = (type = "missing") =>
  Object.assign(new Error(`Loading chunk 1004 failed.\n(${type}: ${ORIGIN}${CHUNK})`), {
    name: "ChunkLoadError",
    type,
    request: `${ORIGIN}${CHUNK}`,
  });

describe("isChunkLoadError", () => {
  it("knows the failed-file errors of webpack and each browser", () => {
    expect(isChunkLoadError(webpackErr())).toBe(true);
    expect(isChunkLoadError(new Error("Loading CSS chunk 77 failed."))).toBe(true);
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: https://x/a.js"))).toBe(true); // Chrome
    expect(isChunkLoadError(new TypeError("error loading dynamically imported module"))).toBe(true); // Firefox
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true); // Safari
    expect(isChunkLoadError("Loading chunk 5 failed.")).toBe(true);
  });
  it("leaves every other error alone (a failed data fetch is not a build file)", () => {
    for (const e of [new TypeError("Failed to fetch"), new Error("500"), new Error("Load failed"), null, undefined, 42, {}]) {
      expect(isChunkLoadError(e)).toBe(false);
    }
  });
});

describe("failedChunkPath", () => {
  it("finds the same-origin build file in each error shape", () => {
    expect(failedChunkPath(webpackErr(), ORIGIN)).toBe(CHUNK);
    expect(failedChunkPath(new Error(`Loading chunk 1004 failed.\n(timeout: ${ORIGIN}${CHUNK})`), ORIGIN)).toBe(CHUNK);
    expect(failedChunkPath(new TypeError(`Failed to fetch dynamically imported module: ${ORIGIN}${CHUNK}`), ORIGIN)).toBe(CHUNK);
    expect(failedChunkPath(new Error("Loading CSS chunk 77 failed.\n(/_next/static/css/a.css)"), ORIGIN)).toBe("/_next/static/css/a.css");
  });
  it("never names another host or another path, and null when there is none", () => {
    expect(failedChunkPath(Object.assign(new Error("x"), { request: "https://evil.test/_next/static/chunks/a.js" }), ORIGIN)).toBeNull();
    expect(failedChunkPath(Object.assign(new Error("x"), { request: `${ORIGIN}/api/version` }), ORIGIN)).toBeNull();
    expect(failedChunkPath(new TypeError("Importing a module script failed."), ORIGIN)).toBeNull();
  });
});

describe("shouldReloadForChunkError", () => {
  const base = { error: webpackErr(), now: NOW, lastReloadAt: null, held: false, storageOk: true, online: true };
  it("may reload for a chunk error, online", () => {
    expect(shouldReloadForChunkError(base)).toBe(true);
  });
  it("never offline, never inside the gap, never during a purchase, never without storage", () => {
    expect(shouldReloadForChunkError({ ...base, online: false })).toBe(false);
    expect(shouldReloadForChunkError({ ...base, lastReloadAt: NOW - 1000 })).toBe(false);
    expect(shouldReloadForChunkError({ ...base, lastReloadAt: NOW - CHUNK_RELOAD_GAP_MS + 1 })).toBe(false);
    expect(shouldReloadForChunkError({ ...base, lastReloadAt: NOW - CHUNK_RELOAD_GAP_MS })).toBe(true);
    expect(shouldReloadForChunkError({ ...base, held: true })).toBe(false);
    expect(shouldReloadForChunkError({ ...base, storageOk: false })).toBe(false);
    expect(shouldReloadForChunkError({ ...base, error: new Error("boom") })).toBe(false);
  });
});

describe("serverSaysGone (the probe)", () => {
  it("true only for a 404 or 410 from the server", async () => {
    for (const [status, gone] of [[404, true], [410, true], [200, false], [500, false], [503, false]] as const) {
      expect(await serverSaysGone(CHUNK, async () => ({ status })), String(status)).toBe(gone);
    }
  });
  it("false on a network failure and on a probe that does not answer in time", async () => {
    expect(await serverSaysGone(CHUNK, async () => Promise.reject(new TypeError("Failed to fetch")))).toBe(false);
    expect(await serverSaysGone(CHUNK, () => new Promise(() => {}), 30)).toBe(false);
  });
  it("asks HEAD, with no cache, for the failed file", async () => {
    const f = vi.fn(async () => ({ status: 404 }));
    await serverSaysGone(CHUNK, f);
    expect(f).toHaveBeenCalledWith(CHUNK, expect.objectContaining({ method: "HEAD", cache: "no-store" }));
  });
});

describe("reloadIfChunkGone", () => {
  let store: Map<string, string>;
  let reload: ReturnType<typeof vi.fn>;
  const deps = (over: Partial<ChunkReloadDeps> = {}): ChunkReloadDeps => ({
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) },
    online: true,
    origin: ORIGIN,
    fetch: async () => ({ status: 404 }),
    reload,
    now: Date.now(),
    held: false,
    ...over,
  });
  beforeEach(() => {
    store = new Map();
    reload = vi.fn();
    _resetReloadGuardForTests();
  });

  it("file gone and the server up (404): reloads once, and a second failure is not reloaded", async () => {
    expect(await reloadIfChunkGone(webpackErr(), deps())).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(store.get(CHUNK_RELOAD_KEY)).toBeTruthy();
    expect(await reloadIfChunkGone(webpackErr(), deps())).toBe(false); // the guard: no loop
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("offline: no reload, no probe", async () => {
    const f = vi.fn(async () => ({ status: 404 }));
    expect(await reloadIfChunkGone(webpackErr(), deps({ online: false, fetch: f }))).toBe(false);
    expect(f).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("a timeout or a network failure (the probe fails): no reload", async () => {
    const fail = async () => Promise.reject(new TypeError("Failed to fetch"));
    expect(await reloadIfChunkGone(webpackErr("timeout"), deps({ fetch: fail }))).toBe(false);
    expect(await reloadIfChunkGone(webpackErr("error"), deps({ fetch: fail }))).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(store.has(CHUNK_RELOAD_KEY)).toBe(false); // the guard is not spent either
  });

  it("the file is still there (the probe gets 200): it was the network, no reload", async () => {
    expect(await reloadIfChunkGone(webpackErr("timeout"), deps({ fetch: async () => ({ status: 200 }) }))).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("no file named in the error, a purchase in progress, or another error: no reload", async () => {
    expect(await reloadIfChunkGone(new TypeError("Importing a module script failed."), deps())).toBe(false);
    expect(await reloadIfChunkGone(webpackErr(), deps({ held: true }))).toBe(false);
    const release = holdReload(); // a purchase starts while the probe runs
    expect(await reloadIfChunkGone(webpackErr(), deps())).toBe(false);
    release();
    expect(await reloadIfChunkGone(new Error("render bug"), deps())).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

// Every lazy import a page makes either reloads for a gone file (chunkFailed, on a piece
// the person opened) or keeps an explicit soft fallback, marked `// soft-fallback:` on the
// line above it, or is a silent warm-up (`.catch(() => {})`, or the nerd-back warm loader).
describe("every lazy import in the page code handles a failed load on purpose", () => {
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

  it("uses chunkFailed, a marked soft fallback, or is a silent warm-up", () => {
    const bad: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), "utf8");
      for (const m of src.matchAll(/import\(\s*["'][^"']+["']\s*\)/g)) {
        const after = src.slice(m.index!, m.index! + 200).split(";")[0];
        const lineStart = src.lastIndexOf("\n", m.index!) + 1;
        const line = src.slice(lineStart, src.indexOf("\n", m.index!));
        const prevLine = src.slice(src.lastIndexOf("\n", lineStart - 2) + 1, lineStart - 1);
        if (/chunkFailed/.test(after)) continue;
        if (/\.catch\(\(\) => \{\}\)/.test(after)) continue; // silent warm-up
        if (/\/\/ soft-fallback:/.test(prevLine) || /\/\/ soft-fallback:/.test(line)) continue;
        if (WARM_UPS.has(f)) continue;
        if (/const loadPlusSheets = /.test(line) && WARM_UPS.has(`${f}:loadPlusSheets`)) continue;
        if (/typeof import/.test(line)) continue;
        bad.push(`${f}: ${line.trim()}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the background loads keep their soft fallbacks (no reload behind the person's back)", () => {
    for (const f of ["components/PostHogInit.tsx", "lib/plus/billing.ts", "lib/push/native.ts"]) {
      const src = readFileSync(join(ROOT, f), "utf8");
      expect(src, f).not.toMatch(/chunkFailed/);
      expect(src, f).toMatch(/\/\/ soft-fallback:/);
    }
  });

  it("the layout mounts the global handler, and both error boundaries use the probing reload", () => {
    expect(readFileSync(join(ROOT, "app/layout.tsx"), "utf8")).toMatch(/<ChunkErrorReload \/>/);
    for (const f of ["app/error.tsx", "app/global-error.tsx", "components/ChunkErrorReload.tsx"]) {
      expect(readFileSync(join(ROOT, f), "utf8"), f).toMatch(/reloadIfChunkGone\(/);
    }
  });
});
