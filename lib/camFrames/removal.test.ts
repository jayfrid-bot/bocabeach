import { describe, expect, it, vi } from "vitest";
import {
  countFramesSql,
  deleteFramesSql,
  parseRemoveArgs,
  planRemoval,
  R2_BUCKET,
  runRemoval,
  selectFramesSql,
  type RemovalIo,
} from "@/lib/camFrames/removal";

const KEY_A = "boca-raton/boca-inlet-jetty/2026-10-10/1405Z-aaaaaaaa-cccccccc.jpg";
const KEY_B = "boca-raton/boca-inlet-jetty/2026-10-11/1505Z-bbbbbbbb-cccccccc.jpg";

function rows() {
  return [
    { r2_key: KEY_A, bytes: 100_000, state: "ready", local_date: "2026-10-10" },
    { r2_key: KEY_B, bytes: 140_000, state: "pending", local_date: "2026-10-11" },
  ];
}

function makeIo(over: Partial<RemovalIo> & { listing?: Record<string, unknown>[] } = {}) {
  const sql: string[] = [];
  const deleted: string[] = [];
  const logs: string[] = [];
  const io: RemovalIo = {
    d1: vi.fn(async (q: string) => {
      sql.push(q);
      if (q.startsWith("SELECT r2_key")) return over.listing ?? rows();
      if (q.startsWith("SELECT COUNT")) return [{ n: 0 }];
      return [];
    }),
    r2Delete: vi.fn(async (k: string) => {
      deleted.push(k);
    }),
    log: (l) => logs.push(l),
    ...(over.d1 ? { d1: over.d1 } : {}),
    ...(over.r2Delete ? { r2Delete: over.r2Delete } : {}),
  };
  return { io, sql, deleted, logs };
}

describe("parseRemoveArgs", () => {
  it("defaults to a dry run", () => {
    expect(parseRemoveArgs(["boca-raton", "boca-inlet-jetty"])).toEqual({ slug: "boca-raton", camId: "boca-inlet-jetty", dryRun: true, knownKeysOnly: false });
  });
  it("deletes only with --yes", () => {
    expect(parseRemoveArgs(["boca-raton", "x", "--yes"])).toMatchObject({ dryRun: false, knownKeysOnly: false });
    expect(parseRemoveArgs(["boca-raton", "x", "--yes", "--d1-known-keys-only"])).toMatchObject({ dryRun: false, knownKeysOnly: true });
  });
  it("--dry-run wins over --yes", () => {
    expect(parseRemoveArgs(["boca-raton", "x", "--yes", "--dry-run"])).toMatchObject({ dryRun: true });
    expect(parseRemoveArgs(["--dry-run", "boca-raton", "x", "--yes"])).toMatchObject({ dryRun: true });
  });
  it("rejects wrong counts, unknown flags and unsafe ids", () => {
    for (const argv of [[], ["a"], ["a", "b", "c"], ["a", "b", "--force"], ["a'; DROP TABLE x;--", "b"], ["a", "B"], ["../a", "b"]]) {
      expect(parseRemoveArgs(argv)).toHaveProperty("error");
    }
  });
});

describe("SQL builders", () => {
  it("target one cam and escape quotes", () => {
    expect(selectFramesSql("a", "b")).toContain("WHERE slug = 'a' AND cam_id = 'b'");
    expect(deleteFramesSql("a", "b")).toBe("DELETE FROM cam_frames WHERE slug = 'a' AND cam_id = 'b'");
    expect(countFramesSql("a", "b")).toContain("COUNT(*)");
    expect(deleteFramesSql("a'b", "c")).toContain("'a''b'");
  });
});

describe("planRemoval", () => {
  it("totals rows, bytes, pending rows and the date range", () => {
    expect(planRemoval("boca-raton", "boca-inlet-jetty", rows())).toEqual({
      keys: [KEY_A, KEY_B],
      rows: 2,
      bytes: 240_000,
      pending: 1,
      firstDate: "2026-10-10",
      lastDate: "2026-10-11",
    });
  });

  it("refuses a key that is not under this cam's prefix", () => {
    const bad = [{ r2_key: "boca-raton/boca-south/2026-10-10/1405Z-aaaaaaaa-cccccccc.jpg", bytes: 1, state: "ready", local_date: "2026-10-10" }];
    expect(() => planRemoval("boca-raton", "boca-inlet-jetty", bad)).toThrow(/refusing/);
  });

  it("refuses a malformed key", () => {
    const bad = [{ r2_key: "../../etc/passwd", bytes: 1, state: "ready", local_date: "2026-10-10" }];
    expect(() => planRemoval("boca-raton", "boca-inlet-jetty", bad)).toThrow(/refusing/);
  });

  it("an empty listing is an empty plan", () => {
    expect(planRemoval("a", "b", [])).toMatchObject({ rows: 0, keys: [], firstDate: null, lastDate: null });
  });
});

describe("runRemoval", () => {
  it("a dry run lists and changes nothing", async () => {
    const { io, sql, deleted, logs } = makeIo();
    const out = await runRemoval({ slug: "boca-raton", camId: "boca-inlet-jetty", dryRun: true }, io);
    expect(out).toMatchObject({ dryRun: true, deletedObjects: 0, deletedRows: 0 });
    expect(deleted).toEqual([]);
    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatch(/^SELECT/);
    expect(logs.join("\n")).toMatch(/dry run/);
    expect(logs.join("\n")).toContain(`${R2_BUCKET}/${KEY_A}`);
  });

  it("with --yes deletes every object, then the rows, then checks none are left", async () => {
    const { io, sql, deleted } = makeIo();
    const out = await runRemoval({ slug: "boca-raton", camId: "boca-inlet-jetty", dryRun: false, knownKeysOnly: true }, io, 2);
    expect(deleted.sort()).toEqual([KEY_A, KEY_B]);
    expect(out).toMatchObject({ dryRun: false, deletedObjects: 2, deletedRows: 2, remainingRows: 0 });
    expect(sql[1]).toBe(deleteFramesSql("boca-raton", "boca-inlet-jetty"));
    expect(sql[2]).toMatch(/^SELECT COUNT/);
  });

  it("keeps the D1 rows when any object delete fails, so the run can be repeated", async () => {
    const { io, sql } = makeIo({
      r2Delete: async (k: string) => {
        if (k === KEY_B) throw new Error("r2 unavailable (test)");
      },
    });
    await expect(runRemoval({ slug: "boca-raton", camId: "boca-inlet-jetty", dryRun: false, knownKeysOnly: true }, io)).rejects.toThrow(/object deletes failed/);
    expect(sql.some((q) => q.startsWith("DELETE"))).toBe(false);
  });

  it("warns when the cam is still archived in config", async () => {
    const { io, logs } = makeIo();
    await runRemoval({ slug: "boca-raton", camId: "boca-inlet-jetty", dryRun: false, knownKeysOnly: true }, io);
    expect(logs.join("\n")).toMatch(/archive: false/);
  });

  it("handles a cam with no stored frames", async () => {
    const { io, deleted } = makeIo({ listing: [] });
    const out = await runRemoval({ slug: "boca-raton", camId: "boca-inlet-jetty", dryRun: false, knownKeysOnly: true }, io);
    expect(deleted).toEqual([]);
    expect(out.plan.rows).toBe(0);
  });

  it("stops before deleting anything if a row key is outside the cam's prefix", async () => {
    const { io, deleted, sql } = makeIo({
      listing: [{ r2_key: "boca-raton/boca-south/2026-10-10/1405Z-aaaaaaaa-cccccccc.jpg", bytes: 1, state: "ready", local_date: "2026-10-10" }],
    });
    await expect(runRemoval({ slug: "boca-raton", camId: "boca-inlet-jetty", dryRun: false, knownKeysOnly: true }, io)).rejects.toThrow(/refusing/);
    expect(deleted).toEqual([]);
    expect(sql).toHaveLength(1);
  });

  it("refuses a real deletion without R2 listing credentials unless --d1-known-keys-only", async () => {
    const { io, deleted } = makeIo();
    await expect(runRemoval({ slug: "boca-raton", camId: "boca-inlet-jetty", dryRun: false }, io)).rejects.toThrow(
      /refusing to delete without R2 listing credentials/,
    );
    expect(deleted).toEqual([]);
  });

  describe("with R2 credentials (orphan objects under the prefix)", () => {
    const ORPHAN = "boca-raton/boca-inlet-jetty/2026-10-09/1305Z-99999999-88888888.jpg";

    it("deletes the orphans too, then the rows", async () => {
      const { io, deleted, sql } = makeIo();
      io.r2List = async (prefix) => (prefix.startsWith("quality/") ? [] : [KEY_A, KEY_B, ORPHAN]);
      const out = await runRemoval({ slug: "boca-raton", camId: "boca-inlet-jetty", dryRun: false, knownKeysOnly: true }, io, 2);
      expect(deleted.sort()).toEqual([KEY_A, KEY_B, ORPHAN].sort());
      expect(out.orphans).toBe(1);
      expect(sql.some((q) => q.startsWith("DELETE"))).toBe(true);
    });

    it("still deletes a D1-listed key that the listing missed", async () => {
      const { io, deleted } = makeIo();
      io.r2List = async (prefix) => (prefix.startsWith("quality/") ? [] : [KEY_A]);
      await runRemoval({ slug: "boca-raton", camId: "boca-inlet-jetty", dryRun: false, knownKeysOnly: true }, io);
      expect(deleted.sort()).toEqual([KEY_A, KEY_B]);
    });

    it("lists with the cam's own prefix", async () => {
      const { io } = makeIo();
      const seen: string[] = [];
      io.r2List = async (prefix) => {
        seen.push(prefix);
        return [];
      };
      await runRemoval({ slug: "boca-raton", camId: "boca-inlet-jetty", dryRun: true }, io);
      expect(seen).toEqual(["boca-raton/boca-inlet-jetty/", "quality/boca-raton/boca-inlet-jetty/"]);
    });

    it("a dry run reports orphans and deletes nothing", async () => {
      const { io, deleted, sql, logs } = makeIo();
      io.r2List = async (prefix) => (prefix.startsWith("quality/") ? [] : [KEY_A, KEY_B, ORPHAN]);
      const out = await runRemoval({ slug: "boca-raton", camId: "boca-inlet-jetty", dryRun: true }, io);
      expect(out.orphans).toBe(1);
      expect(deleted).toEqual([]);
      expect(sql).toHaveLength(1);
      expect(logs.join("\n")).toMatch(/1 have no D1 row/);
      expect(logs.join("\n")).not.toMatch(/WARNING: R2 credentials/);
    });

    it("also erases the cam's quality frames (the exact images kept for alerts)", async () => {
      const { io, deleted } = makeIo();
      const Q = "quality/boca-raton/boca-inlet-jetty/2026-10-13/172015Z-abcdef12.jpg";
      io.r2List = async (prefix) => (prefix.startsWith("quality/") ? [Q] : [KEY_A, KEY_B]);
      await runRemoval({ slug: "boca-raton", camId: "boca-inlet-jetty", dryRun: false, knownKeysOnly: true }, io);
      expect(deleted.sort()).toEqual([KEY_A, KEY_B, Q].sort());
    });

    it("refuses a quality listing that strays outside the cam's quality prefix", async () => {
      const { io, deleted } = makeIo();
      io.r2List = async (prefix) => (prefix.startsWith("quality/") ? ["quality/boca-raton/boca-south/2026-10-13/172015Z-abcdef12.jpg"] : [KEY_A, KEY_B]);
      await expect(runRemoval({ slug: "boca-raton", camId: "boca-inlet-jetty", dryRun: false, knownKeysOnly: true }, io)).rejects.toThrow(/refusing/);
      expect(deleted).toEqual([]);
    });

    it("refuses a listed key outside the prefix before deleting anything", async () => {
      const { io, deleted } = makeIo();
      io.r2List = async (prefix) => (prefix.startsWith("quality/") ? [] : [KEY_A, "boca-raton/boca-south/2026-10-10/1405Z-aaaaaaaa-cccccccc.jpg"]);
      await expect(runRemoval({ slug: "boca-raton", camId: "boca-inlet-jetty", dryRun: false, knownKeysOnly: true }, io)).rejects.toThrow(/refusing/);
      expect(deleted).toEqual([]);
    });

    it("keeps the D1 rows when the listing itself fails", async () => {
      const { io, deleted, sql } = makeIo();
      io.r2List = async () => {
        throw new Error("R2 list failed: HTTP 403");
      };
      await expect(runRemoval({ slug: "boca-raton", camId: "boca-inlet-jetty", dryRun: false, knownKeysOnly: true }, io)).rejects.toThrow(/HTTP 403/);
      expect(deleted).toEqual([]);
      expect(sql.some((q) => q.startsWith("DELETE"))).toBe(false);
    });
  });

  describe("without R2 credentials", () => {
    it("falls back to the D1 keys and warns clearly that orphans may remain", async () => {
      const { io, logs, deleted } = makeIo();
      expect(io.r2List).toBeUndefined();
      const out = await runRemoval({ slug: "boca-raton", camId: "boca-inlet-jetty", dryRun: false, knownKeysOnly: true }, io);
      expect(deleted.sort()).toEqual([KEY_A, KEY_B]);
      expect(out.orphans).toBeNull();
      expect(logs.join("\n")).toMatch(/WARNING: R2 credentials are not set.*Orphan objects/s);
    });
  });
});
