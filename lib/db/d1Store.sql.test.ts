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

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import type { BeachHourlyRow, CamObservationRow, CamReadRow, SunEventPredictionRow } from "@/lib/history/types";
import {
  ABANDONED_CLAIM_MS as COMING_UP_ABANDONED_CLAIM_MS,
  COMING_UP_24H_MS,
  COMING_UP_30D_MS,
} from "@/lib/db/comingUpClaims";
import { ABANDONED_CLAIM_MS } from "@/lib/db/sendClaims";
import { observationRow, predictionRow } from "@/lib/sunObservations.fixtures";

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

  // --- round-5 item 1: updated_at is strictly monotonic per row, never a
  // plain `?now` on any UPDATE path --------------------------------------
  // Real SQL only — the in-memory store's own `Math.max` in JS can't catch a
  // typo'd `MAX(...)` SQL expression, or a bind position that quietly went
  // back to plain `?now`, the way running the actual statement can.
  describe("updated_at is strictly monotonic per device row (round-5 item 1)", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("two writes at the SAME wall-clock `now` still produce a strictly increasing updated_at", async () => {
      vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      const d1 = await store.upsertDevice("mono-1", { tz: "America/New_York" });
      expect(d1.updatedAt).toBe(1_000_000);

      // A second write at the EXACT same millisecond (Date.now() still
      // stubbed to the same value) — without the fix this would write
      // updated_at = 1_000_000 again, indistinguishable from the first.
      const d2 = await store.upsertDevice("mono-1", { tz: "America/Chicago" });
      expect(d2.updatedAt).toBe(1_000_001);
      expect(d2.updatedAt).toBeGreaterThan(d1.updatedAt);
    });

    it("a write whose `now` is EARLIER than the row's current updated_at still increases it by 1", async () => {
      vi.spyOn(Date, "now").mockReturnValue(2_000_000);
      const d1 = await store.upsertDevice("mono-2", { tz: "America/New_York" });
      expect(d1.updatedAt).toBe(2_000_000);

      // The wall clock moved BACKWARDS (an NTP adjustment, say) before the
      // next write reaches this row.
      vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      const d2 = await store.upsertDevice("mono-2", { tz: "America/Chicago" });
      expect(d2.updatedAt).toBe(2_000_001); // MAX(prior + 1, now) — now lost
      expect(d2.updatedAt).toBeGreaterThan(d1.updatedAt);
    });

    it("holds for claimTrial's own UPDATE too, not just the main upsert", async () => {
      vi.spyOn(Date, "now").mockReturnValue(3_000_000);
      const d1 = await store.upsertDevice("mono-3", { tz: "America/New_York" });
      expect(d1.updatedAt).toBe(3_000_000);
      const claimed = await store.claimTrial("mono-3", 3_000_000 + 3 * DAY);
      expect(claimed).not.toBe("trial-used");
      const d2 = await store.getDevice("mono-3");
      expect(d2?.updatedAt).toBe(3_000_001); // same `now` as the upsert above
    });

    it("holds for patchSent's own UPDATE too", async () => {
      vi.spyOn(Date, "now").mockReturnValue(4_000_000);
      const d1 = await store.upsertDevice("mono-4", { tz: "America/New_York" });
      expect(d1.updatedAt).toBe(4_000_000);
      await store.patchSent("mono-4", { morningDate: "2026-09-02" });
      const d2 = await store.getDevice("mono-4");
      expect(d2?.updatedAt).toBe(4_000_001);
    });

    // Round-6: setPresence/clearPresence write ONLY the `presence` table —
    // no column on `devices` itself changes — yet the `DeviceRecord` they
    // hand back (via a separate getDevice, the route's own pattern) DOES
    // change (its `presence` field). Without also bumping the OWNING
    // device row's `updated_at` in the same batch, `isStaleDeviceResponse`
    // would see the same revision as before and the phone would drop an
    // arm/disarm response that's actually carrying fresh state — exactly
    // the regression this round fixes.
    it("setPresence bumps the OWNING device row's updated_at, even though only the presence table's own columns changed", async () => {
      vi.spyOn(Date, "now").mockReturnValue(5_000_000);
      const d1 = await store.upsertDevice("mono-5", { tz: "America/New_York" });
      expect(d1.updatedAt).toBe(5_000_000);

      await store.setPresence("mono-5", {
        slug: "boca-raton",
        lat: 26.35,
        lon: -80.08,
        accuracyM: 10,
        fixAt: 5_000_000,
        armedUntil: 5_000_000 + 3600_000,
        source: "manual",
      });
      const d2 = await store.getDevice("mono-5");
      expect(d2?.updatedAt).toBe(5_000_001);
      expect(d2?.presence?.slug).toBe("boca-raton");

      // A second arm at the SAME `now` (a fast re-arm) must still advance —
      // same monotonic guarantee every other writer gets.
      await store.setPresence("mono-5", {
        slug: "boca-raton",
        lat: null,
        lon: null,
        accuracyM: null,
        fixAt: null,
        armedUntil: 5_000_000 + 7200_000,
        source: "manual",
      });
      const d3 = await store.getDevice("mono-5");
      expect(d3?.updatedAt).toBe(5_000_002);
    });

    it("clearPresence bumps the OWNING device row's updated_at too", async () => {
      vi.spyOn(Date, "now").mockReturnValue(6_000_000);
      await store.upsertDevice("mono-6", { tz: "America/New_York" });
      await store.setPresence("mono-6", {
        slug: "boca-raton",
        lat: null,
        lon: null,
        accuracyM: null,
        fixAt: null,
        armedUntil: 6_000_000 + 3600_000,
        source: "manual",
      });
      const armed = await store.getDevice("mono-6");
      expect(armed?.updatedAt).toBe(6_000_001);
      expect(armed?.presence).not.toBeNull();

      await store.clearPresence("mono-6");
      const disarmed = await store.getDevice("mono-6");
      expect(disarmed?.presence).toBeNull();
      expect(disarmed?.updatedAt).toBe(6_000_002);
      expect(disarmed?.updatedAt).toBeGreaterThan(armed!.updatedAt);
    });
  });

  // --- sun-color alert settings (migrations/0012_sun_color_prefs.sql) ------
  // Two plain nullable columns, appended to UPSERT_DEVICE's positional binds
  // (?28/?29, present-flags ?30/?31) without renumbering ?1..?27 — this is
  // the real SQL text against real SQLite, so a mistake in that append would
  // fail here even though the in-memory store (a plain JS object patch)
  // could never catch it.
  describe("sun-color settings (real SQL, not the in-memory model)", () => {
    it("a brand-new row reads back the defaults (NULL columns)", async () => {
      await store.upsertDevice("sc1", {});
      const dev = await store.getDevice("sc1");
      expect(dev?.sunColor).toEqual({ minBand: "vivid", leadMin: 60 });
    });

    it("persists a chosen threshold and lead time", async () => {
      await store.upsertDevice("sc2", { sunColorMinBand: "epic", sunColorLeadMin: 180 });
      const dev = await store.getDevice("sc2");
      expect(dev?.sunColor).toEqual({ minBand: "epic", leadMin: 180 });
    });

    it("an unrelated write afterward leaves the sun-color columns untouched", async () => {
      await store.upsertDevice("sc3", { sunColorMinBand: "epic", sunColorLeadMin: 30 });
      await store.upsertDevice("sc3", { tz: "America/New_York" });
      const dev = await store.getDevice("sc3");
      expect(dev?.sunColor).toEqual({ minBand: "epic", leadMin: 30 });
    });

    it("two concurrent writes to different sun-color fields both persist (the ?30/?31 present-flag guards)", async () => {
      await store.upsertDevice("sc4", {});
      await Promise.all([
        store.upsertDevice("sc4", { sunColorMinBand: "epic" }),
        store.upsertDevice("sc4", { sunColorLeadMin: 120 }),
      ]);
      const dev = await store.getDevice("sc4");
      expect(dev?.sunColor).toEqual({ minBand: "epic", leadMin: 120 });
    });

    it("null resets a column back to NULL (the default), a real UPDATE ... = NULL, not a no-op", async () => {
      await store.upsertDevice("sc5", { sunColorMinBand: "epic", sunColorLeadMin: 180 });
      await store.upsertDevice("sc5", { sunColorMinBand: null, sunColorLeadMin: null });
      const dev = await store.getDevice("sc5");
      expect(dev?.sunColor).toEqual({ minBand: "vivid", leadMin: 60 });
    });
  });

  // --- releaseSend (migrations/0004_send_claims.sql) — real SQL DELETE ------
  describe("releaseSend / markSent — ownership-safe (round-2 item 1)", () => {
    it("deletes an unsent claim so it can be re-claimed immediately", async () => {
      const now = Date.now();
      expect(await store.claimSend("k1", now)).toBe(true);
      expect(await store.claimSend("k1", now + 1)).toBe(false); // still held, not abandoned
      expect(await store.releaseSend("k1", now)).toBe(true);
      expect(await store.claimSend("k1", now + 2)).toBe(true); // free again, no wait for ABANDONED_CLAIM_MS
    });

    it("never undoes a claim already marked sent", async () => {
      const now = Date.now();
      await store.claimSend("k2", now);
      expect(await store.markSent("k2", now)).toBe(true);
      expect(await store.releaseSend("k2", now)).toBe(false); // no match — already sent
      // Still "sent" — a fresh claim attempt must fail exactly as it would
      // for any other confirmed send (not abandoned, not unsent).
      expect(await store.claimSend("k2", now + 2)).toBe(false);
    });

    it("releasing a claim nobody holds is a harmless no-op, returning false", async () => {
      expect(await store.releaseSend("k-never-claimed", Date.now())).toBe(false);
    });

    it("markSent on a key nobody claimed is a harmless no-op, returning false", async () => {
      expect(await store.markSent("k-never-claimed", Date.now())).toBe(false);
    });

    it("a stale caller's release/markSent never touches a claim a LATER run has since reclaimed", async () => {
      // A claims at t0 and then crashes (never completes).
      const t0 = Date.now();
      expect(await store.claimSend("k3", t0)).toBe(true);

      // B reclaims the abandoned claim at t0 + ABANDONED_CLAIM_MS + 1 —
      // this stamps a NEW claimed_at, which is B's own ownership token.
      const t1 = t0 + ABANDONED_CLAIM_MS + 1;
      expect(await store.claimSend("k3", t1)).toBe(true);

      // A (unaware it was reclaimed) finally gets around to releasing its
      // OWN stale claim, using its OWN original token (t0) — this must NOT
      // delete B's live row.
      expect(await store.releaseSend("k3", t0)).toBe(false);

      // B's claim is still live and can be marked sent normally.
      expect(await store.markSent("k3", t1)).toBe(true);

      // A stale release attempt with A's OLD token, now that B's row is
      // SENT, still correctly fails to match (belt and suspenders: wrong
      // token AND already sent).
      expect(await store.releaseSend("k3", t0)).toBe(false);
    });

    it("a stale caller's markSent never marks a claim a LATER run has since reclaimed", async () => {
      const t0 = Date.now();
      expect(await store.claimSend("k4", t0)).toBe(true);
      const t1 = t0 + ABANDONED_CLAIM_MS + 1;
      expect(await store.claimSend("k4", t1)).toBe(true); // B reclaims

      // A's belated markSent, with A's stale token, must not succeed —
      // it would otherwise mark B's still-in-flight claim "sent" under A's
      // send, which never actually confirmed anything for THIS claim.
      expect(await store.markSent("k4", t0)).toBe(false);
      // B's own markSent, with the correct current token, still works.
      expect(await store.markSent("k4", t1)).toBe(true);
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

  // --- hourlyHistory — real SELECT (Plus "Last 7 days" feature) -------------
  describe("hourlyHistory — real SELECT against beach_hourly", () => {
    function hourlyRow(over: Partial<BeachHourlyRow> = {}): BeachHourlyRow {
      return {
        slug: "boca-raton",
        hour_utc: "2026-09-22T14:00:00.000Z",
        snapshot_generated_at: "2026-09-22T14:05:00.000Z",
        archived_at: "2026-09-22T14:05:01.000Z",
        local_date: "2026-09-22",
        local_hour: 10,
        utc_offset_minutes: -240,
        timezone: "America/New_York",
        score: 80,
        raw_score: 80,
        rating: "Good",
        available_weight: 1,
        observed_weight: 0.2,
        coverage_tier: "full",
        air_temp_f: 85,
        water_temp_f: 84,
        sand_temp_f: 95,
        wave_ft: 2,
        surf_ft: null,
        wave_source: "model",
        wind_mph: 8,
        gust_mph: 12,
        uv: 6,
        cloud_pct: 10,
        rain_now: 0,
        lightning_near: 0,
        tide_state: "rising",
        crowd_pct: null,
        seaweed_pct: 5,
        seaweed_level: "low",
        clarity_pct: null,
        engine_version: "test-1",
        scoring_config_version: "test-1",
        build_sha: "abc123",
        row_kind: "snapshot",
        archive_reason: "cron",
        caps_json: "[]",
        factors_json: "[]",
        missing_json: "[]",
        extra_json: null,
        ...over,
      };
    }

    it("returns only this slug's snapshot rows on/after sinceLocalDate, oldest first", async () => {
      await store.upsertBeachHourly(
        hourlyRow({ hour_utc: "2026-09-22T14:00:00.000Z", local_date: "2026-09-22", score: 70 }),
      );
      await store.upsertBeachHourly(
        hourlyRow({ hour_utc: "2026-09-23T14:00:00.000Z", local_date: "2026-09-23", score: 80 }),
      );
      // Before the window — excluded.
      await store.upsertBeachHourly(
        hourlyRow({ hour_utc: "2026-09-20T14:00:00.000Z", local_date: "2026-09-20", score: 60 }),
      );
      // A different beach — excluded regardless of date.
      await store.upsertBeachHourly(
        hourlyRow({ slug: "deerfield-beach", hour_utc: "2026-09-23T15:00:00.000Z", local_date: "2026-09-23" }),
      );

      const rows = await store.hourlyHistory("boca-raton", "2026-09-21", "2026-09-30");
      expect(rows.map((r) => r.hour_utc)).toEqual([
        "2026-09-22T14:00:00.000Z",
        "2026-09-23T14:00:00.000Z",
      ]);
      expect(rows.every((r) => r.slug === "boca-raton")).toBe(true);
    });

    it("excludes rows after untilLocalDate — both bounds are real, not just the lower one", async () => {
      await store.upsertBeachHourly(hourlyRow({ hour_utc: "2026-09-22T14:00:00.000Z", local_date: "2026-09-22" }));
      await store.upsertBeachHourly(hourlyRow({ hour_utc: "2026-09-23T14:00:00.000Z", local_date: "2026-09-23" }));
      const rows = await store.hourlyHistory("boca-raton", "2026-09-01", "2026-09-22");
      expect(rows.map((r) => r.local_date)).toEqual(["2026-09-22"]);
    });

    it("excludes cam-backfill rows — they never have a score", async () => {
      await store.upsertBeachHourly(
        hourlyRow({ hour_utc: "2026-09-22T14:00:00.000Z", row_kind: "snapshot", score: 70 }),
      );
      await store.upsertBeachHourly(
        hourlyRow({ hour_utc: "2026-09-22T15:00:00.000Z", row_kind: "cam-backfill", score: null }),
      );
      const rows = await store.hourlyHistory("boca-raton", "2026-09-22", "2026-09-30");
      expect(rows).toHaveLength(1);
      expect(rows[0].row_kind).toBe("snapshot");
    });

    it("an unknown slug with no rows returns an empty array", async () => {
      expect(await store.hourlyHistory("nowhere", "2026-09-01", "2026-09-30")).toEqual([]);
    });
  });

  // --- historyRecords — real UNION ALL query (Plus "Last N days" feature) ---
  describe("historyRecords — real UNION ALL against beach_hourly", () => {
    function hourlyRow(over: Partial<BeachHourlyRow> = {}): BeachHourlyRow {
      return {
        slug: "boca-raton",
        hour_utc: "2026-09-22T14:00:00.000Z",
        snapshot_generated_at: "2026-09-22T14:05:00.000Z",
        archived_at: "2026-09-22T14:05:01.000Z",
        local_date: "2026-09-22",
        local_hour: 10,
        utc_offset_minutes: -240,
        timezone: "America/New_York",
        score: 80,
        raw_score: 80,
        rating: "Good",
        available_weight: 1,
        observed_weight: 0.2,
        coverage_tier: "full",
        air_temp_f: 85,
        water_temp_f: 84,
        sand_temp_f: 95,
        wave_ft: 2,
        surf_ft: null,
        wave_source: "model",
        wind_mph: 8,
        gust_mph: 12,
        uv: 6,
        cloud_pct: 10,
        rain_now: 0,
        lightning_near: 0,
        tide_state: "rising",
        crowd_pct: null,
        seaweed_pct: 5,
        seaweed_level: "low",
        clarity_pct: null,
        engine_version: "test-1",
        scoring_config_version: "test-1",
        build_sha: "abc123",
        row_kind: "snapshot",
        archive_reason: "cron",
        caps_json: "[]",
        factors_json: "[]",
        missing_json: "[]",
        extra_json: null,
        ...over,
      };
    }

    it("the UNION ALL runs against real SQLite and returns the winning row per kind", async () => {
      await store.upsertBeachHourly(
        hourlyRow({ hour_utc: "2026-09-20T14:00:00.000Z", local_date: "2026-09-20", local_hour: 10, score: 60, sand_temp_f: 90, surf_ft: 1.0, crowd_pct: 50 }),
      );
      await store.upsertBeachHourly(
        hourlyRow({ hour_utc: "2026-09-26T18:00:00.000Z", local_date: "2026-09-26", local_hour: 14, score: 88, sand_temp_f: 137, surf_ft: 2.2, crowd_pct: 55 }),
      );
      await store.upsertBeachHourly(
        hourlyRow({ hour_utc: "2026-09-27T16:00:00.000Z", local_date: "2026-09-27", local_hour: 12, score: 50, sand_temp_f: 120, surf_ft: 3.2, crowd_pct: 40 }),
      );
      await store.upsertBeachHourly(
        hourlyRow({ hour_utc: "2026-09-28T14:00:00.000Z", local_date: "2026-09-28", local_hour: 10, score: 77, sand_temp_f: 98, surf_ft: 1.2, crowd_pct: 15 }),
      );

      const result = await store.historyRecords("boca-raton", "test-1");
      const byKind = Object.fromEntries(result.records.map((r) => [r.kind, r]));
      expect(byKind.best).toMatchObject({ local_date: "2026-09-26", local_hour: 14, value: 88 });
      expect(byKind.hottest_sand).toMatchObject({ local_date: "2026-09-26", local_hour: 14, value: 137 });
      expect(byKind.biggest_surf).toMatchObject({ local_date: "2026-09-27", local_hour: 12, value: 3.2 });
      expect(byKind.quietest).toMatchObject({ local_date: "2026-09-28", local_hour: 10, value: 15 });
      expect(result.archiveStartedAt).toBe("2026-09-20");
      expect(result.dayCount).toBe(4);
      // Every row here has a surf_ft value, including the earliest.
      expect(result.surfSince).toBe("2026-09-20");
    });

    it("surfSince (real MIN(CASE...) aggregate) is later than archiveStartedAt when older rows predate the surf estimate", async () => {
      await store.upsertBeachHourly(
        hourlyRow({ hour_utc: "2026-09-20T14:00:00.000Z", local_date: "2026-09-20", surf_ft: null }),
      );
      await store.upsertBeachHourly(
        hourlyRow({ hour_utc: "2026-09-21T14:00:00.000Z", local_date: "2026-09-21", surf_ft: null }),
      );
      await store.upsertBeachHourly(
        hourlyRow({ hour_utc: "2026-09-22T14:00:00.000Z", local_date: "2026-09-22", surf_ft: 2.5 }),
      );
      const result = await store.historyRecords("boca-raton", "test-1");
      expect(result.archiveStartedAt).toBe("2026-09-20");
      expect(result.surfSince).toBe("2026-09-22");
    });

    it("surfSince is null when no row has ever had a surf_ft value", async () => {
      await store.upsertBeachHourly(
        hourlyRow({ hour_utc: "2026-09-22T14:00:00.000Z", local_date: "2026-09-22", surf_ft: null }),
      );
      const result = await store.historyRecords("boca-raton", "test-1");
      expect(result.surfSince).toBeNull();
      expect(result.records.find((r) => r.kind === "biggest_surf")).toBeUndefined();
    });

    it("'quietest' only considers local_hour 10-18", async () => {
      await store.upsertBeachHourly(
        hourlyRow({ hour_utc: "2026-09-22T07:00:00.000Z", local_date: "2026-09-22", local_hour: 3, crowd_pct: 1 }),
      );
      await store.upsertBeachHourly(
        hourlyRow({ hour_utc: "2026-09-22T14:00:00.000Z", local_date: "2026-09-22", local_hour: 10, crowd_pct: 20 }),
      );
      const result = await store.historyRecords("boca-raton", "test-1");
      const quiet = result.records.find((r) => r.kind === "quietest");
      expect(quiet).toMatchObject({ local_hour: 10, value: 20 });
    });

    it("ties break to the earliest hour_utc (ORDER BY value, hour_utc ASC)", async () => {
      await store.upsertBeachHourly(
        hourlyRow({ hour_utc: "2026-09-23T14:00:00.000Z", local_date: "2026-09-23", local_hour: 10, score: 90 }),
      );
      await store.upsertBeachHourly(
        hourlyRow({ hour_utc: "2026-09-22T14:00:00.000Z", local_date: "2026-09-22", local_hour: 10, score: 90 }),
      );
      const result = await store.historyRecords("boca-raton", "test-1");
      const best = result.records.find((r) => r.kind === "best");
      expect(best).toMatchObject({ local_date: "2026-09-22" });
    });

    it("is NOT bounded by any window — a reading far outside 30 days still wins", async () => {
      await store.upsertBeachHourly(
        hourlyRow({ hour_utc: "2026-08-19T14:00:00.000Z", local_date: "2026-08-19", local_hour: 10, score: 99 }),
      );
      await store.upsertBeachHourly(
        hourlyRow({ hour_utc: "2026-09-28T14:00:00.000Z", local_date: "2026-09-28", local_hour: 10, score: 70 }),
      );
      const result = await store.historyRecords("boca-raton", "test-1");
      const best = result.records.find((r) => r.kind === "best");
      expect(best).toMatchObject({ local_date: "2026-08-19", value: 99 });
    });

    it("a beach with no rows at all returns no records and a null archiveStartedAt", async () => {
      const result = await store.historyRecords("nowhere-beach", "test-1");
      expect(result).toEqual({ records: [], archiveStartedAt: null, dayCount: 0, surfSince: null });
    });

    // Score-ranked records compete within ONE formula version (a score is a
    // formula output). Measurements rank across every version.
    describe("one formula per score record — the version-bound SQL", () => {
      const OLD = "2026-10-06.1";
      const NEW = "2026-10-09.1";
      async function seed() {
        await store.upsertBeachHourly(
          hourlyRow({ hour_utc: "2026-10-07T16:00:00.000Z", local_date: "2026-10-07", local_hour: 12, score: 95, engine_version: OLD, sand_temp_f: 140, surf_ft: 4.0 }),
        );
        await store.upsertBeachHourly(
          hourlyRow({ hour_utc: "2026-10-10T16:00:00.000Z", local_date: "2026-10-10", local_hour: 12, score: 82, engine_version: NEW, sand_temp_f: 100, surf_ft: 1.0 }),
        );
      }

      it("'best' ranks only rows of the bound version and returns that row's version", async () => {
        await seed();
        const best = (await store.historyRecords("boca-raton", NEW)).records.find((r) => r.kind === "best");
        expect(best).toMatchObject({ local_date: "2026-10-10", value: 82, engine_version: NEW });
        const old = (await store.historyRecords("boca-raton", OLD)).records.find((r) => r.kind === "best");
        expect(old).toMatchObject({ local_date: "2026-10-07", value: 95, engine_version: OLD });
      });

      it("measurements still rank across every version", async () => {
        await seed();
        const { records } = await store.historyRecords("boca-raton", NEW);
        expect(records.find((r) => r.kind === "hottest_sand")).toMatchObject({ value: 140, engine_version: OLD });
        expect(records.find((r) => r.kind === "biggest_surf")).toMatchObject({ value: 4.0, engine_version: OLD });
      });

      it("falls back to the latest scored row's version when no row has the bound version", async () => {
        await seed();
        const best = (await store.historyRecords("boca-raton", "2026-12-01.1")).records.find((r) => r.kind === "best");
        expect(best).toMatchObject({ value: 82, engine_version: NEW });
      });

      it("the fallback ignores a row with a null score and other beaches' rows", async () => {
        await seed();
        await store.upsertBeachHourly(
          hourlyRow({ hour_utc: "2026-10-12T16:00:00.000Z", local_date: "2026-10-12", score: null, engine_version: "2026-12-01.1" }),
        );
        await store.upsertBeachHourly(
          hourlyRow({ slug: "gulf-shores", hour_utc: "2026-10-13T16:00:00.000Z", local_date: "2026-10-13", score: 99, engine_version: "2026-12-01.1" }),
        );
        const best = (await store.historyRecords("boca-raton", "2026-12-05.1")).records.find((r) => r.kind === "best");
        expect(best).toMatchObject({ value: 82, engine_version: NEW });
      });

      it("a beach with rows of no version at all still returns no best record", async () => {
        const result = await store.historyRecords("nowhere-beach", NEW);
        expect(result.records).toEqual([]);
      });

      it("historyBestEver ranks only the bound version across every beach", async () => {
        await seed();
        await store.upsertBeachHourly(
          hourlyRow({ slug: "gulf-shores", hour_utc: "2026-10-11T16:00:00.000Z", local_date: "2026-10-11", score: 90, engine_version: NEW }),
        );
        expect(await store.historyBestEver(NEW)).toMatchObject({ slug: "gulf-shores", score: 90, engine_version: NEW });
        expect(await store.historyBestEver(OLD)).toMatchObject({ slug: "boca-raton", score: 95, engine_version: OLD });
      });

      it("historyBestEver falls back to the latest scored row's version when none has the bound one", async () => {
        await seed();
        expect(await store.historyBestEver("2026-12-01.1")).toMatchObject({ score: 82, engine_version: NEW });
      });
    });

    // "Best day ever" — the ONE statement that spans every beach.
    describe("historyBestEver — one real statement across every beach", () => {
      it("returns null on an empty archive", async () => {
        expect(await store.historyBestEver("test-1")).toBeNull();
      });

      it("picks the highest score across ALL beaches, with its beach, local date and local hour", async () => {
        await store.upsertBeachHourly(
          hourlyRow({ hour_utc: "2026-09-26T18:00:00.000Z", local_date: "2026-09-26", local_hour: 14, score: 88 }),
        );
        await store.upsertBeachHourly(
          hourlyRow({
            slug: "gulf-shores",
            hour_utc: "2026-09-29T18:00:00.000Z",
            local_date: "2026-09-29",
            local_hour: 13,
            timezone: "America/Chicago",
            score: 98,
          }),
        );
        await store.upsertBeachHourly(
          hourlyRow({ slug: "deerfield-beach", hour_utc: "2026-09-27T16:00:00.000Z", local_date: "2026-09-27", local_hour: 12, score: 91 }),
        );
        expect(await store.historyBestEver("test-1")).toEqual({
          slug: "gulf-shores",
          local_date: "2026-09-29",
          local_hour: 13,
          score: 98,
          engine_version: "test-1",
        });
      });

      it("ties break to the earliest hour_utc, whichever beach it is", async () => {
        await store.upsertBeachHourly(
          hourlyRow({ slug: "gulf-shores", hour_utc: "2026-09-29T18:00:00.000Z", local_date: "2026-09-29", local_hour: 13, score: 95 }),
        );
        await store.upsertBeachHourly(
          hourlyRow({ slug: "boca-raton", hour_utc: "2026-09-25T15:00:00.000Z", local_date: "2026-09-25", local_hour: 11, score: 95 }),
        );
        const best = await store.historyBestEver("test-1");
        expect(best).toMatchObject({ slug: "boca-raton", local_date: "2026-09-25", local_hour: 11, score: 95 });
      });

      it("ignores rows with a null score and any non-snapshot row", async () => {
        await store.upsertBeachHourly(
          hourlyRow({ hour_utc: "2026-09-22T14:00:00.000Z", local_date: "2026-09-22", score: 70 }),
        );
        await store.upsertBeachHourly(
          hourlyRow({ hour_utc: "2026-09-22T15:00:00.000Z", local_date: "2026-09-22", row_kind: "snapshot", score: null }),
        );
        // A cam-backfill row carrying a (hypothetical) 100 must never win.
        await store.upsertBeachHourly(
          hourlyRow({ hour_utc: "2026-09-22T16:00:00.000Z", local_date: "2026-09-22", row_kind: "cam-backfill", score: 100 }),
        );
        expect(await store.historyBestEver("test-1")).toMatchObject({ local_date: "2026-09-22", score: 70 });
      });

      it("is not bounded by any window — the oldest row can be the record", async () => {
        await store.upsertBeachHourly(
          hourlyRow({ hour_utc: "2026-08-19T14:00:00.000Z", local_date: "2026-08-19", score: 99 }),
        );
        await store.upsertBeachHourly(
          hourlyRow({ hour_utc: "2026-09-28T14:00:00.000Z", local_date: "2026-09-28", score: 70 }),
        );
        expect(await store.historyBestEver("test-1")).toMatchObject({ local_date: "2026-08-19", score: 99 });
      });
    });
  });

  // --- sun-event prediction log (migrations/0013) — real multi-row upsert ---
  describe("sun_event_predictions — real multi-row UPSERT", () => {
  function sunRow(over: Partial<SunEventPredictionRow> = {}): SunEventPredictionRow {
    return {
      slug: "boca-raton",
      event_kind: "sunrise",
      event_iso: "2026-10-06T11:15:00.000Z",
      as_of_hour_utc: "2026-10-06T11:00:00.000Z",
      snapshot_generated_at: "2026-10-06T11:05:00.000Z",
      archived_at: "2026-10-06T11:05:01.000Z",
      lead_minutes: 10,
      score: 58,
      band: "good",
      model_path: "factor",
      note: "test note",
      breakdown_json: '{"horizonPath":"x","cloudCanvas":"y"}',
      low_cloud_pct: 0,
      mid_cloud_pct: 67,
      high_cloud_pct: 48,
      total_cloud_pct: 67,
      humidity_pct: 87,
      aod: 0.14,
      pm2_5: 13.6,
      horizon_cloud_pct: 40,
      horizon_source: "overhead",
      horizon_fresh: 1,
      seasonal_prior: 55,
      point_time: "2026-10-06T11:00:00.000Z",
      peak_color_iso: "2026-10-06T11:15:00.000Z",
      peak_offset_minutes: 0,
      algo_version: "2026-10-06.1",
      engine_version: "test-1",
      build_sha: "abc123",
      observed_score: null,
      observed_source: null,
      observed_at: null,
      ...over,
    };
  }

    it("writes a sunrise+sunset pair as ONE statement and round-trips every column", async () => {
      const rows = [
        sunRow(),
        sunRow({ event_kind: "sunset", event_iso: "2026-10-06T23:10:00.000Z", model_path: null, score: null, band: null, breakdown_json: null, horizon_source: null, horizon_fresh: null, horizon_cloud_pct: null, point_time: null }),
      ];
      expect(await store.upsertSunEventPredictions(rows)).toEqual({ written: 2 });
      const back = await store.sunEventPredictionsFor("boca-raton", "2026-10-06T11:15:00.000Z");
      expect(back).toHaveLength(1);
      const { observed_score, observed_source, observed_at, ...rest } = rows[0];
      expect(back[0]).toMatchObject(rest);
      expect([observed_score, observed_source, observed_at]).toEqual([null, null, null]);
      const set = await store.sunEventPredictionsFor("boca-raton", "2026-10-06T23:10:00.000Z");
      expect(set[0].score).toBeNull();
      expect(set[0].model_path).toBeNull();
    });

    it("an older or equal snapshot never regresses a row; a newer one replaces it but leaves observed_* alone", async () => {
      const raw = freshRawDb() as D1Like;
      const s = d1Store(raw);
      await s.upsertSunEventPredictions([sunRow()]);
      await raw
        .prepare("UPDATE sun_event_predictions SET observed_score = 88, observed_source = 'manual', observed_at = 'x'")
        .run();
      expect((await s.upsertSunEventPredictions([sunRow({ score: 1 })])).written).toBe(0);
      expect(
        (await s.upsertSunEventPredictions([sunRow({ snapshot_generated_at: "2026-10-06T11:30:00.000Z", score: 61 })])).written,
      ).toBe(1);
      const [r] = await s.sunEventPredictionsFor("boca-raton", "2026-10-06T11:15:00.000Z");
      expect(r.score).toBe(61);
      expect(r.observed_score).toBe(88);
      expect(r.observed_source).toBe("manual");
    });

    it("different as_of hours of one event are separate rows, oldest first", async () => {
      await store.upsertSunEventPredictions([sunRow({ as_of_hour_utc: "2026-10-06T10:00:00.000Z", snapshot_generated_at: "2026-10-06T10:05:00.000Z", score: 40 })]);
      await store.upsertSunEventPredictions([sunRow()]);
      const hist = await store.sunEventPredictionsFor("boca-raton", "2026-10-06T11:15:00.000Z");
      expect(hist.map((r) => r.score)).toEqual([40, 58]);
    });
  });

  // --- sun-event observations (migrations/0015) — the real SQL ---------------
  describe("sun_event_observations — upsert and the write-back onto sun_event_predictions", () => {
    const EVENT = "2026-10-06T11:15:09.672Z";
    const at = (min: number) => new Date(Date.parse(EVENT) + min * 60_000).toISOString();
    const truth = async (iso = EVENT, s: DeviceStore = store) =>
      (await s.sunEventPredictionsFor("boca-raton", iso))
        .filter((r) => r.event_kind === "sunrise")
        .map((r) => [r.observed_score, r.observed_source, r.observed_at]);

    it("round-trips every column", async () => {
      const row = observationRow({ series_json: '[{"t":"x","score":1}]' });
      expect(await store.recordSunEventObservation(row)).toEqual({ stored: true, predictionsUpdated: 0 });
      expect(await store.sunEventObservationsFor("boca-raton", "sunrise", "2026-10-06")).toEqual([row]);
    });

    it("replaces only on a newer (score_version, scored_at); a duplicate or stale replay writes nothing", async () => {
      await store.upsertSunEventPredictions([predictionRow()]);
      const first = observationRow({ observed_score: 70, scored_at: "2026-10-06T14:00:00.000Z", created_at: "2026-10-06T14:00:01.000Z" });
      expect((await store.recordSunEventObservation(first)).stored).toBe(true);

      // exact duplicate (even with a later created_at): meta.changes = 0, nothing propagates
      expect(await store.recordSunEventObservation({ ...first, created_at: "2026-10-06T15:00:00.000Z" })).toEqual({ stored: false, predictionsUpdated: 0 });
      // same version, older scored_at; older version, later scored_at; same pair, different content
      expect((await store.recordSunEventObservation({ ...first, observed_score: 5, scored_at: "2026-10-06T13:00:00.000Z" })).stored).toBe(false);
      expect((await store.recordSunEventObservation({ ...first, observed_score: 6, score_version: "2026-10-05.9", scored_at: "2026-10-06T16:00:00.000Z" })).stored).toBe(false);
      expect((await store.recordSunEventObservation({ ...first, observed_score: 7 })).stored).toBe(false);
      expect((await store.sunEventObservationsFor("boca-raton", "sunrise", "2026-10-06"))[0]).toEqual(first);
      expect(await truth()).toEqual([[70, "sun-cam:deerfield-beach-cam:solar", "2026-10-06T14:00:00.000Z"]]);

      // a real re-score replaces everything but created_at, and propagates once
      const r = await store.recordSunEventObservation({ ...first, observed_score: 91, series_json: "[1]", scored_at: "2026-10-06T14:30:00.000Z", created_at: "2026-10-06T14:30:01.000Z" });
      expect(r).toEqual({ stored: true, predictionsUpdated: 1 });
      expect((await store.sunEventObservationsFor("boca-raton", "sunrise", "2026-10-06"))[0]).toMatchObject({
        observed_score: 91,
        series_json: "[1]",
        scored_at: "2026-10-06T14:30:00.000Z",
        created_at: "2026-10-06T14:00:01.000Z",
      });
      expect(await truth()).toEqual([[91, "sun-cam:deerfield-beach-cam:solar", "2026-10-06T14:30:00.000Z"]]);
    });

    it("score_version orders by date, then the counter as a NUMBER ('.10' beats '.9')", async () => {
      const row = (v: string, scored: string) => observationRow({ score_version: v, scored_at: scored, observed_score: 50 });
      await store.recordSunEventObservation(row("2026-10-06.9", "2026-10-06T14:00:00.000Z"));
      expect((await store.recordSunEventObservation(row("2026-10-06.10", "2026-10-06T13:00:00.000Z"))).stored).toBe(true);
      expect((await store.recordSunEventObservation(row("2026-10-06.9", "2026-10-06T15:00:00.000Z"))).stored).toBe(false);
      expect((await store.recordSunEventObservation(row("2026-10-07.1", "2026-10-06T12:00:00.000Z"))).stored).toBe(true);
      expect((await store.recordSunEventObservation(row("2026-10-06.99", "2026-10-06T18:00:00.000Z"))).stored).toBe(false);
      expect((await store.sunEventObservationsFor("boca-raton", "sunrise", "2026-10-06"))[0].score_version).toBe("2026-10-07.1");
    });

    it("a stale replay leaves the prediction rows alone, but heals rows an earlier crash never filled", async () => {
      await store.recordSunEventObservation(observationRow({ observed_score: 80 })); // stored with no prediction row yet
      await store.upsertSunEventPredictions([predictionRow()]);
      expect(await truth()).toEqual([[null, null, null]]);
      // the same payload is retried: the observation is a duplicate (not stored) but the idempotent write-back fills the row
      expect(await store.recordSunEventObservation(observationRow({ observed_score: 80 }))).toEqual({ stored: false, predictionsUpdated: 1 });
      expect(await truth()).toEqual([[80, "sun-cam:deerfield-beach-cam:solar", "2026-10-06T14:05:00.000Z"]]);
      expect((await store.recordSunEventObservation(observationRow({ observed_score: 80 }))).predictionsUpdated).toBe(0);
    });

    it("orders solar before antisolar, then nearest, then cam_id", async () => {
      await store.recordSunEventObservation(observationRow({ cam_id: "z-cam", view: "antisolar", distance_mi: 0 }));
      await store.recordSunEventObservation(observationRow({ cam_id: "b-cam", view: "solar", distance_mi: 2.9 }));
      await store.recordSunEventObservation(observationRow({ cam_id: "a-cam", view: "solar", distance_mi: 2.9 }));
      await store.recordSunEventObservation(observationRow({ cam_id: "c-cam", view: "solar", distance_mi: 0.5 }));
      const order = (await store.sunEventObservationsFor("boca-raton", "sunrise", "2026-10-06")).map((r) => r.cam_id);
      expect(order).toEqual(["c-cam", "a-cam", "b-cam", "z-cam"]);
    });

    it("fills the matching prediction rows (event_iso within 15 min, inclusive) and no others", async () => {
      await store.upsertSunEventPredictions([
        predictionRow({ event_iso: at(-15), as_of_hour_utc: "2026-10-06T08:00:00.000Z", snapshot_generated_at: "2026-10-06T08:05:00.000Z" }),
        predictionRow({ event_iso: EVENT, as_of_hour_utc: "2026-10-06T09:00:00.000Z", snapshot_generated_at: "2026-10-06T09:05:00.000Z" }),
        predictionRow({ event_iso: at(15), as_of_hour_utc: "2026-10-06T10:00:00.000Z", snapshot_generated_at: "2026-10-06T10:05:00.000Z" }),
        predictionRow({ event_iso: at(-16), as_of_hour_utc: "2026-10-06T07:00:00.000Z", snapshot_generated_at: "2026-10-06T07:05:00.000Z" }),
        predictionRow({ event_iso: at(16), as_of_hour_utc: "2026-10-06T06:00:00.000Z", snapshot_generated_at: "2026-10-06T06:05:00.000Z" }),
        predictionRow({ slug: "fort-lauderdale", event_iso: EVENT }),
        predictionRow({ event_kind: "sunset", event_iso: EVENT, as_of_hour_utc: "2026-10-06T05:00:00.000Z" }),
      ]);
      const r = await store.recordSunEventObservation(observationRow({ cam_id: "deerfield-beach-cam" }));
      expect(r.predictionsUpdated).toBe(3);
      for (const m of [-15, 0, 15]) {
        expect((await truth(at(m)))[0]).toEqual([90, "sun-cam:deerfield-beach-cam:solar", "2026-10-06T14:05:00.000Z"]);
      }
      expect((await truth(at(-16)))[0]).toEqual([null, null, null]);
      expect((await truth(at(16)))[0]).toEqual([null, null, null]);
      // another beach and the other kind are untouched
      expect((await store.sunEventPredictionsFor("fort-lauderdale", EVENT))[0].observed_score).toBeNull();
      const sunset = (await store.sunEventPredictionsFor("boca-raton", EVENT)).find((p) => p.event_kind === "sunset");
      expect(sunset?.observed_score).toBeNull();
      // the model's own columns are left as they were
      expect((await store.sunEventPredictionsFor("boca-raton", EVENT)).find((p) => p.event_kind === "sunrise")).toMatchObject({ score: 58, band: "good" });
    });

    it("never overwrites a solar observation with an antisolar one, in either arrival order", async () => {
      await store.upsertSunEventPredictions([predictionRow()]);
      await store.recordSunEventObservation(observationRow({ cam_id: "solar-cam", view: "solar", distance_mi: 2.9, observed_score: 85 }));
      await store.recordSunEventObservation(observationRow({ cam_id: "anti-cam", view: "antisolar", distance_mi: 0, observed_score: 30 }));
      expect(await truth()).toEqual([[85, "sun-cam:solar-cam:solar", "2026-10-06T14:05:00.000Z"]]);

      const other = freshStore() as DeviceStore;
      await other.upsertSunEventPredictions([predictionRow()]);
      await other.recordSunEventObservation(observationRow({ cam_id: "anti-cam", view: "antisolar", distance_mi: 0, observed_score: 30 }));
      expect((await truth(EVENT, other))[0][1]).toBe("sun-cam:anti-cam:antisolar");
      await other.recordSunEventObservation(observationRow({ cam_id: "solar-cam", view: "solar", distance_mi: 2.9, observed_score: 85 }));
      expect((await truth(EVENT, other))[0]).toEqual([85, "sun-cam:solar-cam:solar", "2026-10-06T14:05:00.000Z"]);
    });

    it("among solar cams the nearest wins; a tie goes to the lower cam_id; a re-score refreshes the label", async () => {
      await store.upsertSunEventPredictions([predictionRow()]);
      await store.recordSunEventObservation(observationRow({ cam_id: "pier", distance_mi: 2.9, observed_score: 50 }));
      await store.recordSunEventObservation(observationRow({ cam_id: "surf", distance_mi: 0.1, observed_score: 60 }));
      expect((await truth())[0][1]).toBe("sun-cam:surf:solar");
      await store.recordSunEventObservation(observationRow({ cam_id: "beach", distance_mi: 0.1, observed_score: 70 }));
      expect((await truth())[0]).toEqual([70, "sun-cam:beach:solar", "2026-10-06T14:05:00.000Z"]);
      await store.recordSunEventObservation(observationRow({ cam_id: "beach", distance_mi: 0.1, observed_score: 75, scored_at: "2026-10-06T16:00:00.000Z" }));
      expect((await truth())[0]).toEqual([75, "sun-cam:beach:solar", "2026-10-06T16:00:00.000Z"]);
    });

    it("leaves a hand-labelled prediction row alone", async () => {
      // upsertSunEventPredictions never writes observed_*, so label the row by hand, as an owner would
      const raw = freshRawDb() as D1Like;
      const s = d1Store(raw);
      await s.upsertSunEventPredictions([predictionRow()]);
      await raw
        .prepare("UPDATE sun_event_predictions SET observed_score = 88, observed_source = 'manual', observed_at = '2026-10-06T13:00:00.000Z'")
        .run();
      expect((await s.recordSunEventObservation(observationRow())).predictionsUpdated).toBe(0);
      expect(await truth(EVENT, s)).toEqual([[88, "manual", "2026-10-06T13:00:00.000Z"]]);
      expect(await s.sunEventObservationsFor("boca-raton", "sunrise", "2026-10-06")).toHaveLength(1);
    });

    it("the table refuses a bad kind or view (CHECK constraints) and a duplicate key is an upsert, not a second row", async () => {
      const raw = freshRawDb() as D1Like;
      const insert = (kind: string, view: string) =>
        raw
          .prepare(
            "INSERT INTO sun_event_observations (slug, event_kind, event_date_local, cam_id, event_iso, view, distance_mi, observed_score, warm_frac, colorfulness, peak_frame_iso, series_json, score_version, scored_at, credit, created_at) " +
              "VALUES ('s', ?1, '2026-10-06', 'c', 'x', ?2, 0, 1, 0, 0, 'x', '[]', '2026-10-06.1', 'x', 'c', 'x')",
          )
          .bind(kind, view)
          .run();
      await expect(insert("noon", "solar")).rejects.toThrow();
      await expect(insert("sunrise", "sideways")).rejects.toThrow();
      await insert("sunrise", "solar");
      await expect(insert("sunrise", "solar")).rejects.toThrow(); // plain INSERT collides on the primary key
    });
  });

  // --- cam archive (migrations/0006 + 0014) — real INSERT OR IGNORE ---------
  describe("cam_observations / cam_reads — real multi-row INSERT OR IGNORE", () => {
    function obs(i: number, over: Partial<CamObservationRow> = {}): CamObservationRow {
      return {
        slug: "boca-raton",
        captured_at_utc: new Date(Date.UTC(2026, 9, 6, 11, i)).toISOString(),
        crowd_pct: 10 + i,
        people: i,
        seaweed_level: "low",
        cov_pct: 5,
        clarity_pct: 70,
        water_word: "clear",
        uw_pct: null,
        source: "feed",
        raw_json: `{"i":${i}}`,
        crowd_level: "light",
        uw_level: null,
        ...over,
      };
    }
    const read = (cam: string, over: Partial<CamReadRow> = {}): CamReadRow => ({
      slug: "boca-raton",
      captured_at_utc: "2026-10-06T12:00:00.000Z",
      cam_id: cam,
      cam_name: `Cam ${cam}`,
      seaweed_level: "low",
      cov_pct: 4,
      seaweed_note: "n",
      crowd_level: "light",
      crowd_pct: 9,
      people: 3,
      crowd_note: "c",
      water_word: "clear",
      water_pct: 80,
      water_note: "w",
      raw_json: "{}",
      ...over,
    });

    it("inserts more rows than fit in one statement (100-param cap) and round-trips them", async () => {
      const rows = Array.from({ length: 20 }, (_, i) => obs(i, i === 3 ? { uw_pct: 55, uw_level: "hazy" } : {}));
      expect(await store.insertCamObservations(rows)).toEqual({ written: 20 });
      const back = await store.camObservationsSince("boca-raton", "2026-10-06T00:00:00.000Z");
      expect(back).toHaveLength(20);
      expect(back[3]).toMatchObject({ uw_pct: 55, uw_level: "hazy", crowd_level: "light", raw_json: '{"i":3}' });
      expect(await store.latestCamObservationUtc("boca-raton")).toBe(rows[19].captured_at_utc);
      expect(await store.latestCamObservationUtc("nowhere")).toBeNull();
    });

    it("is idempotent: re-inserting the same reads writes nothing and never overwrites", async () => {
      await store.insertCamObservations([obs(0), obs(1)]);
      const again = await store.insertCamObservations([obs(0, { crowd_pct: 99 }), obs(1), obs(2)]);
      expect(again).toEqual({ written: 1 });
      const back = await store.camObservationsSince("boca-raton", "2026-10-06T00:00:00.000Z");
      expect(back[0].crowd_pct).toBe(10); // the first write stands
    });

    it("camObservationUtcsSince is bounded below and per beach", async () => {
      await store.insertCamObservations([obs(0), obs(5), obs(0, { slug: "deerfield-beach" })]);
      const got = await store.camObservationUtcsSince("boca-raton", obs(3).captured_at_utc);
      expect(got).toEqual([obs(5).captured_at_utc]);
    });

    it("stores per-cam reads and ignores repeats", async () => {
      const rows = ["a", "b", "c", "d", "e", "f", "g", "h"].map((c) => read(c)); // > 6 per statement
      expect(await store.insertCamReads(rows)).toEqual({ written: 8 });
      expect(await store.insertCamReads(rows)).toEqual({ written: 0 });
      const back = await store.camReadsAt("boca-raton", "2026-10-06T12:00:00.000Z");
      expect(back.map((r) => r.cam_id)).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
      expect(back[0]).toMatchObject({ water_pct: 80, seaweed_note: "n" });
    });

    it("an empty batch is a no-op", async () => {
      expect(await store.insertCamObservations([])).toEqual({ written: 0 });
      expect(await store.insertCamReads([])).toEqual({ written: 0 });
    });
  });

  it("migration 0014 back-fills crowd_level / uw_level / uw_pct on pre-existing rows from raw_json", () => {
    const dir = path.join(process.cwd(), "migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const db = new DatabaseSyncCtor!(":memory:");
    for (const f of files.filter((f) => f < "0014")) db.exec(readFileSync(path.join(dir, f), "utf8"));
    const ins = db.prepare(
      "INSERT INTO cam_observations (slug, captured_at_utc, source, raw_json) VALUES (?, ?, 'feed', ?)",
    );
    ins.run("boca-raton", "2026-09-22T11:00:00.000Z", JSON.stringify({ level: "heavy", uw: 40, uwLevel: "hazy" }));
    ins.run("boca-raton", "2026-09-22T12:00:00.000Z", JSON.stringify({ level: "light" }));
    ins.run("boca-raton", "2026-09-22T13:00:00.000Z", "not json{");
    ins.run("boca-raton", "2026-09-22T14:00:00.000Z", null as unknown as string);
    db.exec(readFileSync(path.join(dir, files.find((f) => f.startsWith("0014"))!), "utf8"));
    const rows = db
      .prepare("SELECT captured_at_utc, crowd_level, uw_level, uw_pct FROM cam_observations ORDER BY captured_at_utc")
      .all();
    expect(rows[0]).toMatchObject({ crowd_level: "heavy", uw_level: "hazy", uw_pct: 40 });
    expect(rows[1]).toMatchObject({ crowd_level: "light", uw_level: null, uw_pct: null });
    expect(rows[2]).toMatchObject({ crowd_level: null }); // invalid JSON left alone, no error
    expect(rows[3]).toMatchObject({ crowd_level: null });
    db.close();
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

  // --- coming_up_deliveries — real atomic claim (SKY_EVENTS_PLAN.md §10) ---
  describe("coming-up alert ledger — real atomic claim/complete/release/prune", () => {
    const NOW = 2_000_000_000_000;

    it("claims a fresh event, then completeComingUp writes sent_at AND alert_log in one go", async () => {
      const claimed = await store.claimComingUp("dev-1", "eclipse:2027-03-08T06:58:00Z", "tok-1", NOW);
      expect(claimed).toBe("claimed");
      await store.completeComingUp("dev-1", "eclipse:2027-03-08T06:58:00Z", "tok-1", NOW + 1000);
      const mark = await store.lastAlert("dev-1", "eclipse:2027-03-08T06:58:00Z");
      expect(mark?.sentAt).toBe(NOW + 1000);
    });

    it("once-ever dedupe: a second claim for the SAME event fails after alert_log has the row — even after the ledger row is pruned", async () => {
      await store.claimComingUp("dev-2", "launch:uuid-1", "tok-1", NOW);
      await store.completeComingUp("dev-2", "launch:uuid-1", "tok-1", NOW);
      expect(await store.claimComingUp("dev-2", "launch:uuid-1", "tok-2", NOW + HOUR)).toBe("already-sent");
      // Prune the ledger row away (it's well past the 30-day retention) —
      // the durable alert_log record survives pruning and still blocks a
      // fresh claim for the identical event.
      await store.pruneComingUp(NOW + COMING_UP_30D_MS + DAY);
      expect(
        await store.claimComingUp("dev-2", "launch:uuid-1", "tok-3", NOW + COMING_UP_30D_MS + DAY),
      ).toBe("already-sent");
    });

    it("24-hour cap: a second DIFFERENT event within 24h is refused once one has already sent", async () => {
      await store.claimComingUp("dev-3", "tide:8722670:2027-01-01T00:00:00Z", "tok-1", NOW);
      await store.completeComingUp("dev-3", "tide:8722670:2027-01-01T00:00:00Z", "tok-1", NOW);
      expect(await store.claimComingUp("dev-3", "supermoon:2027-01-02T00:00:00Z", "tok-2", NOW + HOUR)).toBe(
        "capped",
      );
      // Outside the 24h window, the 24h cap no longer blocks it (the 30-day
      // cap, still under 3, doesn't either).
      expect(
        await store.claimComingUp("dev-3", "supermoon:2027-01-02T00:00:00Z", "tok-3", NOW + COMING_UP_24H_MS + 1),
      ).toBe("claimed");
    });

    it("30-day cap: a 4th distinct event within 30 days is refused, spaced beyond the 24h cap", async () => {
      const SPACING = COMING_UP_24H_MS + HOUR; // clears the 24h cap each time
      for (let i = 0; i < 3; i++) {
        const key = `meteor:perseids:202${i}`;
        const t = NOW + i * SPACING;
        expect(await store.claimComingUp("dev-4", key, `tok-${i}`, t)).toBe("claimed");
        await store.completeComingUp("dev-4", key, `tok-${i}`, t);
      }
      const t4 = NOW + 3 * SPACING;
      expect(await store.claimComingUp("dev-4", "meteor:geminids:2030", "tok-3", t4)).toBe("capped");
      // Past the 30-day window from the FIRST send, the oldest send ages out
      // of the cap count and a new event is claimable again.
      const t5 = NOW + COMING_UP_30D_MS + HOUR;
      expect(await store.claimComingUp("dev-4", "meteor:geminids:2030", "tok-4", t5)).toBe("claimed");
    });

    it("a live (non-abandoned) reservation cannot be reclaimed by a second caller", async () => {
      await store.claimComingUp("dev-5", "launch:uuid-2", "tok-1", NOW);
      expect(await store.claimComingUp("dev-5", "launch:uuid-2", "tok-2", NOW + 1000)).toBe("in-flight");
    });

    it("an ABANDONED reservation (unsent, past ABANDONED_CLAIM_MS) can be reclaimed with a fresh token", async () => {
      await store.claimComingUp("dev-6", "launch:uuid-3", "tok-1", NOW);
      const reclaimAt = NOW + COMING_UP_ABANDONED_CLAIM_MS + 1;
      expect(await store.claimComingUp("dev-6", "launch:uuid-3", "tok-2", reclaimAt)).toBe("claimed");
    });

    it("token race: a stale claimant (lost to a reclaim) cannot complete or release the newer claim", async () => {
      await store.claimComingUp("dev-7", "launch:uuid-4", "tok-old", NOW);
      const reclaimAt = NOW + COMING_UP_ABANDONED_CLAIM_MS + 1;
      await store.claimComingUp("dev-7", "launch:uuid-4", "tok-new", reclaimAt);
      // The stale token can neither confirm nor clear the row the new token
      // now owns.
      await store.completeComingUp("dev-7", "launch:uuid-4", "tok-old", reclaimAt + 1);
      expect(await store.lastAlert("dev-7", "launch:uuid-4")).toBeNull();
      await store.releaseComingUp("dev-7", "launch:uuid-4", "tok-old");
      // The current (new-token) reservation is still there and still
      // completable by its OWN token.
      await store.completeComingUp("dev-7", "launch:uuid-4", "tok-new", reclaimAt + 2);
      expect((await store.lastAlert("dev-7", "launch:uuid-4"))?.sentAt).toBe(reclaimAt + 2);
    });

    it("releaseComingUp frees the reservation immediately so a fresh claim succeeds right away", async () => {
      await store.claimComingUp("dev-8", "launch:uuid-5", "tok-1", NOW);
      await store.releaseComingUp("dev-8", "launch:uuid-5", "tok-1");
      expect(await store.claimComingUp("dev-8", "launch:uuid-5", "tok-2", NOW + 1)).toBe("claimed");
    });

    it("pruneComingUp deletes a SENT row past 30 days and an ABANDONED unsent row past ABANDONED_CLAIM_MS, but keeps a live reservation and a recent sent row", async () => {
      // Direct raw-DB access alongside the store, so this test can inspect
      // `coming_up_deliveries` rows directly — `alert_log`'s once-ever
      // dedupe would otherwise mask whether a SENT row's LEDGER row (as
      // opposed to its durable alert_log record) actually got pruned.
      const raw = freshRawDb();
      if (!raw) return;
      const rawStore = d1Store(raw);
      const rowExists = async (deviceId: string, eventKey: string): Promise<boolean> => {
        const row = await raw
          .prepare("SELECT 1 FROM coming_up_deliveries WHERE device_id = ? AND event_key = ?")
          .bind(deviceId, eventKey)
          .first();
        return row != null;
      };

      // Four different devices, one row each, so the 24h/30d CAP logic
      // (covered by its own tests above) can never interfere with this
      // test's only concern: which rows `pruneComingUp` removes.
      const pruneAt = NOW + 40 * DAY;

      // Sent 40 days before pruneAt → past the 30-day retention → its LEDGER
      // row is pruned (its `alert_log` record is untouched — separately
      // covered by the once-ever-after-prune test above).
      await rawStore.claimComingUp("dev-sent-old", "k", "t1", NOW);
      await rawStore.completeComingUp("dev-sent-old", "k", "t1", NOW);

      // Sent only 5 days before pruneAt → still within 30 days → kept.
      const recentSentAt = pruneAt - 5 * DAY;
      await rawStore.claimComingUp("dev-sent-recent", "k", "t2", recentSentAt);
      await rawStore.completeComingUp("dev-sent-recent", "k", "t2", recentSentAt);

      // Claimed 1 hour before pruneAt, never sent — well past
      // ABANDONED_CLAIM_MS (10 min), even though it's not otherwise "old" →
      // pruned regardless of age.
      await rawStore.claimComingUp("dev-abandoned", "k", "t3", pruneAt - HOUR);

      // Claimed 1 minute before pruneAt, never sent — still inside the
      // abandonment window → a live reservation, kept.
      await rawStore.claimComingUp("dev-still-live", "k", "t4", pruneAt - 60_000);

      await rawStore.pruneComingUp(pruneAt);

      expect(await rowExists("dev-sent-old", "k")).toBe(false);
      expect(await rowExists("dev-abandoned", "k")).toBe(false);
      expect(await rowExists("dev-sent-recent", "k")).toBe(true);
      expect(await rowExists("dev-still-live", "k")).toBe(true);
    });

    it("device deletion removes this device's coming_up_deliveries rows", async () => {
      await store.upsertDevice("dev-10", {});
      await store.claimComingUp("dev-10", "launch:uuid-6", "tok-1", NOW);
      await store.completeComingUp("dev-10", "launch:uuid-6", "tok-1", NOW);
      await store.deleteDevice("dev-10");
      // The device's own row is gone from the ledger — a fresh claim for the
      // SAME event now succeeds (alert_log was also cleared by deleteDevice,
      // same as every other per-device table).
      expect(await store.claimComingUp("dev-10", "launch:uuid-6", "tok-2", NOW + 1)).toBe("claimed");
    });
  });

  // --- patchSent — real json_patch UPDATE (Codex round-4 HIGH) -------------
  describe("patchSent — atomic partial merge via the real json_patch SQL", () => {
    it("merges a partial patch onto whatever's already there, leaving other keys untouched", async () => {
      await store.upsertDevice("dev-p1", {});
      await store.setSent("dev-p1", { safetyKey: "k", safetyAt: "2026-09-01T00:00:00Z" });
      await store.patchSent("dev-p1", { morningDate: "2026-09-02" });
      expect(await store.getSent("dev-p1")).toEqual({
        safetyKey: "k",
        safetyAt: "2026-09-01T00:00:00Z",
        morningDate: "2026-09-02",
      });
    });

    it("two overlapping calls merging DIFFERENT keys off the SAME starting state both survive — neither clobbers the other", async () => {
      await store.upsertDevice("dev-p2", {});
      expect(await store.getSent("dev-p2")).toEqual({});
      // The exact shape app/api/push/run/route.ts's per-device
      // `persistSentState()` produces when the 5-min Worker cron and the
      // hourly GitHub Actions fallback overlap — each deciding a DIFFERENT
      // field off the SAME request-start snapshot. This is the real
      // `json_patch` SQL doing the merge server-side, not a JS re-
      // implementation of it — proof the actual UPDATE statement is safe
      // under two real overlapping writes, not just the abstraction.
      await Promise.all([
        store.patchSent("dev-p2", { morningDate: "2026-09-02" }),
        store.patchSent("dev-p2", { comingUpCheckedDate: "2026-09-02" }),
      ]);
      expect(await store.getSent("dev-p2")).toEqual({
        morningDate: "2026-09-02",
        comingUpCheckedDate: "2026-09-02",
      });
    });

    it("a key set to undefined is treated as 'not mentioned', and an all-undefined patch is a no-op", async () => {
      await store.upsertDevice("dev-p3", {});
      await store.setSent("dev-p3", { morningDate: "2026-09-01" });
      await store.patchSent("dev-p3", { morningDate: undefined, comingUpCheckedDate: "2026-09-02" });
      expect(await store.getSent("dev-p3")).toEqual({ morningDate: "2026-09-01", comingUpCheckedDate: "2026-09-02" });
    });
  });
});
