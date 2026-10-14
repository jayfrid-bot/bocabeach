import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HAS_SQLITE, makeCamDb, type CamDb } from "@/lib/camFrames/testDb";
import {
  activeOverrides,
  ALERT_OPEN_MS,
  countPushedSince,
  expireOldAlerts,
  getAlert,
  insertAlert,
  insertLabel,
  insertOverride,
  lastPushedAt,
  latestHourlyRow,
  listAlerts,
  markAnswered,
  previousHourlyRow,
  setAlertPushed,
} from "@/lib/quality/store";
import { insertHourly } from "@/lib/quality/testHelpers";

let h: CamDb;
beforeEach(() => {
  h = makeCamDb({ allMigrations: true }) as CamDb;
});
afterEach(() => h?.close());

const alert = (over: Record<string, unknown> = {}) => ({
  slug: "boca-raton",
  signal: "seaweed" as const,
  kind: "seaweed-held-disagreed" as const,
  createdAt: "2026-10-13T17:30:00.000Z",
  payload: { camId: "boca-inlet-surf" },
  dedupeKey: "k1",
  ...over,
});

describe.skipIf(!HAS_SQLITE)("migration 0019", () => {
  it("creates the three tables", () => {
    const names = h.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'quality_%' ORDER BY name").map((r) => r.name);
    expect(names).toEqual(["quality_alerts", "quality_labels", "quality_overrides"]);
  });

  it("refuses a signal, status, source or verdict outside the allowed words", async () => {
    await expect(insertAlert(h.db, alert({ signal: "weather" }))).rejects.toThrow();
    await expect(
      insertLabel(h.db, { slug: "s", signal: "seaweed", observedAt: "x", source: "alert", verdict: "maybe" as never, createdAt: "x" }),
    ).rejects.toThrow();
    await expect(
      insertLabel(h.db, { slug: "s", signal: "seaweed", observedAt: "x", source: "chat" as never, verdict: null, createdAt: "x" }),
    ).rejects.toThrow();
    await insertAlert(h.db, alert());
    expect(() => h.exec("UPDATE quality_alerts SET status = 'gone'")).toThrow();
  });
});

describe.skipIf(!HAS_SQLITE)("alerts", () => {
  it("insertAlert writes once per dedupe key and says whether it created the row", async () => {
    const first = await insertAlert(h.db, alert());
    expect(first.created).toBe(true);
    const again = await insertAlert(h.db, alert({ payload: { camId: "other" } }));
    expect(again).toEqual({ id: first.id, created: false });
    expect(h.all("SELECT COUNT(*) AS n FROM quality_alerts")[0].n).toBe(1);
    const row = await getAlert(h.db, first.id);
    expect(row).toMatchObject({ slug: "boca-raton", signal: "seaweed", status: "open", pushed: 0, label_id: null });
    expect(JSON.parse(row!.payload_json)).toEqual({ camId: "boca-inlet-surf" });
    const other = await insertAlert(h.db, alert({ dedupeKey: "k2" }));
    expect(other.created).toBe(true);
    expect(other.id).not.toBe(first.id);
  });

  it("getAlert is null for an unknown id", async () => {
    expect(await getAlert(h.db, 999)).toBeNull();
  });

  it("counts pushes since a time and finds the last push for a beach and signal", async () => {
    const a = await insertAlert(h.db, alert({ createdAt: "2026-10-13T10:00:00.000Z", dedupeKey: "a" }));
    const b = await insertAlert(h.db, alert({ createdAt: "2026-10-13T14:00:00.000Z", dedupeKey: "b" }));
    const c = await insertAlert(h.db, alert({ createdAt: "2026-10-13T15:00:00.000Z", dedupeKey: "c", signal: "score", kind: "hourly-jump" }));
    await insertAlert(h.db, alert({ createdAt: "2026-10-13T16:00:00.000Z", dedupeKey: "d" })); // never pushed
    for (const x of [a, b, c]) await setAlertPushed(h.db, x.id, 1);
    expect(await countPushedSince(h.db, "2026-10-13T04:00:00.000Z")).toBe(3);
    expect(await countPushedSince(h.db, "2026-10-13T12:00:00.000Z")).toBe(2);
    expect(await lastPushedAt(h.db, "boca-raton", "seaweed")).toBe("2026-10-13T14:00:00.000Z");
    expect(await lastPushedAt(h.db, "boca-raton", "score")).toBe("2026-10-13T15:00:00.000Z");
    expect(await lastPushedAt(h.db, "deerfield-beach", "seaweed")).toBeNull();
    await setAlertPushed(h.db, b.id, 0);
    expect(await lastPushedAt(h.db, "boca-raton", "seaweed")).toBe("2026-10-13T10:00:00.000Z");
  });

  it("expires open alerts older than 24 hours, and only those", async () => {
    const now = Date.parse("2026-10-14T12:00:00.000Z");
    await insertAlert(h.db, alert({ createdAt: new Date(now - ALERT_OPEN_MS - 1000).toISOString(), dedupeKey: "old" }));
    await insertAlert(h.db, alert({ createdAt: new Date(now - ALERT_OPEN_MS + 1000).toISOString(), dedupeKey: "new" }));
    expect(await expireOldAlerts(h.db, now)).toBe(1);
    expect(h.all("SELECT dedupe_key, status FROM quality_alerts ORDER BY dedupe_key")).toEqual([
      { dedupe_key: "new", status: "open" },
      { dedupe_key: "old", status: "expired" },
    ]);
    expect(await expireOldAlerts(h.db, now)).toBe(0);
  });

  it("markAnswered closes an alert once, and listAlerts shows the label's verdict", async () => {
    const { id } = await insertAlert(h.db, alert());
    const labelId = await insertLabel(h.db, {
      slug: "boca-raton", signal: "seaweed", observedAt: "2026-10-13T17:20:00.000Z", source: "alert",
      verdict: "wrong", correct: { level: "none" }, camId: "boca-inlet-surf", createdAt: "2026-10-13T17:40:00.000Z",
    });
    expect(labelId).toBeGreaterThan(0);
    expect(await markAnswered(h.db, id, labelId)).toBe(true);
    expect(await markAnswered(h.db, id, labelId)).toBe(false);
    const [row] = await listAlerts(h.db, 10);
    expect(row).toMatchObject({ id, status: "answered", label_id: labelId, label_verdict: "wrong" });
    expect(JSON.parse(row.label_correct!)).toEqual({ level: "none" });
  });

  it("listAlerts is newest first and respects the limit", async () => {
    for (let i = 1; i <= 5; i++) await insertAlert(h.db, alert({ createdAt: `2026-10-13T1${i}:00:00.000Z`, dedupeKey: `k${i}` }));
    const rows = await listAlerts(h.db, 3);
    expect(rows.map((r) => r.dedupe_key)).toEqual(["k5", "k4", "k3"]);
  });
});

describe.skipIf(!HAS_SQLITE)("labels and overrides", () => {
  it("stores JSON columns as JSON text and nulls the ones it was not given", async () => {
    const id = await insertLabel(h.db, {
      slug: "boca-raton", signal: "surf", observedAt: "2026-10-13T17:00:00.000Z", source: "report",
      published: { value: 3 }, verdict: null, correct: { value: 2 }, frames: [{ camId: "a" }], note: "choppy", createdAt: "2026-10-13T17:01:00.000Z",
    });
    const row = h.all("SELECT * FROM quality_labels WHERE id = ?", id)[0];
    expect(row).toMatchObject({ source: "report", verdict: null, claimed_value: null, cam_id: null, r2_key: null, note: "choppy" });
    expect(JSON.parse(row.published_value as string)).toEqual({ value: 3 });
    expect(JSON.parse(row.frames_json as string)).toEqual([{ camId: "a" }]);
  });

  it("a Right override keeps the claim it publishes", async () => {
    await insertOverride(h.db, {
      slug: "boca-raton", signal: "seaweed", camId: "boca-inlet-surf", createdAtUtc: "2026-10-13T17:00:00.000Z",
      untilUtc: "2026-10-14T04:00:00.000Z", labelId: 1, verdict: "right", claim: { level: "moderate", coveragePct: 35, note: null },
    });
    const [o] = await activeOverrides(h.db, "boca-raton", "seaweed", Date.parse("2026-10-13T20:00:00.000Z"));
    expect(o.verdict).toBe("right");
    expect(JSON.parse(o.claim_json!)).toEqual({ level: "moderate", coveragePct: 35, note: null });
    await expect(
      insertOverride(h.db, { slug: "s", signal: "seaweed", camId: "c", createdAtUtc: "x", untilUtc: "y", labelId: null, verdict: "maybe" as never }),
    ).rejects.toThrow();
  });

  it("activeOverrides lists only the beach's seaweed overrides that have not ended", async () => {
    const base = { slug: "boca-raton", signal: "seaweed" as const, camId: "boca-inlet-surf", createdAtUtc: "2026-10-13T17:00:00.000Z", labelId: 1, verdict: "wrong" as const };
    await insertOverride(h.db, { ...base, untilUtc: "2026-10-14T04:00:00.000Z" });
    await insertOverride(h.db, { ...base, camId: "ended", untilUtc: "2026-10-13T18:00:00.000Z" });
    await insertOverride(h.db, { ...base, slug: "deerfield-beach", untilUtc: "2026-10-14T04:00:00.000Z" });
    await insertOverride(h.db, { ...base, signal: "clarity", untilUtc: "2026-10-14T04:00:00.000Z" });
    const live = await activeOverrides(h.db, "boca-raton", "seaweed", Date.parse("2026-10-13T20:00:00.000Z"));
    expect(live.map((o) => o.cam_id)).toEqual(["boca-inlet-surf"]);
    expect(live[0]).toMatchObject({ verdict: "wrong", claim_json: null });
    expect(await activeOverrides(h.db, "boca-raton", "seaweed", Date.parse("2026-10-14T05:00:00.000Z"))).toEqual([]);
  });
});

describe.skipIf(!HAS_SQLITE)("beach_hourly reads", () => {
  it("previousHourlyRow is the newest earlier snapshot of the same beach", async () => {
    await insertHourly(h.db, { hour_utc: "2026-10-13T14:00:00.000Z", score: 70 });
    await insertHourly(h.db, { hour_utc: "2026-10-13T15:00:00.000Z", score: 75 });
    await insertHourly(h.db, { hour_utc: "2026-10-13T16:00:00.000Z", score: 80 });
    await insertHourly(h.db, { hour_utc: "2026-10-13T15:30:00.000Z", slug: "deerfield-beach", score: 1 });
    await insertHourly(h.db, { hour_utc: "2026-10-13T15:45:00.000Z", row_kind: "cam-backfill", score: 2 });
    const prev = await previousHourlyRow<{ score: number }>(h.db, "score", "boca-raton", "2026-10-13T16:00:00.000Z");
    expect(prev?.score).toBe(75);
    expect(await previousHourlyRow(h.db, "score", "boca-raton", "2026-10-13T14:00:00.000Z")).toBeNull();
    expect((await latestHourlyRow<{ score: number }>(h.db, "score", "boca-raton"))?.score).toBe(80);
  });
});
