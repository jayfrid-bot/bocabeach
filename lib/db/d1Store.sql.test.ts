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
import {
  d1Store,
  REGISTER_LIVE_ACTIVITY,
  SUPERSEDE_OTHER_ACTIVE_IF_LANDED,
  type D1Like,
  type D1RunResult,
  type D1Stmt,
} from "@/lib/db/d1Store";
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

function freshRawDb(): D1Like | null {
  if (!DatabaseSyncCtor) return null;
  const db = new DatabaseSyncCtor(":memory:");
  const dir = path.join(process.cwd(), "migrations");
  for (const file of readdirSync(dir).sort()) {
    if (file.endsWith(".sql")) db.exec(readFileSync(path.join(dir, file), "utf8"));
  }
  return wrapAsD1(db);
}

function freshStore(): DeviceStore | null {
  const raw = freshRawDb();
  return raw ? d1Store(raw) : null;
}

/** Runs the exact [SUPERSEDE, REGISTER] pair `registerLiveActivity` sends as
 *  one batch — bypassing its JS-level "existing.status !== 'active'" fast
 *  path (round-3 #2's doc: that pre-check is a fast path only, never relied
 *  on for correctness). Used to reproduce a genuinely concurrent register:
 *  two overlapping requests both read the row as 'active' before either's
 *  batch commits, so the fast path can't short-circuit either of them — only
 *  the SQL's own guards decide the outcome. */
async function runRegisterBatch(
  db: D1Like,
  input: { activityId: string; deviceId: string; rotation: number | null },
  now: number,
) {
  const supersede = db
    .prepare(SUPERSEDE_OTHER_ACTIVE_IF_LANDED)
    .bind(now, input.deviceId, input.activityId, input.rotation);
  const register = db
    .prepare(REGISTER_LIVE_ACTIVITY)
    .bind(
      input.activityId,
      input.deviceId,
      "boca",
      1,
      "1",
      "production",
      "t".repeat(64),
      now,
      now,
      now + HOUR,
      input.rotation,
    );
  await supersede.run();
  await register.run();
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

  // --- Hourly history archive (migrations/0006_history.sql) ----------------
  // Real SQL for the two bits d1Store.sql.test.ts exists specifically to
  // catch: the UPSERT that must refuse a max<=0 budget outright (Codex
  // round-2 finding #2 — the JS-model in-memory store never had this bug,
  // it only showed up in the real "INSERT branch bypasses the ON CONFLICT
  // WHERE clause" SQLite semantics), and the claim abandonment window's
  // win/lose/abandon/complete states (finding #4).
  describe("reserveHistoryBuild — real UPSERT, max <= 0 refused outright", () => {
    it("max=0 refuses every reservation, including the day's first ever", async () => {
      expect(await store.reserveHistoryBuild("2026-09-20", 0)).toBe(false);
      expect(await store.getHistoryBudget("2026-09-20")).toBe(0);
    });

    it("max=2 admits exactly two reservations, then refuses", async () => {
      expect(await store.reserveHistoryBuild("2026-09-20", 2)).toBe(true);
      expect(await store.reserveHistoryBuild("2026-09-20", 2)).toBe(true);
      expect(await store.reserveHistoryBuild("2026-09-20", 2)).toBe(false);
      expect(await store.getHistoryBudget("2026-09-20")).toBe(2);
    });

    it("a day-boundary split: each day gets its own independent budget", async () => {
      expect(await store.reserveHistoryBuild("2026-09-20", 1)).toBe(true);
      expect(await store.reserveHistoryBuild("2026-09-20", 1)).toBe(false); // day 1 exhausted
      expect(await store.reserveHistoryBuild("2026-09-21", 1)).toBe(true); // day 2, fresh budget
      expect(await store.getHistoryBudget("2026-09-20")).toBe(1);
      expect(await store.getHistoryBudget("2026-09-21")).toBe(1);
    });
  });

  describe("claimHistoryBuild — real abandonment-window UPSERT (win / lose / abandon / complete)", () => {
    const hourUtc = "2026-09-20T14:00:00.000Z";
    const TEN_MIN = 10 * 60 * 1000;

    it("wins a fresh claim", async () => {
      expect(await store.claimHistoryBuild("boca-raton", hourUtc, 1_000_000)).toBe(true);
    });

    it("loses a claim that's still fresh (not abandoned, not completed)", async () => {
      expect(await store.claimHistoryBuild("boca-raton", hourUtc, 1_000_000)).toBe(true);
      expect(await store.claimHistoryBuild("boca-raton", hourUtc, 1_000_000 + 60_000)).toBe(false);
    });

    it("wins an abandoned claim (never completed, older than the 10-minute window)", async () => {
      const claimedAt = 1_000_000;
      expect(await store.claimHistoryBuild("boca-raton", hourUtc, claimedAt)).toBe(true);
      expect(await store.claimHistoryBuild("boca-raton", hourUtc, claimedAt + TEN_MIN - 1)).toBe(false);
      expect(await store.claimHistoryBuild("boca-raton", hourUtc, claimedAt + TEN_MIN + 1)).toBe(true);
    });

    it("a completed claim is never re-claimable, no matter how old", async () => {
      const claimedAt = 1_000_000;
      expect(await store.claimHistoryBuild("boca-raton", hourUtc, claimedAt)).toBe(true);
      await store.completeHistoryClaim("boca-raton", hourUtc, claimedAt + 1000);
      expect(await store.claimHistoryBuild("boca-raton", hourUtc, claimedAt + 100 * TEN_MIN)).toBe(false);
    });

    it("releaseHistoryClaim deletes the claim so it can be re-claimed immediately", async () => {
      const claimedAt = 1_000_000;
      expect(await store.claimHistoryBuild("boca-raton", hourUtc, claimedAt)).toBe(true);
      await store.releaseHistoryClaim("boca-raton", hourUtc);
      expect(await store.claimHistoryBuild("boca-raton", hourUtc, claimedAt + 1)).toBe(true);
    });
  });

  // --- presence fix purge (housekeeping in app/api/push/run/route.ts) -------
  describe("purgeExpiredPresenceFixes — the real UPDATE", () => {
    const NOW = 2_000_000_000_000;
    const fix = { lat: 26.35, lon: -80.07, accuracyM: 20, fixAt: NOW - 60_000 };

    it("blanks only expired rows' coordinates, keeps the row, reports the count", async () => {
      await store.upsertDevice("p1", { codeUntil: NOW + HOUR });
      await store.upsertDevice("p2", { codeUntil: NOW + HOUR });
      await store.setPresence("p1", { slug: "boca-raton", ...fix, armedUntil: NOW - 1, source: "auto" });
      await store.setPresence("p2", { slug: "boca-raton", ...fix, armedUntil: NOW + HOUR, source: "manual" });
      expect(await store.purgeExpiredPresenceFixes(NOW)).toBe(1);
      expect(await store.purgeExpiredPresenceFixes(NOW)).toBe(0); // idempotent
      expect((await store.getDevice("p1"))?.presence?.slug).toBe("boca-raton");
      const live = await store.listArmed(NOW);
      expect(live).toHaveLength(1);
      expect(live[0].presence).toMatchObject({ slug: "boca-raton", lat: 26.35, fixAt: NOW - 60_000 });
      const expired = (await store.listArmed(NOW - 60_000)).find((a) => a.device.id === "p1");
      expect(expired?.presence).toMatchObject({ lat: null, lon: null, accuracyM: null, fixAt: null });
    });
  });

  // --- Beach Session Live Activity (migrations/0007_live_activities.sql) ---
  // Real SQL: the ON CONFLICT(activity_id) DO UPDATE that rotates a token
  // while keeping started_at sticky, and the partial-unique-index/CASE
  // machinery no JS model of the schema would catch a typo in.
  describe("live activities — real UPSERT + indexes", () => {
    const NOW = 2_000_000_000_000;
    const HOUR = 3600 * 1000;

    function baseInput(over: Partial<Parameters<DeviceStore["upsertLiveActivity"]>[0]> = {}) {
      return {
        activityId: "act-1",
        deviceId: "dev-1",
        beachSlug: "boca-raton",
        schemaVersion: 1,
        appBuild: "42",
        apnsEnvironment: "sandbox" as const,
        pushToken: "a".repeat(64),
        startedAt: NOW,
        expiresAt: NOW + HOUR,
        ...over,
      };
    }

    function registerInput(over: Partial<Parameters<DeviceStore["registerLiveActivity"]>[0]> = {}) {
      return { ...baseInput(over), rotation: null, ...over };
    }

    it("inserts an active row", async () => {
      const row = await store.upsertLiveActivity(baseInput());
      expect(row.status).toBe("active");
      expect(row.pushToken).toBe("a".repeat(64));
    });

    it("a rotation for the same activityId replaces the token and keeps started_at", async () => {
      await store.upsertLiveActivity(baseInput());
      const rotated = await store.upsertLiveActivity(
        baseInput({ pushToken: "b".repeat(64), startedAt: NOW + 999_999 }),
      );
      expect(rotated.pushToken).toBe("b".repeat(64));
      expect(rotated.startedAt).toBe(NOW);
      const forDevice = await store.listLiveActivitiesForDevice("dev-1");
      expect(forDevice).toHaveLength(1);
    });

    it("markLiveActivityEnded flips status and listActiveLiveActivities excludes it", async () => {
      await store.upsertLiveActivity(baseInput());
      await store.markLiveActivityEnded("act-1", "user", NOW);
      expect(await store.listActiveLiveActivities(NOW)).toEqual([]);
      const row = (await store.listLiveActivitiesForDevice("dev-1"))[0];
      expect(row.status).toBe("ended");
      expect(row.endedAt).not.toBeNull();
    });

    it("recordLiveActivitySend persists hash/status/state for the next run's diff", async () => {
      await store.upsertLiveActivity(baseInput());
      const seq = (await store.allocateLiveActivitySeq("act-1", NOW))?.seq;
      await store.recordLiveActivitySend("act-1", {
        timestamp: NOW + 1,
        status: 200,
        hash: "h1",
        stateJson: '{"score":75}',
        seq: seq!,
      });
      const row = (await store.listLiveActivitiesForDevice("dev-1"))[0];
      expect(row.lastStateHash).toBe("h1");
      expect(row.lastStateJson).toBe('{"score":75}');
      expect(row.lastSentAt).toBe(NOW + 1);
    });

    describe("registerLiveActivity — round-2 #3: register-then-conditional-supersede", () => {
      it("a stale retry of A after B is already active leaves B active", async () => {
        // A registers first (rotation 1), then B (a fresh activity for the
        // same device) supersedes it.
        await store.registerLiveActivity(registerInput({ activityId: "A", deviceId: "dev-1", rotation: 1 }));
        await store.registerLiveActivity(
          registerInput({ activityId: "B", deviceId: "dev-1", pushToken: "b".repeat(64), rotation: 1 }),
        );
        // A stale retry for A, rotation 1 again — A is no longer 'active'
        // (B's registration superseded/ended it), so this reads as `ended`
        // (Codex round-3 #3) rather than `stale-rotation` — either way it
        // must not end B.
        const result = await store.registerLiveActivity(
          registerInput({ activityId: "A", deviceId: "dev-1", rotation: 1 }),
        );
        expect(result).toBe("ended");
        const rows = await store.listLiveActivitiesForDevice("dev-1");
        const b = rows.find((r) => r.activityId === "B");
        expect(b?.status).toBe("active");
      });

      it("Codex round-3 #2 (first-seen race): concurrent first-time registers for the same brand-new activityId — the loser gets `not-owner`, never a false success", async () => {
        // Both callers see `existing === null` in their pre-check (neither
        // row exists yet) — the old bug trusted that stale pre-read and
        // reported success to both. The fix re-reads the row AFTER the
        // batch and verifies ownership from what's actually there.
        const [ra, rb] = await Promise.all([
          store.registerLiveActivity(registerInput({ activityId: "X", deviceId: "dev-1" })),
          store.registerLiveActivity(
            registerInput({ activityId: "X", deviceId: "dev-2", pushToken: "e".repeat(64) }),
          ),
        ]);
        const outcomes = [ra, rb];
        const winners = outcomes.filter((r) => typeof r === "object");
        const losers = outcomes.filter((r) => typeof r === "string");
        expect(winners.length).toBe(1);
        expect(losers).toEqual(["not-owner"]);
        const rows = await store.listLiveActivitiesForDevice(
          (winners[0] as { deviceId: string }).deviceId,
        );
        const row = rows.find((r) => r.activityId === "X");
        expect(row?.deviceId).toBe((winners[0] as { deviceId: string }).deviceId);
      });

      it("ownership never moves — a device-mismatch attempt leaves the real owner's row untouched", async () => {
        await store.registerLiveActivity(registerInput({ activityId: "A", deviceId: "dev-1" }));
        const result = await store.registerLiveActivity(
          registerInput({ activityId: "A", deviceId: "dev-2", pushToken: "c".repeat(64) }),
        );
        expect(result).toBe("device-mismatch");
        const rows = await store.listLiveActivitiesForDevice("dev-1");
        expect(rows[0]?.status).toBe("active");
        expect(rows[0]?.pushToken).toBe("a".repeat(64));
      });

      it("concurrent first-time callers: the second registration for a new activity supersedes the first cleanly", async () => {
        await store.registerLiveActivity(registerInput({ activityId: "A", deviceId: "dev-1", rotation: 1 }));
        const result = await store.registerLiveActivity(
          registerInput({ activityId: "B", deviceId: "dev-1", pushToken: "b".repeat(64), rotation: 1 }),
        );
        expect(result).not.toBe("stale-rotation");
        expect(result).not.toBe("device-mismatch");
        const rows = await store.listLiveActivitiesForDevice("dev-1");
        const a = rows.find((r) => r.activityId === "A");
        const b = rows.find((r) => r.activityId === "B");
        expect(a?.status).toBe("ended");
        expect(b?.status).toBe("active");
      });

      it("a rotation that exceeds what's on file updates an ACTIVE row and supersedes others", async () => {
        await store.registerLiveActivity(registerInput({ activityId: "A", deviceId: "dev-1", rotation: 1 }));
        const result = await store.registerLiveActivity(
          registerInput({ activityId: "A", deviceId: "dev-1", pushToken: "d".repeat(64), rotation: 2 }),
        );
        expect(result).not.toBe("stale-rotation");
        expect(result).not.toBe("device-mismatch");
        expect(result).not.toBe("ended");
        const rows = await store.listLiveActivitiesForDevice("dev-1");
        const a = rows.find((r) => r.activityId === "A");
        expect(a?.status).toBe("active");
        expect(a?.pushToken).toBe("d".repeat(64));
      });

      it("Codex round-3 #3 (HIGH): a delayed higher rotation for an ENDED activity must not reactivate it", async () => {
        await store.registerLiveActivity(registerInput({ activityId: "A", deviceId: "dev-1", rotation: 1 }));
        // B supersedes/ends A.
        await store.registerLiveActivity(
          registerInput({ activityId: "B", deviceId: "dev-1", pushToken: "b".repeat(64), rotation: 1 }),
        );
        // A delayed register for A with a HIGHER rotation than anything on
        // file arrives after A was already ended — must be refused, not
        // silently reactivate A (which would also leave two 'active' rows
        // for this device, violating the one-active-per-device invariant).
        const result = await store.registerLiveActivity(
          registerInput({ activityId: "A", deviceId: "dev-1", pushToken: "d".repeat(64), rotation: 2 }),
        );
        expect(result).toBe("ended");
        const rows = await store.listLiveActivitiesForDevice("dev-1");
        const a = rows.find((r) => r.activityId === "A");
        const b = rows.find((r) => r.activityId === "B");
        expect(a?.status).toBe("ended");
        expect(a?.pushToken).not.toBe("d".repeat(64)); // untouched by the refused register
        expect(b?.status).toBe("active"); // still the one active row
      });

      it("Codex round-4 #2 (HIGH): a truly concurrent delayed rotation-2 batch for A must not end B", async () => {
        // Unlike the test above, this bypasses registerLiveActivity's JS-level
        // fast path (which only fires when its own pre-read already saw A as
        // not-active) and drives the exact SQL batch directly — reproducing
        // two requests that both read A as 'active' before either commits, so
        // only SUPERSEDE_OTHER_ACTIVE_IF_LANDED's own guard can prevent A's
        // stale-but-higher-rotation batch from superseding B.
        const raw = freshRawDb();
        if (!raw) return;
        const localStore = d1Store(raw);
        const now = Date.now();
        // A registers (active, rotation 1).
        await localStore.registerLiveActivity(registerInput({ activityId: "A", deviceId: "dev-1", rotation: 1 }));
        // B registers next, superseding A (A -> ended).
        await localStore.registerLiveActivity(
          registerInput({ activityId: "B", deviceId: "dev-1", pushToken: "b".repeat(64), rotation: 1 }),
        );
        // The delayed A/rotation-2 batch, run directly against the same
        // connection — its own pre-batch read (elsewhere) would have seen A
        // as still 'active' had it raced ahead of B's write.
        await runRegisterBatch(raw, { activityId: "A", deviceId: "dev-1", rotation: 2 }, now);

        const rows = await localStore.listLiveActivitiesForDevice("dev-1");
        const a = rows.find((r) => r.activityId === "A");
        const b = rows.find((r) => r.activityId === "B");
        expect(a?.status).toBe("ended"); // A's register was refused (not 'active' at commit time)
        expect(b?.status).toBe("active"); // B must survive the delayed batch untouched
      });
    });

    describe("allocateLiveActivitySeq — real RETURNING (round-2 #5)", () => {
      it("increments last_seq via UPDATE ... RETURNING and returns the new value", async () => {
        await store.upsertLiveActivity(baseInput());
        expect((await store.allocateLiveActivitySeq("act-1", NOW))?.seq).toBe(1);
        expect((await store.allocateLiveActivitySeq("act-1", NOW))?.seq).toBe(2);
      });

      it("returns null once the row is ended — overlapping runs never send the same seq for a dead row", async () => {
        await store.upsertLiveActivity(baseInput());
        await store.markLiveActivityEnded("act-1", "user", NOW);
        expect(await store.allocateLiveActivitySeq("act-1", NOW)).toBeNull();
      });

      it("Codex round-3: seq and timestamp are allocated atomically and strictly co-monotonic across concurrent callers", async () => {
        // Two "concurrent" allocations at the SAME `now` (simulating two
        // overlapping runs racing the same wall-clock tick) must still come
        // back with strictly increasing timestamps, tied to seq order —
        // never a higher seq with an equal-or-lower timestamp than the
        // allocation before it.
        await store.upsertLiveActivity(baseInput());
        const a = await store.allocateLiveActivitySeq("act-1", NOW);
        const b = await store.allocateLiveActivitySeq("act-1", NOW);
        expect(a?.seq).toBe(1);
        expect(b?.seq).toBe(2);
        expect(a?.timestampMs).toBeGreaterThan(0);
        expect(b!.timestampMs).toBeGreaterThan(a!.timestampMs);
        // Codex round-4 #5: the wire payload only transmits whole epoch
        // SECONDS (lib/push/apns.ts does Math.floor(ms/1000)) — ActivityKit
        // orders updates by that transmitted value, so two allocations that
        // merely differ by 1ms would collapse to the identical second and
        // sort as simultaneous/out-of-order on device. Assert the actual
        // transmitted unit is strictly increasing, not just the raw ms.
        expect(Math.floor(b!.timestampMs / 1000)).toBeGreaterThan(Math.floor(a!.timestampMs / 1000));
      });

      it("recordLiveActivitySend's CAS on last_seq rejects a stale bookkeeping write", async () => {
        await store.upsertLiveActivity(baseInput());
        const seqA = (await store.allocateLiveActivitySeq("act-1", NOW))?.seq;
        const seqB = (await store.allocateLiveActivitySeq("act-1", NOW))?.seq;
        await store.recordLiveActivitySend("act-1", {
          timestamp: NOW + 2000,
          status: 200,
          hash: "from-b",
          seq: seqB!,
        });
        await store.recordLiveActivitySend("act-1", {
          timestamp: NOW + 1000,
          status: 200,
          hash: "from-a",
          seq: seqA!,
        });
        const row = (await store.listLiveActivitiesForDevice("dev-1"))[0];
        expect(row.lastStateHash).toBe("from-b");
        expect(row.lastSeq).toBe(2);
      });
    });

    it("purgeLiveActivities deletes only ended rows past the cutoff", async () => {
      // Two different devices — one active row per device each, since
      // `idx_live_activities_active_device` is now a real uniqueness
      // constraint (Codex review #4): two 'active' rows for the SAME device
      // is exactly what it exists to forbid.
      await store.upsertLiveActivity(baseInput({ activityId: "active", deviceId: "dev-1", pushToken: "a".repeat(64) }));
      await store.upsertLiveActivity(baseInput({ activityId: "ended", deviceId: "dev-2", pushToken: "b".repeat(64) }));
      await store.markLiveActivityEnded("ended", "user", NOW);
      const deleted = await store.purgeLiveActivities(NOW + 10 * HOUR);
      expect(deleted).toBe(1);
      const remaining = await store.listLiveActivitiesForDevice("dev-1");
      expect(remaining.map((r) => r.activityId)).toEqual(["active"]);
    });
  });
});
