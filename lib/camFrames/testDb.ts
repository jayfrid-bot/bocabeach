// Test helper: a real SQLite database (Node's built-in node:sqlite) that has
// migrations/0016_cam_frames.sql and 0017_cam_frames_golden.sql applied, wrapped in the D1Like surface the
// webcam archive code uses. The actual SQL runs, not a JS model of it. Only
// *.test.ts files import this. `makeCamDb()` returns null on a Node build
// without node:sqlite; the tests then skip.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { D1Like, D1RunResult, D1Stmt } from "@/lib/db/d1Store";

interface SqliteStmt {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStmt;
  close(): void;
}

let Ctor: (new (path: string) => SqliteDb) | null = null;
try {
  // process.getBuiltinModule, not `import`: Vite does not resolve node:sqlite.
  const sqlite = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule?.(
    "node:sqlite",
  ) as { DatabaseSync: new (path: string) => SqliteDb } | undefined;
  Ctor = sqlite?.DatabaseSync ?? null;
} catch {
  Ctor = null;
}

export const HAS_SQLITE = Ctor !== null;

export interface CamDb {
  db: D1Like;
  /** Run a query straight on SQLite (test assertions). */
  all(sql: string, ...params: unknown[]): Record<string, unknown>[];
  /** Run raw SQL (a migration applied by hand, in a migration test). */
  exec(sql: string): void;
  close(): void;
}

/**
 * `allMigrations: true` applies every migration in order (the day route reads
 * beach_hourly as well as cam_frames); `files` applies exactly those migrations (a
 * migration test); the default applies only the two cam_frames migrations.
 */
export function makeCamDb(opts?: { allMigrations?: boolean; files?: string[] }): CamDb | null {
  if (!Ctor) return null;
  const raw = new Ctor(":memory:");
  const dir = path.join(process.cwd(), "migrations");
  const files = opts?.files
    ? opts.files
    : opts?.allMigrations
    ? readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()
    : ["0016_cam_frames.sql", "0017_cam_frames_golden.sql"];
  for (const f of files) raw.exec(readFileSync(path.join(dir, f), "utf8"));
  const db: D1Like = {
    // Like real D1's batch(): all statements or none. A statement that throws rolls the
    // whole batch back. There is no await between BEGIN and COMMIT, so two concurrent
    // batches can never interleave.
    async batch(stmts: D1Stmt[]): Promise<D1RunResult[]> {
      raw.exec("BEGIN");
      try {
        const out = stmts.map((s) => (s as unknown as { _runSync(): D1RunResult })._runSync());
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
    prepare(sql: string): D1Stmt {
      const stmt = raw.prepare(sql);
      let bound: unknown[] = [];
      const self: D1Stmt & { _runSync(): D1RunResult } = {
        bind(...values: unknown[]) {
          bound = values;
          return self;
        },
        async first<T>() {
          const row = stmt.get(...bound);
          return (row === undefined ? null : row) as T | null;
        },
        async run(): Promise<D1RunResult> {
          const r = stmt.run(...bound);
          return { success: true, meta: { changes: Number(r.changes) } };
        },
        // Used by `batch` below: run now, with no await in between, so a batch is one
        // uninterrupted step in this single-threaded test process.
        _runSync(): D1RunResult {
          const r = stmt.run(...bound);
          return { success: true, meta: { changes: Number(r.changes) } };
        },
        async all<T>() {
          return { results: stmt.all(...bound) as T[] };
        },
      };
      return self;
    },
  };
  return {
    db,
    all: (sql, ...params) => raw.prepare(sql).all(...params),
    exec: (sql) => raw.exec(sql),
    close: () => raw.close(),
  };
}
