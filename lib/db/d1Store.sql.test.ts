// d1Store.ts talks to production over raw SQL — a JSON1 `json_patch` merge and
// a wall of numbered-parameter CASE expressions (#3, #4) that no other test
// exercises against a real SQLite engine. Every other test in this repo runs
// against the in-memory store, so a typo or an off-by-one in the SQL text
// itself would sail through `npm test` undetected. This file runs the actual
// `d1Store()` implementation — same code, same SQL strings — against Node's
// built-in SQLite (json_patch and multi-arg CASE/COALESCE/MAX included),
// wrapped in a small adapter that implements the same D1Like/D1Stmt surface
// `getD1()` hands back in production. If `node:sqlite` isn't available on
// whatever Node runs this suite, these tests skip rather than fail the run.
//
// The schema comes from the real migration files, applied in order — so a
// migration that doesn't actually produce a working schema fails here too.

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { d1Store, type D1Like, type D1RunResult, type D1Stmt } from "@/lib/db/d1Store";
import type { DeviceStore } from "@/lib/db/store";

let DatabaseSyncCtor: (new (path: string) => {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number | bigint };
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  };
  close(): void;
}) | null = null;
try {
  // `process.getBuiltinModule` (not a static `import`) on purpose: Vite's
  // dev-server module resolution — which vitest runs every test file
  // through — doesn't know the still-experimental "node:sqlite" specifier
  // and fails to resolve it, even though Node itself has it. Reading it off
  // `process` skips that resolution step entirely. A Node build that has
  // neither leaves the ctor null and every test below skips.
  const sqlite = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule?.(
    "node:sqlite",
  ) as { DatabaseSync: NonNullable<typeof DatabaseSyncCtor> } | undefined;
  DatabaseSyncCtor = sqlite?.DatabaseSync ?? null;
} catch {
  DatabaseSyncCtor = null;
}

/** Wrap a real SQLite connection in the D1Like/D1Stmt surface d1Store uses. */
function wrapAsD1(db: InstanceType<NonNullable<typeof DatabaseSyncCtor>>): D1Like {
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
          const row = stmt.get(...bound);
          return (row === undefined ? null : row) as T | null;
        },
        async run(): Promise<D1RunResult> {
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
}

function freshStore(): DeviceStore | null {
  if (!DatabaseSyncCtor) return null;
  const db = new DatabaseSyncCtor(":memory:");
  const dir = path.join(process.cwd(), "migrations");
  for (const file of readdirSync(dir).sort()) {
    if (file.endsWith(".sql")) db.exec(readFileSync(path.join(dir, file), "utf8"));
  }
  return d1Store(wrapAsD1(db));
}

const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;

describe.skipIf(!DatabaseSyncCtor)("d1Store against real SQLite (the actual SQL, not a JS model of it)", () => {
  let store: DeviceStore;

  beforeEach(() => {
    store = freshStore() as DeviceStore;
  });

  // --- #3: atomic field-specific writes -------------------------------------
  describe("concurrent writes never clobber a field they didn't touch", () => {
    it("an entitlement grant and a prefs/profile save both survive, whichever order they land", async () => {
      await store.upsertDevice("d1", {});
      const now = Date.now();
      // Two "concurrent" callers, fired together — both read from the same
      // starting row conceptually; only the atomic SQL keeps them from
      // stepping on each other.
      await Promise.all([
        store.upsertDevice("d1", { codeUntil: now + 365 * DAY, trialUsed: true }),
        store.upsertDevice("d1", { prefs: { lightning: false }, profile: { profiles: ["swim"], heat: "hot", crowds: "low" } }),
      ]);
      const dev = await store.getDevice("d1");
      expect(dev?.plan).toBe("plus");
      expect(dev?.grants.codeUntil).toBe(now + 365 * DAY);
      expect(dev?.trialUsed).toBe(true);
      expect(dev?.prefs.lightning).toBe(false);
      expect(dev?.profile).toEqual({ profiles: ["swim"], heat: "hot", crowds: "low" });
    });

    it("a revocation and an unrelated update afterward: access stays revoked", async () => {
      await store.upsertDevice("d2", { codeUntil: Date.now() + 30 * DAY });
      await store.upsertDevice("d2", { codeUntil: null }); // revoked
      await store.upsertDevice("d2", { tz: "America/New_York" }); // unrelated, after
      const dev = await store.getDevice("d2");
      expect(dev?.plan).toBe("free");
      expect(dev?.tz).toBe("America/New_York");
    });

    it("two concurrent different alert toggles both persist", async () => {
      await store.upsertDevice("d3", {});
      await Promise.all([
        store.upsertDevice("d3", { prefs: { lightning: false } }),
        store.upsertDevice("d3", { prefs: { rip: false } }),
      ]);
      const dev = await store.getDevice("d3");
      expect(dev?.prefs.lightning).toBe(false);
      expect(dev?.prefs.rip).toBe(false);
      expect(dev?.prefs.morning).toBe(true); // untouched, still the default
    });

    it("concurrent trial claims: exactly one succeeds", async () => {
      const until = Date.now() + 3 * DAY;
      const results = await Promise.all([
        store.claimTrial("d4", until),
        store.claimTrial("d4", until),
        store.claimTrial("d4", until),
      ]);
      const won = results.filter((r) => r !== "trial-used");
      const lost = results.filter((r) => r === "trial-used");
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(2);
      const dev = await store.getDevice("d4");
      expect(dev?.trialUsed).toBe(true);
      expect(dev?.plan).toBe("plus");
    });
  });

  // --- #4: grant sources are independent, and only ever move access up -----
  describe("independent grant sources", () => {
    it("a 365-day code grant survives restoring a 30-day store subscription", async () => {
      const codeUntil = Date.now() + 365 * DAY;
      await store.upsertDevice("g1", { codeUntil });
      await store.upsertDevice("g1", { storeUntil: Date.now() + 30 * DAY });
      const dev = await store.getDevice("g1");
      expect(dev?.entitlementUntil).toBe(codeUntil); // the longer grant still wins
      expect(dev?.grants.storeUntil).not.toBeNull();
      expect(dev?.grants.codeUntil).toBe(codeUntil);
    });

    it("a store expiration leaves an independent code grant intact", async () => {
      const codeUntil = Date.now() + 365 * DAY;
      await store.upsertDevice("g2", { codeUntil, storeUntil: Date.now() + 30 * DAY });
      await store.upsertDevice("g2", { storeUntil: null }); // the subscription lapsed
      const dev = await store.getDevice("g2");
      expect(dev?.plan).toBe("plus");
      expect(dev?.entitlementUntil).toBe(codeUntil);
      expect(dev?.grants.storeUntil).toBeNull();
    });

    it("a three-day trial claim cannot shorten a longer existing grant", async () => {
      const codeUntil = Date.now() + 365 * DAY;
      await store.upsertDevice("g3", { codeUntil });
      await store.claimTrial("g3", Date.now() + 3 * DAY);
      const dev = await store.getDevice("g3");
      expect(dev?.entitlementUntil).toBe(codeUntil);
    });

    it("a longer purchase extends a shorter trial", async () => {
      await store.claimTrial("g4", Date.now() + 3 * DAY);
      const storeUntil = Date.now() + 365 * DAY;
      await store.upsertDevice("g4", { storeUntil });
      const dev = await store.getDevice("g4");
      expect(dev?.entitlementUntil).toBe(storeUntil);
      expect(dev?.trialUsed).toBe(true); // the trial flag itself is untouched
    });
  });

  // --- #5: dead-token prune preserves everything but the token -------------
  describe("clearPushToken (#5)", () => {
    it("keeps entitlement, profile and trial history — only the token clears", async () => {
      await store.upsertDevice("p1", {
        pushToken: "dead-token",
        codeUntil: Date.now() + 30 * DAY,
        trialUsed: true,
        profile: { profiles: ["kids"], heat: "normal", crowds: "normal" },
      });
      await store.clearPushToken("p1", "dead-token");
      const dev = await store.getDevice("p1");
      expect(dev?.plan).toBe("plus");
      expect(dev?.trialUsed).toBe(true);
      expect(dev?.profile).toEqual({ profiles: ["kids"], heat: "normal", crowds: "normal" });
      expect(await store.getPushToken("p1")).toBeNull();
    });

    it("does not clear a token that was already replaced", async () => {
      await store.upsertDevice("p2", { pushToken: "old-token" });
      await store.upsertDevice("p2", { pushToken: "new-token" }); // re-registered
      await store.clearPushToken("p2", "old-token"); // the stale prune arrives late
      expect(await store.getPushToken("p2")).toBe("new-token");
    });
  });

  // --- listArmed keeps reading the derived columns correctly ---------------
  it("listArmed only returns a device whose derived entitlement is still live", async () => {
    await store.upsertDevice("a1", { codeUntil: Date.now() + HOUR });
    await store.setPresence("a1", { slug: "boca-raton", armedUntil: Date.now() + HOUR, source: "auto" });
    await store.upsertDevice("a2", { codeUntil: Date.now() - 1 }); // lapsed
    await store.setPresence("a2", { slug: "boca-raton", armedUntil: Date.now() + HOUR, source: "auto" });
    const armed = await store.listArmed(Date.now());
    expect(armed.map((a) => a.device.id)).toEqual(["a1"]);
  });
});
