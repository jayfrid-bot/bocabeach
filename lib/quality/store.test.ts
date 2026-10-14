import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { D1Like } from "@/lib/db/d1Store";
import { HAS_SQLITE, makeCamDb, type CamDb } from "@/lib/camFrames/testDb";
import {
  activeOverrides,
  ALERT_OPEN_MS,
  expireOldAlerts,
  getAlert,
  insertAlert,
  insertLabel,
  latestHourlyRow,
  listAlerts,
  MAX_ALERTS_PER_SLUG_HOUR,
  previousHourlyRow,
  runAtomic,
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

const labelSql =
  "INSERT INTO quality_labels (alert_id, superseded, slug, signal, observed_at_utc, source, verdict, created_at) VALUES (?1, ?2, 'boca-raton', 'seaweed', 'x', 'alert', 'right', 'x')";
const overrideSql = (alertId: number, superseded: number) =>
  `INSERT INTO quality_overrides (alert_id, superseded, slug, signal, cam_id, local_date, verdict, action, created_at_utc, until_utc) VALUES (${alertId}, ${superseded}, 'boca-raton', 'seaweed', 'c', '2026-10-13', 'right', 'publish', 'x', 'y')`;

describe.skipIf(!HAS_SQLITE)("migration 0019", () => {
  it("creates the five tables", () => {
    const names = h
      .all("SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'quality_%' OR name = 'owner_sessions') ORDER BY name")
      .map((r) => r.name);
    expect(names).toEqual(["owner_sessions", "quality_alerts", "quality_labels", "quality_overrides", "quality_push_slots"]);
  });

  it("refuses a signal, status, source, verdict or action outside the allowed words", async () => {
    await expect(insertAlert(h.db, alert({ signal: "weather" }))).rejects.toThrow();
    await expect(
      insertLabel(h.db, { slug: "s", signal: "seaweed", observedAt: "x", source: "alert", verdict: "maybe" as never, createdAt: "x" }),
    ).rejects.toThrow();
    await expect(
      insertLabel(h.db, { slug: "s", signal: "seaweed", observedAt: "x", source: "chat" as never, verdict: null, createdAt: "x" }),
    ).rejects.toThrow();
    await insertAlert(h.db, alert());
    expect(() => h.exec("UPDATE quality_alerts SET status = 'gone'")).toThrow();
    expect(() => h.exec(overrideSql(1, 0).replace("'publish'", "'maybe'"))).toThrow();
    expect(() => h.exec("INSERT INTO owner_sessions (device_id, token_hash, created_at, last_seen, revoked) VALUES ('d', 'h', 'x', 'x', 2)")).toThrow();
  });

  it("allows one ACTIVE label and one ACTIVE override per alert, and any number once superseded", async () => {
    await h.db.prepare(labelSql).bind(7, 0).run();
    await expect(h.db.prepare(labelSql).bind(7, 0).run()).rejects.toThrow(/UNIQUE/);
    await h.db.prepare(labelSql).bind(7, 1).run();
    await h.db.prepare(labelSql).bind(7, 1).run();
    await h.db.prepare(labelSql).bind(null, 0).run(); // reports have no alert: any number
    await h.db.prepare(labelSql).bind(null, 0).run();
    h.exec(overrideSql(7, 0));
    expect(() => h.exec(overrideSql(7, 0))).toThrow(/UNIQUE/);
    h.exec(overrideSql(7, 1));
    h.exec(overrideSql(8, 0));
  });

  it("owner tokens are stored by hash and a hash is never stored twice", () => {
    h.exec("INSERT INTO owner_sessions (device_id, token_hash, created_at, last_seen) VALUES ('d', 'abc', 'x', 'x')");
    expect(() => h.exec("INSERT INTO owner_sessions (device_id, token_hash, created_at, last_seen) VALUES ('d2', 'abc', 'x', 'x')")).toThrow(/UNIQUE/);
  });

  it("a push slot number repeats never inside one owner day", () => {
    const slot = (alert: number, day: string, n: number) =>
      `INSERT INTO quality_push_slots (alert_id, slug, signal, owner_day, slot, reserved_at) VALUES (${alert}, 's', 'score', '${day}', ${n}, 'x')`;
    h.exec(slot(1, "2026-10-13", 1));
    expect(() => h.exec(slot(2, "2026-10-13", 1))).toThrow(/UNIQUE/);
    h.exec(slot(2, "2026-10-14", 1));
    expect(() => h.exec(slot(1, "2026-10-14", 2))).toThrow(/UNIQUE/); // one slot per alert
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

  it("refuses the 21st alert for one beach inside an hour, inside the INSERT itself", async () => {
    expect(MAX_ALERTS_PER_SLUG_HOUR).toBe(20);
    const lim = { maxPerSlugPerHour: MAX_ALERTS_PER_SLUG_HOUR };
    for (let i = 0; i < 20; i++) {
      expect((await insertAlert(h.db, alert({ dedupeKey: `k${i}`, createdAt: `2026-10-13T17:${String(10 + i).padStart(2, "0")}:00.000Z` }), lim)).created).toBe(true);
    }
    const over = await insertAlert(h.db, alert({ dedupeKey: "k20", createdAt: "2026-10-13T17:45:00.000Z" }), lim);
    expect(over).toEqual({ id: 0, created: false, limited: true });
    expect(h.all("SELECT COUNT(*) AS n FROM quality_alerts")[0].n).toBe(20);
    // another beach is not affected; a duplicate of an existing alert is a duplicate, not a limit
    expect((await insertAlert(h.db, alert({ slug: "deerfield-beach", dedupeKey: "d1", createdAt: "2026-10-13T17:45:00.000Z" }), lim)).created).toBe(true);
    expect(await insertAlert(h.db, alert({ dedupeKey: "k3" }), lim)).toMatchObject({ created: false });
    expect((await insertAlert(h.db, alert({ dedupeKey: "k3" }), lim)).limited).toBeUndefined();
    // an hour later the window has moved on
    expect((await insertAlert(h.db, alert({ dedupeKey: "later", createdAt: "2026-10-13T19:00:00.000Z" }), lim)).created).toBe(true);
  });

  it("the hourly limit holds when many alerts arrive at once", async () => {
    const lim = { maxPerSlugPerHour: 5 };
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => insertAlert(h.db, alert({ dedupeKey: `p${i}` }), lim)));
    expect(results.filter((r) => r.created)).toHaveLength(5);
    expect(h.all("SELECT COUNT(*) AS n FROM quality_alerts")[0].n).toBe(5);
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

  it("listAlerts is newest first, respects the limit, and shows the ACTIVE label's verdict", async () => {
    for (let i = 1; i <= 5; i++) await insertAlert(h.db, alert({ createdAt: `2026-10-13T1${i}:00:00.000Z`, dedupeKey: `k${i}` }));
    expect((await listAlerts(h.db, 3)).map((r) => r.dedupe_key)).toEqual(["k5", "k4", "k3"]);
    h.exec(
      "INSERT INTO quality_labels (id, alert_id, slug, signal, observed_at_utc, source, verdict, correct_value, created_at) VALUES (90, 5, 'boca-raton', 'seaweed', 'x', 'alert', 'wrong', '{\"level\":\"none\"}', 'x')",
    );
    h.exec("UPDATE quality_alerts SET status = 'answered', label_id = 90 WHERE dedupe_key = 'k5'");
    const [top] = await listAlerts(h.db, 1);
    expect(top).toMatchObject({ dedupe_key: "k5", status: "answered", label_id: 90, label_verdict: "wrong" });
    expect(JSON.parse(top.label_correct!)).toEqual({ level: "none" });
  });
});

describe.skipIf(!HAS_SQLITE)("labels and overrides", () => {
  it("stores JSON columns as JSON text and nulls the ones it was not given", async () => {
    const id = await insertLabel(h.db, {
      slug: "boca-raton", signal: "surf", observedAt: "2026-10-13T17:00:00.000Z", source: "report",
      published: { value: 3 }, verdict: null, correct: { value: 2 }, frames: [{ camId: "a" }], note: "choppy", createdAt: "2026-10-13T17:01:00.000Z",
    });
    const row = h.all("SELECT * FROM quality_labels WHERE id = ?", id)[0];
    expect(row).toMatchObject({ source: "report", verdict: null, claimed_value: null, cam_id: null, r2_key: null, note: "choppy", alert_id: null, superseded: 0 });
    expect(JSON.parse(row.published_value as string)).toEqual({ value: 3 });
    expect(JSON.parse(row.frames_json as string)).toEqual([{ camId: "a" }]);
  });

  it("activeOverrides lists only the beach's seaweed overrides that have not ended or been superseded", async () => {
    const ins = (alert: number, over: Record<string, unknown> = {}) => {
      const v = { slug: "boca-raton", signal: "seaweed", cam: "boca-inlet-surf", until: "2026-10-14T04:00:00.000Z", sup: 0, ...over };
      h.exec(
        `INSERT INTO quality_overrides (alert_id, superseded, slug, signal, cam_id, frame_sha, local_date, verdict, action, level, created_at_utc, until_utc) VALUES (${alert}, ${v.sup}, '${v.slug}', '${v.signal}', '${v.cam}', 'aaaaaaaaaaaaaaaaaaaa', '2026-10-13', 'right', 'publish', 'moderate', '2026-10-13T17:00:00.000Z', '${v.until}')`,
      );
    };
    ins(1);
    ins(2, { cam: "ended", until: "2026-10-13T18:00:00.000Z" });
    ins(3, { slug: "deerfield-beach" });
    ins(4, { signal: "clarity" });
    ins(5, { cam: "replaced", sup: 1 });
    const live = await activeOverrides(h.db, "boca-raton", "seaweed", Date.parse("2026-10-13T20:00:00.000Z"));
    expect(live.map((o) => o.cam_id)).toEqual(["boca-inlet-surf"]);
    expect(live[0]).toMatchObject({ verdict: "right", action: "publish", level: "moderate", frame_sha: "aaaaaaaaaaaaaaaaaaaa", local_date: "2026-10-13" });
    expect(await activeOverrides(h.db, "boca-raton", "seaweed", Date.parse("2026-10-14T05:00:00.000Z"))).toEqual([]);
  });
});

describe.skipIf(!HAS_SQLITE)("runAtomic", () => {
  it("runs every statement or none: a failing one rolls the whole batch back", async () => {
    const ok = h.db.prepare("INSERT INTO quality_alerts (slug, signal, kind, created_at, payload_json, dedupe_key) VALUES ('s', 'score', 'hourly-jump', 'x', '{}', 'one')");
    const bad = h.db.prepare("INSERT INTO quality_alerts (slug, signal, kind, created_at, payload_json, dedupe_key) VALUES ('s', 'not-a-signal', 'x', 'x', '{}', 'two')");
    await expect(runAtomic(h.db, [ok, bad])).rejects.toThrow();
    expect(h.all("SELECT COUNT(*) AS n FROM quality_alerts")[0].n).toBe(0);
    await runAtomic(h.db, [ok]);
    expect(h.all("SELECT COUNT(*) AS n FROM quality_alerts")[0].n).toBe(1);
  });

  it("refuses a database that cannot batch, rather than running the statements one by one", async () => {
    const noBatch: D1Like = { prepare: h.db.prepare.bind(h.db) };
    await expect(runAtomic(noBatch, [h.db.prepare("SELECT 1")])).rejects.toThrow(/atomic/);
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
