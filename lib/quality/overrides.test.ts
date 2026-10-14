import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HAS_SQLITE, makeCamDb, type CamDb } from "@/lib/camFrames/testDb";
import { insertOverride } from "@/lib/quality/store";

const ctl = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db/d1Store", () => ({ getD1: async () => ctl.db }));

import { loadSeaweedOverrides, overrideFromRow } from "@/lib/quality/overrides";

let h: CamDb;
beforeEach(() => {
  h = makeCamDb({ allMigrations: true }) as CamDb;
  ctl.db = h?.db ?? null;
});
afterEach(() => {
  vi.restoreAllMocks();
  h?.close();
});

describe("overrideFromRow", () => {
  const row = { id: 1, slug: "boca-raton", signal: "seaweed" as const, cam_id: "c", created_at_utc: "a", until_utc: "b", label_id: 1 };

  it("reads the verdict and the claim", () => {
    expect(overrideFromRow({ ...row, verdict: "right", claim_json: '{"level":"moderate","coveragePct":35,"note":null}' })).toEqual({
      camId: "c", verdict: "right", createdAtUtc: "a", untilUtc: "b", claim: { level: "moderate", coveragePct: 35, note: null },
    });
    expect(overrideFromRow({ ...row, verdict: "wrong", claim_json: null }).claim).toBeNull();
  });

  it("an unreadable claim is none, and an odd verdict is Wrong", () => {
    expect(overrideFromRow({ ...row, verdict: "right", claim_json: "{nope" }).claim).toBeNull();
    expect(overrideFromRow({ ...row, verdict: "huh" as never, claim_json: null }).verdict).toBe("wrong");
  });
});

describe("loadSeaweedOverrides", () => {
  it("is empty with no database", async () => {
    ctl.db = null;
    expect(await loadSeaweedOverrides("boca-raton")).toEqual([]);
  });

  it.skipIf(!HAS_SQLITE)("returns the beach's running seaweed verdicts", async () => {
    const base = { signal: "seaweed" as const, createdAtUtc: "2026-10-13T17:00:00.000Z", untilUtc: "2026-10-14T04:00:00.000Z", labelId: 1 };
    await insertOverride(h.db, { ...base, slug: "boca-raton", camId: "a", verdict: "wrong" });
    await insertOverride(h.db, { ...base, slug: "boca-raton", camId: "b", verdict: "right", claim: { level: "high" } });
    await insertOverride(h.db, { ...base, slug: "deerfield-beach", camId: "z", verdict: "wrong" });
    const got = await loadSeaweedOverrides("boca-raton", Date.parse("2026-10-13T20:00:00.000Z"));
    expect(got.map((o) => [o.camId, o.verdict])).toEqual([["a", "wrong"], ["b", "right"]]);
    expect(got[1].claim).toEqual({ level: "high" });
    expect(await loadSeaweedOverrides("boca-raton", Date.parse("2026-10-14T05:00:00.000Z"))).toEqual([]);
  });

  it.skipIf(!HAS_SQLITE)("a database error is no overrides, not a failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.exec("DROP TABLE quality_overrides");
    expect(await loadSeaweedOverrides("boca-raton")).toEqual([]);
  });
});
