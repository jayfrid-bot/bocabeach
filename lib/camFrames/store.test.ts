import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HAS_SQLITE, makeCamDb, type CamDb } from "@/lib/camFrames/testDb";
import { CLAIM_A, CLAIM_B, frameRow } from "@/lib/camFrames/testFixtures";
import {
  claimSlot,
  deletePending,
  deleteReceivedBefore,
  deleteStalePending,
  filledSlots,
  markReady,
  newestReadySha,
  purgeCamFrames,
  readSlot,
  STALE_CLAIM_MS,
} from "@/lib/camFrames/store";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-11T14:20:00.000Z");

let h: CamDb;
beforeEach(() => {
  h = makeCamDb() as CamDb;
});
afterEach(() => h?.close());

function count(where = "1=1"): number {
  return Number(h.all(`SELECT COUNT(*) AS n FROM cam_frames WHERE ${where}`)[0].n);
}

describe.skipIf(!HAS_SQLITE)("cam_frames against real SQLite", () => {
  describe("migrations 0016 and 0017", () => {
    it("has the columns, primary key and indexes the plan names", () => {
      const cols = h.all("PRAGMA table_info(cam_frames)").map((c) => c.name);
      expect(cols).toEqual([
        "slug", "cam_id", "slot_utc", "received_at_utc", "frame_at_utc", "display_at_utc",
        "local_date", "local_hour", "local_minute", "utc_offset_minutes", "timezone",
        "r2_key", "bytes", "sha256", "source_kind", "attribution", "state", "claim_id", "claimed_at_utc",
        "slot_kind",
      ]);
      const pk = h.all("PRAGMA table_info(cam_frames)").filter((c) => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map((c) => c.name);
      expect(pk).toEqual(["slug", "cam_id", "slot_utc"]);
      const idx = h.all("PRAGMA index_list(cam_frames)").map((i) => i.name);
      expect(idx).toContain("cam_frames_slug_date");
      expect(idx).toContain("cam_frames_received");
      expect(idx).toContain("cam_frames_slug_slot");
    });

    it("0017 adds slot_kind: a row written under 0016 reads 'hour' afterwards", async () => {
      const old = makeCamDb({ files: ["0016_cam_frames.sql"] }) as CamDb;
      try {
        await old.db
          .prepare(
            "INSERT INTO cam_frames (slug, cam_id, slot_utc, received_at_utc, display_at_utc, local_date, local_hour, local_minute, utc_offset_minutes, timezone, r2_key, bytes, sha256, source_kind, claim_id, claimed_at_utc, state) " +
              "VALUES ('a', 'b', 's', 'r', 'd', 'x', 1, 1, 0, 'tz', 'k', 1, 'h', 'feed', 'c', 'now', 'ready')",
          )
          .run();
        old.exec(readFileSync(path.join(process.cwd(), "migrations", "0017_cam_frames_golden.sql"), "utf8"));
        expect(old.all("SELECT slot_kind FROM cam_frames")).toEqual([{ slot_kind: "hour" }]);
      } finally {
        old.close();
      }
    });

    it("slot_kind defaults to 'hour', accepts 'golden', refuses anything else", async () => {
      const insert = (kind: string | null) =>
        h.db
          .prepare(
            "INSERT INTO cam_frames (slug, cam_id, slot_utc, received_at_utc, display_at_utc, local_date, local_hour, local_minute, utc_offset_minutes, timezone, r2_key, bytes, sha256, source_kind, claim_id, claimed_at_utc, state" +
              (kind ? ", slot_kind" : "") +
              ") VALUES ('a', 'b', ?1, 'r', 'd', 'x', 1, 1, 0, 'tz', 'k', 1, 'h', 'feed', 'c', 'now', 'ready'" +
              (kind ? ", ?2" : "") +
              ")",
          )
          .bind(...(kind ? [`s-${kind}`, kind] : ["s-none"]));
      await insert(null).run();
      await insert("golden").run();
      await expect(insert("bogus").run()).rejects.toThrow(/CHECK/i);
      expect(h.all("SELECT slot_utc, slot_kind FROM cam_frames ORDER BY slot_utc")).toEqual([
        { slot_utc: "s-golden", slot_kind: "golden" },
        { slot_utc: "s-none", slot_kind: "hour" },
      ]);
    });

    it("refuses a state other than pending or ready", async () => {
      const insert = (state: string) =>
        h.db
          .prepare(
            "INSERT INTO cam_frames (slug, cam_id, slot_utc, received_at_utc, display_at_utc, local_date, local_hour, local_minute, utc_offset_minutes, timezone, r2_key, bytes, sha256, source_kind, claim_id, claimed_at_utc, state) " +
              "VALUES ('a', 'b', ?1, 'r', 'd', 'x', 1, 1, 0, 'tz', 'k', 1, 'h', 'feed', 'c', 'now', ?2)",
          )
          .bind(`slot-${state}`, state)
          .run();
      await expect(insert("ready")).resolves.toBeDefined();
      await expect(insert("bogus")).rejects.toThrow(/CHECK/i);
    });
  });

  describe("claimSlot", () => {
    it("inserts a pending row and reports true", async () => {
      expect(await claimSlot(h.db, frameRow())).toBe(true);
      const r = h.all("SELECT state, r2_key, attribution FROM cam_frames")[0];
      expect(r.state).toBe("pending");
      expect(r.r2_key).toBe(frameRow().r2_key);
      expect(r.attribution).toMatch(/Palm Beach/);
    });

    it("is first-writer-wins: the same slot a second time inserts nothing and reports false", async () => {
      expect(await claimSlot(h.db, frameRow())).toBe(true);
      expect(await claimSlot(h.db, frameRow({ sha256: "f".repeat(64), r2_key: "boca-raton/boca-south/2026-10-11/1425Z-ffffffff-cccccccc.jpg" }))).toBe(false);
      expect(count()).toBe(1);
      expect(h.all("SELECT sha256 FROM cam_frames")[0].sha256).toBe(frameRow().sha256);
    });

    it("lets the same hour be claimed for a different cam, a different beach, or the next hour", async () => {
      expect(await claimSlot(h.db, frameRow())).toBe(true);
      expect(await claimSlot(h.db, frameRow({ cam_id: "boca-inlet" }))).toBe(true);
      expect(await claimSlot(h.db, frameRow({ slug: "deerfield-beach" }))).toBe(true);
      expect(await claimSlot(h.db, frameRow({ slot_utc: "2026-10-11T15:00:00.000Z" }))).toBe(true);
      expect(count()).toBe(4);
    });

    it("stores null frame_at and null attribution", async () => {
      await claimSlot(h.db, frameRow({ frame_at_utc: null, attribution: null }));
      const r = h.all("SELECT frame_at_utc, attribution FROM cam_frames")[0];
      expect(r.frame_at_utc).toBeNull();
      expect(r.attribution).toBeNull();
    });

    it("many simultaneous claims for one slot produce exactly one winner", async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          claimSlot(h.db, frameRow({ sha256: String(i).repeat(64).slice(0, 64), r2_key: `boca-raton/boca-south/2026-10-11/1420Z-${String(i).repeat(8)}.jpg` })),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(count()).toBe(1);
    });
  });

  describe("newestReadySha", () => {
    it("ignores pending rows and other cams, and returns the newest ready slot", async () => {
      expect(await newestReadySha(h.db, "boca-raton", "boca-south")).toBeNull();
      await claimSlot(h.db, frameRow({ slot_utc: "2026-10-11T12:00:00.000Z", sha256: "a".repeat(64), r2_key: "boca-raton/boca-south/2026-10-11/1200Z-aaaaaaaa-cccccccc.jpg" }));
      expect(await newestReadySha(h.db, "boca-raton", "boca-south")).toBeNull(); // still pending
      await markReady(h.db, "boca-raton", "boca-south", "2026-10-11T12:00:00.000Z", CLAIM_A);
      await claimSlot(h.db, frameRow({ slot_utc: "2026-10-11T13:00:00.000Z", sha256: "b".repeat(64), r2_key: "boca-raton/boca-south/2026-10-11/1300Z-bbbbbbbb-cccccccc.jpg" }));
      await markReady(h.db, "boca-raton", "boca-south", "2026-10-11T13:00:00.000Z", CLAIM_A);
      await claimSlot(h.db, frameRow({ slot_utc: "2026-10-11T14:00:00.000Z", sha256: "c".repeat(64) })); // pending, newer
      await claimSlot(h.db, frameRow({ cam_id: "boca-inlet", slot_utc: "2026-10-11T15:00:00.000Z", sha256: "d".repeat(64), r2_key: "boca-raton/boca-inlet/2026-10-11/1500Z-dddddddd-cccccccc.jpg" }));
      await markReady(h.db, "boca-raton", "boca-inlet", "2026-10-11T15:00:00.000Z", CLAIM_A);
      expect(await newestReadySha(h.db, "boca-raton", "boca-south")).toBe("b".repeat(64));
    });
  });

  describe("markReady / deletePending", () => {
    it("flips only our own pending row", async () => {
      const row = frameRow();
      await claimSlot(h.db, row);
      expect(await markReady(h.db, row.slug, row.cam_id, row.slot_utc, CLAIM_B)).toBe(false);
      expect(await markReady(h.db, row.slug, row.cam_id, row.slot_utc, CLAIM_A)).toBe(true);
      expect(await markReady(h.db, row.slug, row.cam_id, row.slot_utc, CLAIM_A)).toBe(false); // already ready
      expect(h.all("SELECT state FROM cam_frames")[0].state).toBe("ready");
    });

    it("deletePending removes a pending row but never a ready one or another claim", async () => {
      const row = frameRow();
      await claimSlot(h.db, row);
      await deletePending(h.db, row.slug, row.cam_id, row.slot_utc, CLAIM_B);
      expect(count()).toBe(1);
      await deletePending(h.db, row.slug, row.cam_id, row.slot_utc, CLAIM_A);
      expect(count()).toBe(0);

      await claimSlot(h.db, row);
      await markReady(h.db, row.slug, row.cam_id, row.slot_utc, CLAIM_A);
      await deletePending(h.db, row.slug, row.cam_id, row.slot_utc, CLAIM_A);
      expect(count()).toBe(1);
    });
  });

  describe("purge", () => {
    async function seed(n: number, receivedAt: (i: number) => string, state: "pending" | "ready" = "ready") {
      for (let i = 0; i < n; i++) {
        const slot = new Date(Date.parse("2020-01-01T00:00:00Z") + i * 3_600_000).toISOString();
        const key = `boca-raton/boca-south/2020-01-01/${String(i).padStart(4, "0")}Z-${String(i).padStart(8, "0")}.jpg`;
        await claimSlot(h.db, frameRow({ slot_utc: slot, received_at_utc: receivedAt(i), r2_key: key }));
        if (state === "ready") await markReady(h.db, "boca-raton", "boca-south", slot, CLAIM_A);
      }
    }

    it("deleteReceivedBefore deletes oldest first and honors the limit", async () => {
      await seed(10, (i) => new Date(NOW - (100 - i) * DAY).toISOString());
      const n = await deleteReceivedBefore(h.db, new Date(NOW - 50 * DAY).toISOString(), 4);
      expect(n).toBe(4);
      expect(count()).toBe(6);
      const oldest = h.all("SELECT MIN(received_at_utc) AS m FROM cam_frames")[0].m;
      expect(oldest).toBe(new Date(NOW - 96 * DAY).toISOString());
    });

    it("deleteStalePending removes only pending rows older than the cutoff", async () => {
      await seed(3, () => new Date(NOW - 2 * 3_600_000).toISOString(), "pending"); // stale pending
      const fresh = frameRow({ cam_id: "boca-inlet", r2_key: "boca-raton/boca-inlet/2026-10-11/1420Z-01234567-cccccccc.jpg", received_at_utc: new Date(NOW - 5 * 60_000).toISOString() });
      await claimSlot(h.db, fresh); // fresh pending
      const oldReady = frameRow({ cam_id: "boca-surf", r2_key: "boca-raton/boca-surf/2026-10-11/1420Z-01234567-cccccccc.jpg", received_at_utc: new Date(NOW - 9 * 3_600_000).toISOString() });
      await claimSlot(h.db, oldReady);
      await markReady(h.db, oldReady.slug, oldReady.cam_id, oldReady.slot_utc, CLAIM_A);
      expect(await deleteStalePending(h.db, new Date(NOW - 3_600_000).toISOString())).toBe(3);
      expect(count()).toBe(2);
      expect(count("state = 'ready'")).toBe(1);
      expect(count("state = 'pending'")).toBe(1);
    });

    it("purgeCamFrames drops rows past 365 days by received_at and keeps younger ones", async () => {
      const mk = (cam: string, daysAgo: number) => {
        const row = frameRow({
          cam_id: cam,
          r2_key: `boca-raton/${cam}/2026-10-11/1420Z-01234567-cccccccc.jpg`,
          received_at_utc: new Date(NOW - daysAgo * DAY).toISOString(),
        });
        return row;
      };
      for (const [cam, days] of [["a-old", 366], ["b-edge", 364], ["c-new", 1], ["d-ancient", 900]] as const) {
        const row = mk(cam, days);
        await claimSlot(h.db, row);
        await markReady(h.db, row.slug, row.cam_id, row.slot_utc, CLAIM_A);
      }
      const res = await purgeCamFrames(h.db, NOW);
      expect(res.purgedOld).toBe(2);
      expect(res.purgedPending).toBe(0);
      expect(res.more).toBe(false);
      expect(h.all("SELECT cam_id FROM cam_frames ORDER BY cam_id").map((r) => r.cam_id)).toEqual(["b-edge", "c-new"]);
    });

    it("purgeCamFrames clears stale pending rows and keeps fresh pending ones", async () => {
      await claimSlot(h.db, frameRow({ cam_id: "stale", r2_key: "boca-raton/stale/2026-10-11/1420Z-01234567-cccccccc.jpg", received_at_utc: new Date(NOW - 2 * 3_600_000).toISOString() }));
      await claimSlot(h.db, frameRow({ cam_id: "fresh", r2_key: "boca-raton/fresh/2026-10-11/1420Z-01234567-cccccccc.jpg", received_at_utc: new Date(NOW - 10 * 60_000).toISOString() }));
      const res = await purgeCamFrames(h.db, NOW);
      expect(res.purgedPending).toBe(1);
      expect(h.all("SELECT cam_id FROM cam_frames").map((r) => r.cam_id)).toEqual(["fresh"]);
    });

    it("uses at most the statement cap and reports `more` when old rows may remain", async () => {
      await seed(25, (i) => new Date(NOW - (500 - i) * DAY).toISOString());
      // batch 4, cap 3: 1 pending pass + 2 delete batches = 8 rows gone, 17 left.
      const res = await purgeCamFrames(h.db, NOW, { maxStatements: 3, batch: 4 });
      expect(res.statements).toBe(3);
      expect(res.purgedOld).toBe(8);
      expect(res.more).toBe(true);
      expect(count()).toBe(17);
      // A bigger cap finishes the job: stops on the first short batch.
      const done = await purgeCamFrames(h.db, NOW, { maxStatements: 10, batch: 4 });
      expect(done.more).toBe(false);
      expect(done.purgedOld).toBe(17);
      expect(done.statements).toBeLessThanOrEqual(10);
      expect(count()).toBe(0);
    });

    it("with the default cap of 10 never runs more than 10 statements", async () => {
      await seed(40, (i) => new Date(NOW - (500 - i) * DAY).toISOString());
      const res = await purgeCamFrames(h.db, NOW, { batch: 1 });
      expect(res.statements).toBe(10);
      expect(res.purgedOld).toBe(9);
      expect(res.more).toBe(true);
    });
  });

  describe("takeover of a stale pending claim", () => {
    const T0 = Date.parse("2026-10-11T14:20:00.000Z");
    const iso = (ms: number) => new Date(ms).toISOString();
    const claimA = () => frameRow({ claim_id: CLAIM_A, claimed_at_utc: iso(T0), received_at_utc: iso(T0) });
    const claimB = (afterMs: number) =>
      frameRow({
        claim_id: CLAIM_B,
        claimed_at_utc: iso(T0 + afterMs),
        received_at_utc: iso(T0 + afterMs),
        display_at_utc: iso(T0 + afterMs),
        r2_key: "boca-raton/boca-south/2026-10-11/1430Z-eeeeeeee-dddddddd.jpg",
        sha256: "e".repeat(64),
        bytes: 5,
      });
    const held = () => h.all("SELECT claim_id, state, r2_key, sha256, bytes, claimed_at_utc FROM cam_frames")[0];

    it("is 10 minutes", () => {
      expect(STALE_CLAIM_MS).toBe(600_000);
    });

    it("does not take over a fresh pending claim", async () => {
      expect(await claimSlot(h.db, claimA())).toBe(true);
      expect(await claimSlot(h.db, claimB(9 * 60_000 + 59_000))).toBe(false);
      expect(await claimSlot(h.db, claimB(STALE_CLAIM_MS))).toBe(false); // exactly 10 min is not older than 10 min
      expect(held().claim_id).toBe(CLAIM_A);
    });

    it("takes over a pending claim older than 10 minutes and replaces every claim field", async () => {
      await claimSlot(h.db, claimA());
      expect(await claimSlot(h.db, claimB(STALE_CLAIM_MS + 1000))).toBe(true);
      expect(count()).toBe(1);
      expect(held()).toMatchObject({
        claim_id: CLAIM_B,
        state: "pending",
        r2_key: "boca-raton/boca-south/2026-10-11/1430Z-eeeeeeee-dddddddd.jpg",
        sha256: "e".repeat(64),
        bytes: 5,
        claimed_at_utc: iso(T0 + STALE_CLAIM_MS + 1000),
      });
    });

    it("never takes over a ready frame, however old", async () => {
      await claimSlot(h.db, claimA());
      await markReady(h.db, "boca-raton", "boca-south", claimA().slot_utc, CLAIM_A);
      expect(await claimSlot(h.db, claimB(30 * 24 * 3_600_000))).toBe(false);
      expect(held()).toMatchObject({ claim_id: CLAIM_A, state: "ready" });
    });

    it("a stale claimant's finalize and rollback change nothing after the takeover", async () => {
      const a = claimA();
      await claimSlot(h.db, a);
      expect(await claimSlot(h.db, claimB(STALE_CLAIM_MS + 1000))).toBe(true);

      expect(await markReady(h.db, a.slug, a.cam_id, a.slot_utc, CLAIM_A)).toBe(false);
      await deletePending(h.db, a.slug, a.cam_id, a.slot_utc, CLAIM_A);
      expect(held()).toMatchObject({ claim_id: CLAIM_B, state: "pending" });
      expect(await readSlot(h.db, a.slug, a.cam_id, a.slot_utc)).toEqual({ state: "pending", claim_id: CLAIM_B });

      // The winner can still finalize, and then the stale one still cannot undo it.
      expect(await markReady(h.db, a.slug, a.cam_id, a.slot_utc, CLAIM_B)).toBe(true);
      await deletePending(h.db, a.slug, a.cam_id, a.slot_utc, CLAIM_A);
      await deletePending(h.db, a.slug, a.cam_id, a.slot_utc, CLAIM_B); // ready rows are never deleted by rollback
      expect(held()).toMatchObject({ claim_id: CLAIM_B, state: "ready" });
    });

    it("many simultaneous takeovers of one stale claim produce exactly one winner", async () => {
      await claimSlot(h.db, claimA());
      const claims = Array.from({ length: 6 }, (_, i) =>
        claimSlot(h.db, { ...claimB(STALE_CLAIM_MS + 1000 + i), claim_id: `${i}0000000-0000-4000-8000-000000000000` }),
      );
      const results = await Promise.all(claims);
      expect(results.filter(Boolean)).toHaveLength(1);
    });
  });

  describe("readSlot / filledSlots", () => {
    const NOWISO = "2026-10-11T14:20:00.000Z";
    const SLOT_NOW = "2026-10-11T14:00:00.000Z";
    const SLOT_PREV = "2026-10-11T13:00:00.000Z";
    const fresh = new Date(Date.parse(NOWISO) - STALE_CLAIM_MS).toISOString();

    it("readSlot is null for an empty slot", async () => {
      expect(await readSlot(h.db, "boca-raton", "boca-south", SLOT_NOW)).toBeNull();
    });

    it("lists ready slots and fresh pending slots, not stale pending, not other beaches or hours", async () => {
      const mk = (cam: string, slot: string, claimedAt: string, slug = "boca-raton") =>
        frameRow({ slug, cam_id: cam, slot_utc: slot, claimed_at_utc: claimedAt, received_at_utc: claimedAt, r2_key: `${slug}/${cam}/2026-10-11/1400Z-01234567-cccccccc.jpg` });
      await claimSlot(h.db, mk("ready-now", SLOT_NOW, "2026-10-11T14:01:00.000Z"));
      await markReady(h.db, "boca-raton", "ready-now", SLOT_NOW, CLAIM_A);
      await claimSlot(h.db, mk("ready-prev", SLOT_PREV, "2026-10-11T13:01:00.000Z"));
      await markReady(h.db, "boca-raton", "ready-prev", SLOT_PREV, CLAIM_A);
      await claimSlot(h.db, mk("fresh-pending", SLOT_NOW, "2026-10-11T14:15:00.000Z"));
      await claimSlot(h.db, mk("stale-pending", SLOT_NOW, "2026-10-11T14:05:00.000Z"));
      await claimSlot(h.db, mk("older-hour", "2026-10-11T12:00:00.000Z", "2026-10-11T12:01:00.000Z"));
      await markReady(h.db, "boca-raton", "older-hour", "2026-10-11T12:00:00.000Z", CLAIM_A);
      await claimSlot(h.db, mk("other-beach", SLOT_NOW, "2026-10-11T14:01:00.000Z", "deerfield-beach"));
      await markReady(h.db, "deerfield-beach", "other-beach", SLOT_NOW, CLAIM_A);

      expect(await filledSlots(h.db, "boca-raton", [SLOT_NOW, SLOT_PREV], fresh)).toEqual({
        [SLOT_NOW]: ["fresh-pending", "ready-now"],
        [SLOT_PREV]: ["ready-prev"],
      });
    });

    it("returns empty lists for a beach with nothing, and for no slots", async () => {
      expect(await filledSlots(h.db, "boca-raton", [SLOT_NOW], fresh)).toEqual({ [SLOT_NOW]: [] });
      expect(await filledSlots(h.db, "boca-raton", [], fresh)).toEqual({});
    });
  });
});
