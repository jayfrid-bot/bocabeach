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

const KEY_A = "boca-raton/boca-inlet-jetty/2026-10-10/1405Z-aaaaaaaa.jpg";
const KEY_B = "boca-raton/boca-inlet-jetty/2026-10-11/1505Z-bbbbbbbb.jpg";

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
    expect(parseRemoveArgs(["boca-raton", "boca-inlet-jetty"])).toEqual({ slug: "boca-raton", camId: "boca-inlet-jetty", dryRun: true });
  });
  it("deletes only with --yes", () => {
    expect(parseRemoveArgs(["boca-raton", "x", "--yes"])).toMatchObject({ dryRun: false });
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
    const bad = [{ r2_key: "boca-raton/boca-south/2026-10-10/1405Z-aaaaaaaa.jpg", bytes: 1, state: "ready", local_date: "2026-10-10" }];
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
    const out = await runRemoval({ slug: "boca-raton", camId: "boca-inlet-jetty", dryRun: false }, io, 2);
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
    await expect(runRemoval({ slug: "boca-raton", camId: "boca-inlet-jetty", dryRun: false }, io)).rejects.toThrow(/object deletes failed/);
    expect(sql.some((q) => q.startsWith("DELETE"))).toBe(false);
  });

  it("warns when the cam is still archived in config", async () => {
    const { io, logs } = makeIo();
    await runRemoval({ slug: "boca-raton", camId: "boca-inlet-jetty", dryRun: false }, io);
    expect(logs.join("\n")).toMatch(/archive: false/);
  });

  it("handles a cam with no stored frames", async () => {
    const { io, deleted } = makeIo({ listing: [] });
    const out = await runRemoval({ slug: "boca-raton", camId: "boca-inlet-jetty", dryRun: false }, io);
    expect(deleted).toEqual([]);
    expect(out.plan.rows).toBe(0);
  });

  it("stops before deleting anything if a row key is outside the cam's prefix", async () => {
    const { io, deleted, sql } = makeIo({
      listing: [{ r2_key: "boca-raton/boca-south/2026-10-10/1405Z-aaaaaaaa.jpg", bytes: 1, state: "ready", local_date: "2026-10-10" }],
    });
    await expect(runRemoval({ slug: "boca-raton", camId: "boca-inlet-jetty", dryRun: false }, io)).rejects.toThrow(/refusing/);
    expect(deleted).toEqual([]);
    expect(sql).toHaveLength(1);
  });
});
