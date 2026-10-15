import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HAS_SQLITE, makeCamDb, type CamDb } from "@/lib/camFrames/testDb";
import { insertOverrideRow } from "@/lib/quality/testHelpers";

const ctl = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db/d1Store", () => ({ getD1: async () => ctl.db }));

import { loadSeaweedOverrides, overrideFromRow, overridesFingerprint, overridesVersion } from "@/lib/quality/overrides";
import type { OverrideRow } from "@/lib/quality/types";

let h: CamDb;
beforeEach(() => {
  h = makeCamDb({ allMigrations: true }) as CamDb;
  ctl.db = h?.db ?? null;
});
afterEach(() => {
  vi.restoreAllMocks();
  h?.close();
});

const row: OverrideRow = {
  id: 4, alert_id: 9, label_id: 3, superseded: 0, slug: "boca-raton", signal: "seaweed", cam_id: "c",
  frame_sha: "a".repeat(20), frame_at: null, claimed_at: "2026-10-13T17:21:00Z", local_date: "2026-10-13",
  verdict: "right", action: "publish", level: "moderate", coverage_pct: 35, note: null,
  created_at_utc: "2026-10-13T17:35:00.000Z", until_utc: "2026-10-14T04:00:00.000Z",
};

describe("overrideFromRow", () => {
  it("carries the exact target and the action", () => {
    expect(overrideFromRow(row)).toEqual({
      id: 4, camId: "c", verdict: "right", action: "publish", level: "moderate", coveragePct: 35, note: null,
      frameSha: "a".repeat(20), frameAt: null, claimedAt: "2026-10-13T17:21:00Z", localDate: "2026-10-13",
      createdAtUtc: "2026-10-13T17:35:00.000Z", untilUtc: "2026-10-14T04:00:00.000Z",
    });
  });
});

describe("loadSeaweedOverrides", () => {
  it("is empty with no database", async () => {
    ctl.db = null;
    expect(await loadSeaweedOverrides("boca-raton")).toEqual([]);
  });

  it.skipIf(!HAS_SQLITE)("returns the beach's running seaweed verdicts and none that were superseded", async () => {
    await insertOverrideRow(h.db, { alert_id: 1, cam_id: "a" });
    await insertOverrideRow(h.db, { alert_id: 2, cam_id: "b", verdict: "wrong", action: "reject", level: null });
    await insertOverrideRow(h.db, { alert_id: 3, cam_id: "old", superseded: 1 });
    await insertOverrideRow(h.db, { alert_id: 4, cam_id: "z", slug: "deerfield-beach" });
    const got = await loadSeaweedOverrides("boca-raton", Date.parse("2026-10-13T20:00:00.000Z"));
    expect(got.map((o) => [o.camId, o.action])).toEqual([["a", "publish"], ["b", "reject"]]);
    expect(await loadSeaweedOverrides("boca-raton", Date.parse("2026-10-14T05:00:00.000Z"))).toEqual([]);
  });

  it.skipIf(!HAS_SQLITE)("a database error is no overrides, not a failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.exec("DROP TABLE quality_overrides");
    expect(await loadSeaweedOverrides("boca-raton")).toEqual([]);
  });
});

describe("overridesVersion: the cache key that makes an owner's answer show at once", () => {
  const T = Date.parse("2026-10-13T20:00:00.000Z");

  it("is '0' with no database, no verdicts, or a database error", async () => {
    ctl.db = null;
    expect(await overridesVersion("boca-raton", undefined, T)).toBe("0");
    expect(await overridesVersion("boca-raton", null, T)).toBe("0");
    if (!HAS_SQLITE) return;
    ctl.db = h.db;
    expect(await overridesVersion("boca-raton", undefined, T)).toBe("0");
    h.exec("DROP TABLE quality_overrides");
    expect(await overridesVersion("boca-raton", undefined, T)).toBe("0");
  });

  it("tells 'no verdicts' (reliable) from 'the lookup failed' (not reliable)", async () => {
    ctl.db = null;
    expect(await overridesFingerprint("boca-raton", undefined, T)).toEqual({ version: "0", reliable: true });
    if (!HAS_SQLITE) return;
    ctl.db = h.db;
    expect(await overridesFingerprint("boca-raton", undefined, T)).toEqual({ version: "0", reliable: true });
    h.exec("DROP TABLE quality_overrides");
    expect(await overridesFingerprint("boca-raton", undefined, T)).toEqual({ version: "0", reliable: false });
  });

  it.skipIf(!HAS_SQLITE)("changes when a verdict is added, so the next request builds a fresh snapshot", async () => {
    const v0 = await overridesVersion("boca-raton", undefined, T);
    await insertOverrideRow(h.db, { alert_id: 1 });
    const v1 = await overridesVersion("boca-raton", undefined, T);
    await insertOverrideRow(h.db, { alert_id: 2, cam_id: "b" });
    const v2 = await overridesVersion("boca-raton", undefined, T);
    expect(new Set([v0, v1, v2]).size).toBe(3);
    expect(v0).toBe("0");
  });

  it.skipIf(!HAS_SQLITE)("changes when a verdict is replaced, and when one ends; other beaches and signals do not move it", async () => {
    await insertOverrideRow(h.db, { alert_id: 1 });
    const before = await overridesVersion("boca-raton", undefined, T);
    h.exec("UPDATE quality_overrides SET superseded = 1");
    await insertOverrideRow(h.db, { alert_id: 1, verdict: "wrong", action: "reject", level: null });
    expect(await overridesVersion("boca-raton", undefined, T)).not.toBe(before);
    expect(await overridesVersion("boca-raton", undefined, Date.parse("2026-10-14T05:00:00.000Z"))).toBe("0"); // ended
    const stable = await overridesVersion("boca-raton", undefined, T);
    await insertOverrideRow(h.db, { alert_id: 7, slug: "deerfield-beach" });
    expect(await overridesVersion("boca-raton", undefined, T)).toBe(stable);
  });
});
