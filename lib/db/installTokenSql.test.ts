// The install-token guard and the push-token move, run against REAL SQLite
// (node:sqlite) through the actual d1Store SQL, not a JS model of it. Covers
// what the memory-store tests cannot: the one-statement claim, the guard inside
// every write, concurrent claims, the atomic batch that moves a push token, the
// unique index, and migration 0020 on a copy of an old schema with duplicates.
// Skips when this Node has no node:sqlite.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { d1Store, type D1Like, type D1RunResult, type D1Stmt } from "@/lib/db/d1Store";
import type { DeviceStore } from "@/lib/db/store";
import { guardFromHeader, hashOfToken, InstallGuardDenied, NO_GUARD } from "@/lib/db/installGuard";

type Sqlite = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...p: unknown[]): { changes: number | bigint };
    get(...p: unknown[]): Record<string, unknown> | undefined;
    all(...p: unknown[]): Record<string, unknown>[];
  };
};
let Ctor: (new (p: string) => Sqlite) | null = null;
try {
  const m = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule?.("node:sqlite") as
    | { DatabaseSync: new (p: string) => Sqlite }
    | undefined;
  Ctor = m?.DatabaseSync ?? null;
} catch {
  Ctor = null;
}

interface Harness {
  raw: Sqlite;
  d1: D1Like;
  store: DeviceStore;
}

/** A D1-shaped wrapper. `batch` is a real transaction (BEGIN … COMMIT, ROLLBACK
 *  on any failure), like D1's: all statements land or none do. Statements run
 *  synchronously inside it so another batch cannot interleave. */
function wrap(raw: Sqlite): D1Like {
  type Sync = { sync(): D1RunResult };
  const make = (sql: string): D1Stmt & Sync => {
    const stmt = raw.prepare(sql);
    let bound: unknown[] = [];
    const self: D1Stmt & Sync = {
      bind(...v: unknown[]) {
        bound = v;
        return self;
      },
      async first<T>() {
        const r = stmt.get(...bound);
        return (r === undefined ? null : r) as T | null;
      },
      async run() {
        return self.sync();
      },
      async all<T>() {
        return { results: stmt.all(...bound) as T[] };
      },
      sync() {
        const r = stmt.run(...bound);
        return { success: true, meta: { changes: Number(r.changes) } };
      },
    };
    return self;
  };
  return {
    prepare: make,
    async batch(stmts) {
      raw.exec("BEGIN");
      try {
        const out = (stmts as (D1Stmt & Sync)[]).map((s) => s.sync());
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

const MIGRATIONS = path.join(process.cwd(), "migrations");
const migrationFiles = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();

function harness(): Harness {
  const raw = new Ctor!(":memory:");
  for (const f of migrationFiles()) raw.exec(readFileSync(path.join(MIGRATIONS, f), "utf8"));
  const d1 = wrap(raw);
  return { raw, d1, store: d1Store(d1) };
}

const A = "11111111-2222-4333-8444-555555555555";
const B = "22222222-2222-4333-8444-555555555555";
const TOK_A = "a-install-token-" + "x".repeat(30);
const TOK_B = "b-install-token-" + "y".repeat(30);
const PUSH = "f".repeat(80);
const PUSH2 = "g".repeat(80);
const NOW = Date.now();

describe.skipIf(!Ctor)("install-token SQL (real SQLite)", () => {
  describe("claimInstallToken — one conditional statement", () => {
    it("a brand-new id is created with the hash", async () => {
      const { store } = harness();
      expect(await store.claimInstallToken(A, hashOfToken(TOK_A), null, NOW)).toBe(true);
      expect(await store.getInstallTokenHash(A)).toBe(hashOfToken(TOK_A));
      expect(await store.getDevice(A)).toBeTruthy();
    });

    it("presenting the same token again succeeds (lost response, retry)", async () => {
      const { store } = harness();
      expect(await store.claimInstallToken(A, hashOfToken(TOK_A), null, NOW)).toBe(true);
      expect(await store.claimInstallToken(A, hashOfToken(TOK_A), null, NOW + 1)).toBe(true);
    });

    it("a different token is refused once one is on file", async () => {
      const { store } = harness();
      await store.claimInstallToken(A, hashOfToken(TOK_A), null, NOW);
      expect(await store.claimInstallToken(A, hashOfToken(TOK_B), null, NOW + 1)).toBe(false);
      expect(await store.getInstallTokenHash(A)).toBe(hashOfToken(TOK_A));
    });

    it("an existing row with a push token needs that push token as proof", async () => {
      const { store } = harness();
      await store.upsertDevice(A, { platform: "ios", pushToken: PUSH });
      expect(await store.claimInstallToken(A, hashOfToken(TOK_B), null, NOW)).toBe(false);
      expect(await store.claimInstallToken(A, hashOfToken(TOK_B), PUSH2, NOW)).toBe(false);
      expect(await store.getInstallTokenHash(A)).toBeNull();
      expect(await store.claimInstallToken(A, hashOfToken(TOK_A), PUSH, NOW)).toBe(true);
      expect(await store.getInstallTokenHash(A)).toBe(hashOfToken(TOK_A));
    });

    it("an existing row with no push token may still be claimed (the documented residual risk)", async () => {
      const { store } = harness();
      await store.upsertDevice(A, { tz: "America/New_York" });
      expect(await store.claimInstallToken(A, hashOfToken(TOK_A), null, NOW)).toBe(true);
    });

    it("of many concurrent claims with different tokens exactly one wins", async () => {
      const { store } = harness();
      const tokens = Array.from({ length: 12 }, (_, i) => `token-${i}-` + "z".repeat(30));
      const results = await Promise.all(tokens.map((t) => store.claimInstallToken(A, hashOfToken(t), null, NOW)));
      expect(results.filter(Boolean)).toHaveLength(1);
      const winner = tokens[results.indexOf(true)];
      expect(await store.getInstallTokenHash(A)).toBe(hashOfToken(winner));
    });
  });

  describe("the guard rides inside each write", () => {
    async function claimed(h: Harness, withPush = false) {
      await h.store.upsertDevice(A, { codeUntil: NOW + 3600_000, ...(withPush ? { platform: "ios" as const, pushToken: PUSH } : {}) });
      await h.store.setInstallTokenHash(A, hashOfToken(TOK_A), NOW);
    }
    const good = guardFromHeader(TOK_A, true);
    const bad = guardFromHeader(TOK_B, true);
    const none = guardFromHeader(null, true);

    it("upsertDevice: right token writes, wrong or missing token changes nothing", async () => {
      const h = harness();
      await claimed(h);
      await expect(h.store.upsertDevice(A, { homeSlug: "boca-raton" }, bad)).rejects.toBeInstanceOf(InstallGuardDenied);
      await expect(h.store.upsertDevice(A, { homeSlug: "boca-raton" }, none)).rejects.toBeInstanceOf(InstallGuardDenied);
      expect((await h.store.getDevice(A))!.homeSlug).toBeNull();
      await h.store.upsertDevice(A, { homeSlug: "boca-raton" }, good);
      expect((await h.store.getDevice(A))!.homeSlug).toBe("boca-raton");
    });

    it("upsertDevice: while enforcing, a missing row is not created; while not enforcing it is", async () => {
      const h = harness();
      await expect(h.store.upsertDevice(B, { tz: "America/New_York" }, none)).rejects.toBeInstanceOf(InstallGuardDenied);
      expect(await h.store.getDevice(B)).toBeNull();
      await h.store.upsertDevice(B, { tz: "America/New_York" }, guardFromHeader(null, false));
      expect(await h.store.getDevice(B)).toBeTruthy();
    });

    it("upsertDevice: a row with NO hash is refused while enforcing", async () => {
      const h = harness();
      await h.store.upsertDevice(A, {});
      await expect(h.store.upsertDevice(A, { tz: "America/New_York" }, good)).rejects.toBeInstanceOf(InstallGuardDenied);
    });

    it("not enforcing: no token passes, a wrong token is still refused, a right one passes", async () => {
      const h = harness();
      await claimed(h);
      await h.store.upsertDevice(A, { homeSlug: "boca-raton" }, guardFromHeader(null, false));
      await expect(h.store.upsertDevice(A, { homeSlug: "cocoa-beach" }, guardFromHeader(TOK_B, false))).rejects.toBeInstanceOf(
        InstallGuardDenied,
      );
      await h.store.upsertDevice(A, { homeSlug: "cocoa-beach" }, guardFromHeader(TOK_A, false));
      expect((await h.store.getDevice(A))!.homeSlug).toBe("cocoa-beach");
    });

    it("claimTrial: wrong token leaves the trial unspent", async () => {
      const h = harness();
      await h.store.upsertDevice(A, {});
      await h.store.setInstallTokenHash(A, hashOfToken(TOK_A), NOW);
      await expect(h.store.claimTrial(A, NOW + 1000, bad)).rejects.toBeInstanceOf(InstallGuardDenied);
      expect((await h.store.getDevice(A))!.trialUsed).toBe(false);
      const r = await h.store.claimTrial(A, NOW + 1000, good);
      expect(r).not.toBe("trial-used");
      expect(await h.store.claimTrial(A, NOW + 1000, good)).toBe("trial-used");
    });

    it("setPresence / clearPresence: refused without the token, nothing written", async () => {
      const h = harness();
      await claimed(h);
      const p = { slug: "boca-raton", armedUntil: NOW + 3600_000, source: "manual" as const };
      await expect(h.store.setPresence(A, p, none)).rejects.toBeInstanceOf(InstallGuardDenied);
      expect((await h.store.getDevice(A))!.presence).toBeNull();
      await h.store.setPresence(A, p, good);
      expect((await h.store.getDevice(A))!.presence).not.toBeNull();
      await expect(h.store.clearPresence(A, bad)).rejects.toBeInstanceOf(InstallGuardDenied);
      expect((await h.store.getDevice(A))!.presence).not.toBeNull();
      await h.store.clearPresence(A, good);
      expect((await h.store.getDevice(A))!.presence).toBeNull();
    });

    it("clearPushRegistration: a real row keeps its token unless the guard passes; a legacy row goes on possession", async () => {
      const h = harness();
      await claimed(h, true);
      await h.store.clearPushRegistration(PUSH, none);
      expect(await h.store.getPushToken(A)).toBe(PUSH);
      await h.store.clearPushRegistration(PUSH, bad);
      expect(await h.store.getPushToken(A)).toBe(PUSH);
      await h.store.clearPushRegistration(PUSH, good);
      expect(await h.store.getPushToken(A)).toBeNull();

      await h.store.upsertDevice("legacy:abc", { platform: "android", pushToken: PUSH2 });
      await h.store.clearPushRegistration(PUSH2, none);
      expect(await h.store.getDevice("legacy:abc")).toBeNull();
    });
  });

  describe("transferPushToken — one atomic batch, one holder", () => {
    it("moves the token: the source keeps its record and loses the token", async () => {
      const h = harness();
      await h.store.upsertDevice(A, { platform: "ios", pushToken: PUSH, homeSlug: "boca-raton" });
      await h.store.claimInstallToken(B, hashOfToken(TOK_B), null, NOW);
      await h.store.transferPushToken({ id: B, token: PUSH, patch: { platform: "ios", homeSlug: "boca-raton" } }, guardFromHeader(TOK_B, true));
      expect(await h.store.getPushToken(B)).toBe(PUSH);
      expect(await h.store.getPushToken(A)).toBeNull();
      expect(await h.store.getDevice(A)).toBeTruthy();
    });

    it("a legacy source row is deleted whole", async () => {
      const h = harness();
      await h.store.upsertDevice("legacy:xyz", { platform: "android", pushToken: PUSH });
      await h.store.transferPushToken({ id: A, token: PUSH, patch: { platform: "android" } });
      expect(await h.store.getDevice("legacy:xyz")).toBeNull();
      expect(await h.store.getPushToken(A)).toBe(PUSH);
    });

    it("a refused guard detaches nobody", async () => {
      const h = harness();
      await h.store.upsertDevice(A, { platform: "ios", pushToken: PUSH });
      await h.store.claimInstallToken(B, hashOfToken(TOK_B), null, NOW);
      await expect(
        h.store.transferPushToken({ id: B, token: PUSH, patch: { platform: "ios" } }, guardFromHeader(TOK_A, true)),
      ).rejects.toBeInstanceOf(InstallGuardDenied);
      expect(await h.store.getPushToken(A)).toBe(PUSH);
      expect(await h.store.getPushToken(B)).toBeNull();
    });

    it("if the attach fails, the detach is rolled back (the phone is never left with no target)", async () => {
      const h = harness();
      await h.store.upsertDevice(A, { platform: "ios", pushToken: PUSH });
      // Make creating the destination row fail AFTER the detach statements ran.
      h.raw.exec(
        "CREATE TRIGGER boom BEFORE INSERT ON devices WHEN NEW.id = 'boom-device-id' " +
          "BEGIN SELECT RAISE(ABORT, 'boom'); END;",
      );
      await expect(
        h.store.transferPushToken({ id: "boom-device-id", token: PUSH, patch: { platform: "ios" } }),
      ).rejects.toThrow();
      expect(await h.store.getPushToken(A)).toBe(PUSH);
    });

    it("two racing transfers of one token leave exactly one holder", async () => {
      const h = harness();
      await h.store.upsertDevice(A, { platform: "ios", pushToken: PUSH });
      const ids = Array.from({ length: 6 }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`);
      await Promise.allSettled(
        ids.map((id) => h.store.transferPushToken({ id, token: PUSH, patch: { platform: "ios" } })),
      );
      const holders = h.raw.prepare("SELECT id FROM devices WHERE push_token = ?").all(PUSH);
      expect(holders).toHaveLength(1);
    });

    it("the unique index refuses a second holder written any other way", async () => {
      const h = harness();
      await h.store.upsertDevice(A, { platform: "ios", pushToken: PUSH });
      await expect(h.store.upsertDevice(B, { platform: "ios", pushToken: PUSH })).rejects.toThrow(/UNIQUE/i);
    });
  });

  describe("migration 0020 on a copy of the old schema", () => {
    it("clears duplicate push tokens, keeping the most recently updated row, then adds the unique index", () => {
      const raw = new Ctor!(":memory:");
      for (const f of migrationFiles().filter((f) => f < "0020")) raw.exec(readFileSync(path.join(MIGRATIONS, f), "utf8"));
      const ins = raw.prepare(
        "INSERT INTO devices (id, push_token, platform, created_at, updated_at) VALUES (?, ?, 'ios', 1, ?)",
      );
      ins.run("old-a", "dup-token", 100);
      ins.run("new-b", "dup-token", 300);
      ins.run("mid-c", "dup-token", 200);
      ins.run("tie-d", "tie-token", 50);
      ins.run("tie-c", "tie-token", 50); // same time: smaller id keeps it
      ins.run("solo", "solo-token", 10);
      ins.run("none", null, 10);

      raw.exec(readFileSync(path.join(MIGRATIONS, "0020_push_token_unique.sql"), "utf8"));

      const rows = Object.fromEntries(
        raw.prepare("SELECT id, push_token FROM devices").all().map((r) => [r.id as string, r.push_token as string | null]),
      );
      expect(rows).toEqual({
        "old-a": null,
        "new-b": "dup-token",
        "mid-c": null,
        "tie-d": null,
        "tie-c": "tie-token",
        solo: "solo-token",
        none: null,
      });
      // Records survive; only the token is dropped.
      expect(raw.prepare("SELECT COUNT(*) AS n FROM devices").get()!.n).toBe(7);
      // And the index now holds the line.
      expect(() => ins.run("another", "solo-token", 999)).toThrow(/UNIQUE/i);
      // Several rows with no token are fine.
      ins.run("n1", null, 1);
      ins.run("n2", null, 1);
    });

    it("applies cleanly on an empty schema", () => {
      const raw = new Ctor!(":memory:");
      for (const f of migrationFiles()) raw.exec(readFileSync(path.join(MIGRATIONS, f), "utf8"));
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'devices_push_token_unique'").get()).toBeTruthy();
    });
  });

  it("NO_GUARD changes nothing about plain writes", async () => {
    const h = harness();
    await h.store.upsertDevice(A, { homeSlug: "boca-raton" }, NO_GUARD);
    expect((await h.store.getDevice(A))!.homeSlug).toBe("boca-raton");
  });
});
