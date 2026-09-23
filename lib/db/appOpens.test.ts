// Daily active users, run against a real SQLite database loaded from the
// actual migrations (the same pattern as scanFunnel.test.ts), so a broken
// primary key or conflict clause fails here instead of double-counting people.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { D1Like, D1Stmt } from "@/lib/db/d1Store";
import { hashOpenId, isOpenPlatform, recordOpen } from "@/lib/db/appOpens";
import { shouldPing } from "@/lib/useAppOpenPing";

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

function migrations(): string[] {
  const dir = path.join(process.cwd(), "migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(path.join(dir, f), "utf8"));
}

// 2026-09-23 14:00 EDT
const NOON = Date.parse("2026-09-23T18:00:00Z");
const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";

let sqlite: { DatabaseSync: new (p: string) => SqliteDatabase } | null = null;
let raw: SqliteDatabase | null = null;
let db: D1Like | null = null;

beforeAll(async () => {
  sqlite = await loadSqlite();
});

beforeEach(() => {
  if (!sqlite) return;
  raw = new sqlite.DatabaseSync(":memory:");
  for (const sql of migrations()) raw.exec(sql);
  db = asD1(raw);
});

const rows = () => raw!.prepare("SELECT day, id_hash, platform FROM app_opens ORDER BY day, platform").all() as {
  day: string;
  id_hash: string;
  platform: string;
}[];

describe("appOpens — pure bits", () => {
  it("hashes a device id to a short, stable, one-way token", async () => {
    const a = await hashOpenId(ID_A);
    expect(a).toHaveLength(16);
    expect(a).toBe(await hashOpenId(ID_A));
    expect(a).not.toBe(await hashOpenId(ID_B));
    expect(ID_A).not.toContain(a);
  });

  it("accepts only the three platforms", () => {
    expect(isOpenPlatform("ios")).toBe(true);
    expect(isOpenPlatform("web")).toBe(true);
    expect(isOpenPlatform("android")).toBe(true);
    expect(isOpenPlatform("windows")).toBe(false);
    expect(isOpenPlatform(undefined)).toBe(false);
  });

  it("pings once per day and never from an automated browser", () => {
    expect(shouldPing(null, "2026-09-23", false)).toBe(true);
    expect(shouldPing("2026-09-22", "2026-09-23", false)).toBe(true);
    expect(shouldPing("2026-09-23", "2026-09-23", false)).toBe(false);
    expect(shouldPing(null, "2026-09-23", true)).toBe(false);
  });

  it("does nothing without a database", async () => {
    expect(await recordOpen(null, ID_A, "ios", NOON)).toBe(false);
  });
});

describe("appOpens — SQL", () => {
  it("counts a device once per day, however often it opens", async () => {
    if (!db) return;
    expect(await recordOpen(db, ID_A, "ios", NOON)).toBe(true);
    expect(await recordOpen(db, ID_A, "ios", NOON + 60_000)).toBe(false);
    expect(await recordOpen(db, ID_B, "web", NOON)).toBe(true);
    const r = rows();
    expect(r).toHaveLength(2);
    expect(r.map((x) => x.platform)).toEqual(["ios", "web"]);
    expect(r[0].id_hash).toBe(await hashOpenId(ID_A)); // never the raw id
  });

  it("starts a new count on the next Eastern calendar day", async () => {
    if (!db) return;
    await recordOpen(db, ID_A, "ios", NOON);
    // 11:30 PM EDT is still the 23rd; 12:30 AM EDT is the 24th.
    await recordOpen(db, ID_A, "ios", Date.parse("2026-09-24T03:30:00Z"));
    await recordOpen(db, ID_A, "ios", Date.parse("2026-09-24T04:30:00Z"));
    expect(rows().map((x) => x.day)).toEqual(["2026-09-23", "2026-09-24"]);
  });
});
