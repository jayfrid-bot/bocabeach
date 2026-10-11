import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HAS_SQLITE, makeCamDb, type CamDb } from "@/lib/camFrames/testDb";
import { frameRow } from "@/lib/camFrames/testFixtures";
import {
  claimSlot,
  deletePending,
  deleteReceivedBefore,
  deleteStalePending,
  markReady,
  newestReadySha,
  purgeCamFrames,
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
  describe("migration 0016", () => {
    it("has the columns, primary key and indexes the plan names", () => {
      const cols = h.all("PRAGMA table_info(cam_frames)").map((c) => c.name);
      expect(cols).toEqual([
        "slug", "cam_id", "slot_utc", "received_at_utc", "frame_at_utc", "display_at_utc",
        "local_date", "local_hour", "local_minute", "utc_offset_minutes", "timezone",
        "r2_key", "bytes", "sha256", "source_kind", "attribution", "state",
      ]);
      const pk = h.all("PRAGMA table_info(cam_frames)").filter((c) => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map((c) => c.name);
      expect(pk).toEqual(["slug", "cam_id", "slot_utc"]);
      const idx = h.all("PRAGMA index_list(cam_frames)").map((i) => i.name);
      expect(idx).toContain("cam_frames_slug_date");
      expect(idx).toContain("cam_frames_received");
    });

    it("refuses a state other than pending or ready", async () => {
      const insert = (state: string) =>
        h.db
          .prepare(
            "INSERT INTO cam_frames (slug, cam_id, slot_utc, received_at_utc, display_at_utc, local_date, local_hour, local_minute, utc_offset_minutes, timezone, r2_key, bytes, sha256, source_kind, state) " +
              "VALUES ('a', 'b', ?1, 'r', 'd', 'x', 1, 1, 0, 'tz', 'k', 1, 'h', 'feed', ?2)",
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
      expect(await claimSlot(h.db, frameRow({ sha256: "f".repeat(64), r2_key: "boca-raton/boca-south/2026-10-11/1425Z-ffffffff.jpg" }))).toBe(false);
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
      await claimSlot(h.db, frameRow({ slot_utc: "2026-10-11T12:00:00.000Z", sha256: "a".repeat(64), r2_key: "boca-raton/boca-south/2026-10-11/1200Z-aaaaaaaa.jpg" }));
      expect(await newestReadySha(h.db, "boca-raton", "boca-south")).toBeNull(); // still pending
      await markReady(h.db, "boca-raton", "boca-south", "2026-10-11T12:00:00.000Z", "boca-raton/boca-south/2026-10-11/1200Z-aaaaaaaa.jpg");
      await claimSlot(h.db, frameRow({ slot_utc: "2026-10-11T13:00:00.000Z", sha256: "b".repeat(64), r2_key: "boca-raton/boca-south/2026-10-11/1300Z-bbbbbbbb.jpg" }));
      await markReady(h.db, "boca-raton", "boca-south", "2026-10-11T13:00:00.000Z", "boca-raton/boca-south/2026-10-11/1300Z-bbbbbbbb.jpg");
      await claimSlot(h.db, frameRow({ slot_utc: "2026-10-11T14:00:00.000Z", sha256: "c".repeat(64) })); // pending, newer
      await claimSlot(h.db, frameRow({ cam_id: "boca-inlet", slot_utc: "2026-10-11T15:00:00.000Z", sha256: "d".repeat(64), r2_key: "boca-raton/boca-inlet/2026-10-11/1500Z-dddddddd.jpg" }));
      await markReady(h.db, "boca-raton", "boca-inlet", "2026-10-11T15:00:00.000Z", "boca-raton/boca-inlet/2026-10-11/1500Z-dddddddd.jpg");
      expect(await newestReadySha(h.db, "boca-raton", "boca-south")).toBe("b".repeat(64));
    });
  });

  describe("markReady / deletePending", () => {
    it("flips only our own pending row", async () => {
      const row = frameRow();
      await claimSlot(h.db, row);
      expect(await markReady(h.db, row.slug, row.cam_id, row.slot_utc, "some/other/key")).toBe(false);
      expect(await markReady(h.db, row.slug, row.cam_id, row.slot_utc, row.r2_key)).toBe(true);
      expect(await markReady(h.db, row.slug, row.cam_id, row.slot_utc, row.r2_key)).toBe(false); // already ready
      expect(h.all("SELECT state FROM cam_frames")[0].state).toBe("ready");
    });

    it("deletePending removes a pending row but never a ready one or another claim", async () => {
      const row = frameRow();
      await claimSlot(h.db, row);
      await deletePending(h.db, row.slug, row.cam_id, row.slot_utc, "not-our-key");
      expect(count()).toBe(1);
      await deletePending(h.db, row.slug, row.cam_id, row.slot_utc, row.r2_key);
      expect(count()).toBe(0);

      await claimSlot(h.db, row);
      await markReady(h.db, row.slug, row.cam_id, row.slot_utc, row.r2_key);
      await deletePending(h.db, row.slug, row.cam_id, row.slot_utc, row.r2_key);
      expect(count()).toBe(1);
    });
  });

  describe("purge", () => {
    async function seed(n: number, receivedAt: (i: number) => string, state: "pending" | "ready" = "ready") {
      for (let i = 0; i < n; i++) {
        const slot = new Date(Date.parse("2020-01-01T00:00:00Z") + i * 3_600_000).toISOString();
        const key = `boca-raton/boca-south/2020-01-01/${String(i).padStart(4, "0")}Z-${String(i).padStart(8, "0")}.jpg`;
        await claimSlot(h.db, frameRow({ slot_utc: slot, received_at_utc: receivedAt(i), r2_key: key }));
        if (state === "ready") await markReady(h.db, "boca-raton", "boca-south", slot, key);
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
      const fresh = frameRow({ cam_id: "boca-inlet", r2_key: "boca-raton/boca-inlet/2026-10-11/1420Z-01234567.jpg", received_at_utc: new Date(NOW - 5 * 60_000).toISOString() });
      await claimSlot(h.db, fresh); // fresh pending
      const oldReady = frameRow({ cam_id: "boca-surf", r2_key: "boca-raton/boca-surf/2026-10-11/1420Z-01234567.jpg", received_at_utc: new Date(NOW - 9 * 3_600_000).toISOString() });
      await claimSlot(h.db, oldReady);
      await markReady(h.db, oldReady.slug, oldReady.cam_id, oldReady.slot_utc, oldReady.r2_key);
      expect(await deleteStalePending(h.db, new Date(NOW - 3_600_000).toISOString())).toBe(3);
      expect(count()).toBe(2);
      expect(count("state = 'ready'")).toBe(1);
      expect(count("state = 'pending'")).toBe(1);
    });

    it("purgeCamFrames drops rows past 365 days by received_at and keeps younger ones", async () => {
      const mk = (cam: string, daysAgo: number) => {
        const row = frameRow({
          cam_id: cam,
          r2_key: `boca-raton/${cam}/2026-10-11/1420Z-01234567.jpg`,
          received_at_utc: new Date(NOW - daysAgo * DAY).toISOString(),
        });
        return row;
      };
      for (const [cam, days] of [["a-old", 366], ["b-edge", 364], ["c-new", 1], ["d-ancient", 900]] as const) {
        const row = mk(cam, days);
        await claimSlot(h.db, row);
        await markReady(h.db, row.slug, row.cam_id, row.slot_utc, row.r2_key);
      }
      const res = await purgeCamFrames(h.db, NOW);
      expect(res.purgedOld).toBe(2);
      expect(res.purgedPending).toBe(0);
      expect(res.more).toBe(false);
      expect(h.all("SELECT cam_id FROM cam_frames ORDER BY cam_id").map((r) => r.cam_id)).toEqual(["b-edge", "c-new"]);
    });

    it("purgeCamFrames clears stale pending rows and keeps fresh pending ones", async () => {
      await claimSlot(h.db, frameRow({ cam_id: "stale", r2_key: "boca-raton/stale/2026-10-11/1420Z-01234567.jpg", received_at_utc: new Date(NOW - 2 * 3_600_000).toISOString() }));
      await claimSlot(h.db, frameRow({ cam_id: "fresh", r2_key: "boca-raton/fresh/2026-10-11/1420Z-01234567.jpg", received_at_utc: new Date(NOW - 10 * 60_000).toISOString() }));
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
});
