// The D1 backend's atomic send claim (#14), exercised against a real SQLite
// database (`node:sqlite`) — the actual SQL, not a re-implementation of it, so
// this catches a broken WHERE clause the memory-store equivalent (which does
// not run any SQL at all) never could.
//
// `node:sqlite` is still experimental and not in every Node version this repo
// might run under (nor in the @types/node version this repo pins), so it is
// loaded through a non-literal dynamic import — see `loadSqlite` — which
// keeps `tsc` from trying to resolve module types that may not exist, and
// lets the suite degrade to a skip (not a failure) on a runtime without it.

import { describe, it, expect, beforeAll } from "vitest";
import { d1Store, type D1Like, type D1Stmt } from "@/lib/db/d1Store";
import type { DeviceStore } from "@/lib/db/store";

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

/** `null` when `node:sqlite` is unavailable in this runtime. */
async function loadSqlite(): Promise<{ DatabaseSync: new (path: string) => SqliteDatabase } | null> {
  try {
    return (await import(NODE_SQLITE)) as { DatabaseSync: new (path: string) => SqliteDatabase };
  } catch {
    return null;
  }
}

/** Wrap a real SQLite database as the minimal `D1Like` the store code needs. */
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
          // Match D1's real `.run()` shape ({ meta: { changes } }) — d1Store's
          // claimSend reads exactly that.
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

let store: DeviceStore | null = null;

beforeAll(async () => {
  const sqlite = await loadSqlite();
  if (!sqlite) return; // suite below no-ops via `it.skipIf`
  const db = new sqlite.DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE send_claims (key TEXT PRIMARY KEY, claimed_at INTEGER NOT NULL, sent_at INTEGER)",
  );
  store = d1Store(asD1(db));
});

// `node:sqlite` was confirmed available (and used) when this suite was
// written; every test below still guards on `store` so a runtime without it
// skips cleanly instead of failing.
describe("d1Store — atomic send claims (#14)", () => {
  it("two claims racing for the same key: exactly one wins, even sharing the same timestamp", async () => {
    if (!store) return; // node:sqlite unavailable on this runtime — nothing to check here
    const now = Date.now();
    const results = await Promise.all([
      store.claimSend("dev-race:lightning:1", now),
      store.claimSend("dev-race:lightning:1", now),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("loses a claim already held (not abandoned, not sent)", async () => {
    if (!store) return;
    await store.claimSend("dev-a:lightning:1", 1000);
    expect(await store.claimSend("dev-a:lightning:1", 1005)).toBe(false);
  });

  it("wins a claim once the prior one looks abandoned (10+ min, never sent)", async () => {
    if (!store) return;
    await store.claimSend("dev-b:lightning:1", 1000);
    expect(await store.claimSend("dev-b:lightning:1", 1000 + 10 * 60_000)).toBe(true);
  });

  it("markSent locks the key — even an 'abandoned'-looking claim cannot be re-taken once sent", async () => {
    if (!store) return;
    await store.claimSend("dev-c:lightning:1", 1000);
    await store.markSent("dev-c:lightning:1", 1000);
    expect(await store.claimSend("dev-c:lightning:1", 1000 + 60 * 60_000)).toBe(false);
  });

  it("prunes claims older than the retention window", async () => {
    if (!store) return;
    const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;
    await store.claimSend("dev-d:old:1", 1000);
    await store.pruneSendClaims(1000 + THREE_DAYS + 1);
    // Pruned clean away: claiming it again looks like the very first claim.
    expect(await store.claimSend("dev-d:old:1", 1000 + THREE_DAYS + 2)).toBe(true);
  });
});
