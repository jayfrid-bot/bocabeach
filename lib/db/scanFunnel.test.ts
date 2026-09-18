// The sticker funnel's SQL, run against a real SQLite database (`node:sqlite`)
// loaded from the actual migrations — so a broken WHERE clause fails here
// instead of quietly crediting every install to a sticker.
//
// The guards being checked are the ones that decide whether a number in the
// growth report is worth anything: a credited install must be NATIVE, MINUTES
// old, and sitting on a network that scanned inside the window, and one scan
// can be spent only once.
//
// `node:sqlite` is experimental and not in every Node version this repo might
// run under, so it is loaded through a non-literal dynamic import (same as
// d1Store.test.ts) and the suite degrades to a skip, not a failure.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { D1Like, D1Stmt } from "@/lib/db/d1Store";
import {
  FRESH_INSTALL_MS,
  MATCH_WINDOW_MS,
  attributeInstall,
  cleanSource,
  clientIp,
  fingerprint,
  noteScan,
  readFunnel,
  recordTap,
} from "@/lib/db/scanFunnel";

const NODE_SQLITE = "node:sqlite";

interface SqliteStatement {
  run(...args: unknown[]): { changes: number | bigint };
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

async function loadSqlite(): Promise<{ DatabaseSync: new (p: string) => SqliteDatabase } | null> {
  try {
    return (await import(NODE_SQLITE)) as { DatabaseSync: new (p: string) => SqliteDatabase };
  } catch {
    return null;
  }
}

/** Wrap a real SQLite database as the minimal `D1Like` this module needs. */
function asD1(db: SqliteDatabase): D1Like {
  return {
    prepare(sql: string): D1Stmt {
      const stmt = db.prepare(sql);
      let bound: unknown[] = [];
      const self: D1Stmt = {
        bind(...values: unknown[]) {
          bound = values;
          return self;
        },
        async first<T>() {
          return (stmt.get(...bound) as T) ?? null;
        },
        async run() {
          const r = stmt.run(...bound);
          return { meta: { changes: Number(r.changes) } };
        },
        async all<T>() {
          return { results: stmt.all(...bound) as T[] };
        },
      };
      return self;
    },
  };
}

const NOW = 1_770_000_000_000;
const FP = "a1b2c3d4e5f60718";

let sqlite: { DatabaseSync: new (p: string) => SqliteDatabase } | null = null;
let raw: SqliteDatabase | null = null;
let db: D1Like | null = null;

/** The real schema, every migration in order — the same thing D1 has run. */
function migrations(): string[] {
  const dir = path.join(process.cwd(), "migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(path.join(dir, f), "utf8"));
}

/** A device row as the upsert would have left it just before attribution. */
function seedDevice(id: string, platform: string, createdAt: number): void {
  raw!
    .prepare(
      `INSERT INTO devices (id, platform, plan, trial_used, preview_seen, created_at, updated_at)
       VALUES (?, ?, 'free', 0, 0, ?, ?)`,
    )
    .run(id, platform, createdAt, createdAt);
}

beforeAll(async () => {
  sqlite = await loadSqlite();
});

beforeEach(() => {
  if (!sqlite) return;
  raw = new sqlite.DatabaseSync(":memory:");
  for (const sql of migrations()) raw.exec(sql);
  db = asD1(raw);
});

describe("scanFunnel — pure bits", () => {
  it("fingerprints an address to a short, stable, non-obvious token", async () => {
    const a = await fingerprint("203.0.113.7");
    const b = await fingerprint("203.0.113.7");
    const c = await fingerprint("203.0.113.8");
    expect(a).toHaveLength(16);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toContain("203");
  });

  it("has nothing to match on when there is no address", async () => {
    expect(await fingerprint(null)).toBeNull();
  });

  it("a different salt gives a different token (rotating the salt breaks old matches)", async () => {
    expect(await fingerprint("203.0.113.7", "salt-a")).not.toBe(
      await fingerprint("203.0.113.7", "salt-b"),
    );
  });

  it("keeps only a short, known-shaped tag from a URL or cookie", () => {
    expect(cleanSource("tower-3")).toBe("tower-3");
    expect(cleanSource("<script>alert(1)</script>")).toBe("scriptalert1script");
    expect(cleanSource("!!!")).toBe("sticker");
    expect(cleanSource(null, "web")).toBe("web");
    expect(cleanSource("x".repeat(80)).length).toBe(24);
  });

  it("reads the client address from Cloudflare first, then the forwarded chain", () => {
    expect(clientIp(new Request("https://x.test", { headers: { "cf-connecting-ip": "1.1.1.1" } })))
      .toBe("1.1.1.1");
    expect(
      clientIp(new Request("https://x.test", { headers: { "x-forwarded-for": "2.2.2.2, 3.3.3.3" } })),
    ).toBe("2.2.2.2");
    expect(clientIp(new Request("https://x.test"))).toBeNull();
  });
});

describe("scanFunnel — crediting an install to a scan", () => {
  it("credits a fresh native install that tapped through, as the strong signal", async () => {
    if (!sqlite) return;
    await noteScan(db, FP, "sticker", NOW);
    await recordTap(db, FP, "sticker", NOW + 1000);
    seedDevice("dev-1", "ios", NOW + 60_000);
    expect(await attributeInstall(db, "dev-1", FP, NOW + 60_000)).toEqual({
      source: "sticker",
      kind: "tap",
    });
  });

  it("credits a scan with no tap, but marks it the weaker signal", async () => {
    if (!sqlite) return;
    await noteScan(db, FP, "sticker", NOW);
    seedDevice("dev-2", "ios", NOW + 60_000);
    expect(await attributeInstall(db, "dev-2", FP, NOW + 60_000)).toEqual({
      source: "sticker",
      kind: "scan",
    });
  });

  it("never credits a web visitor — that is the scan itself, not a download", async () => {
    if (!sqlite) return;
    await noteScan(db, FP, "sticker", NOW);
    seedDevice("dev-web", "web", NOW + 1000);
    expect(await attributeInstall(db, "dev-web", FP, NOW + 1000)).toBeNull();
  });

  it("never credits a phone that already had the app", async () => {
    if (!sqlite) return;
    await noteScan(db, FP, "sticker", NOW);
    seedDevice("dev-old", "ios", NOW - FRESH_INSTALL_MS - 1000);
    expect(await attributeInstall(db, "dev-old", FP, NOW)).toBeNull();
  });

  it("lets a scan go cold: past the window, an install is nobody's credit", async () => {
    if (!sqlite) return;
    await noteScan(db, FP, "sticker", NOW);
    const later = NOW + MATCH_WINDOW_MS + 1000;
    seedDevice("dev-late", "ios", later);
    expect(await attributeInstall(db, "dev-late", FP, later)).toBeNull();
  });

  it("spends a scan once — a second phone on the same network is not a second scan", async () => {
    if (!sqlite) return;
    await noteScan(db, FP, "sticker", NOW);
    seedDevice("dev-a", "ios", NOW + 60_000);
    seedDevice("dev-b", "ios", NOW + 120_000);
    expect(await attributeInstall(db, "dev-a", FP, NOW + 60_000)).not.toBeNull();
    expect(await attributeInstall(db, "dev-b", FP, NOW + 120_000)).toBeNull();
  });

  it("counts a device once however many times it posts", async () => {
    if (!sqlite) return;
    await noteScan(db, FP, "sticker", NOW);
    seedDevice("dev-1", "ios", NOW + 60_000);
    await attributeInstall(db, "dev-1", FP, NOW + 60_000);
    await attributeInstall(db, "dev-1", FP, NOW + 90_000);
    const { installs } = await readFunnel(db);
    expect(installs).toEqual([{ source: "sticker", kind: "tap", total: 1 }]);
  });

  it("has nothing to say about an install from a network that never scanned", async () => {
    if (!sqlite) return;
    seedDevice("dev-cold", "ios", NOW);
    expect(await attributeInstall(db, "dev-cold", FP, NOW)).toBeNull();
  });

  it("a rescan weeks later opens a fresh window", async () => {
    if (!sqlite) return;
    await noteScan(db, FP, "sticker", NOW);
    seedDevice("dev-a", "ios", NOW + 60_000);
    await attributeInstall(db, "dev-a", FP, NOW + 60_000);

    const weeksLater = NOW + 21 * 24 * 60 * 60 * 1000;
    await noteScan(db, FP, "sticker", weeksLater);
    seedDevice("dev-c", "ios", weeksLater + 60_000);
    expect(await attributeInstall(db, "dev-c", FP, weeksLater + 60_000)).not.toBeNull();
  });
});

describe("scanFunnel — the readout the report prints", () => {
  it("counts taps per source per day, and keeps web apart from sticker", async () => {
    if (!sqlite) return;
    await recordTap(db, FP, "sticker", NOW);
    await recordTap(db, FP, "sticker", NOW + 1000);
    await recordTap(db, "ffffffffffffffff", "web", NOW + 2000);
    const { taps } = await readFunnel(db);
    expect(taps).toEqual([
      { source: "sticker", total: 2 },
      { source: "web", total: 1 },
    ]);
  });

  it("still counts the tap when there is no address to fingerprint", async () => {
    if (!sqlite) return;
    await recordTap(db, null, "sticker", NOW);
    const { taps } = await readFunnel(db);
    expect(taps).toEqual([{ source: "sticker", total: 1 }]);
  });

  it("reads as empty, never throws, with no database at all", async () => {
    expect(await readFunnel(null)).toEqual({ taps: [], installs: [] });
    expect(await attributeInstall(null, "dev-1", FP, NOW)).toBeNull();
    await expect(noteScan(null, FP, "sticker", NOW)).resolves.toBeUndefined();
    await expect(recordTap(null, FP, "sticker", NOW)).resolves.toBeUndefined();
  });
});
