import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  hourlyQuery,
  sqlStr,
  sunCallsQuery,
  sunLifetimeQuery,
  sunObservationsQuery,
  sunPairedQuery,
} from "@/lib/scorecard/queries";

// node:sqlite (Node 22.5+) runs the real SQL on a tiny in-memory table. Guarded:
// where it is missing the string checks below still run.
type Db = { exec(sql: string): void; prepare(sql: string): { all(): Record<string, unknown>[] } };
let makeDb: (() => Db) | null = null;
try {
  const sqlite = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (p: string) => Db };
  makeDb = () => new sqlite.DatabaseSync(":memory:");
} catch {
  makeDb = null;
}
const SINCE = "2026-07-01T00:00:00.000Z";

describe("sqlStr", () => {
  it("quotes and escapes", () => {
    expect(sqlStr("2026-10-06T00:00:00Z")).toBe("'2026-10-06T00:00:00Z'");
    expect(sqlStr("a'b")).toBe("'a''b'");
  });
});

describe("query text", () => {
  it("sun queries order newest events first BEFORE the limit, so a cap drops the oldest", () => {
    for (const q of [sunPairedQuery(SINCE, 500), sunCallsQuery(SINCE, 500)]) {
      expect(q).toMatch(/ORDER BY (p\.)?event_iso DESC/);
      expect(q.indexOf("ORDER BY")).toBeLessThan(q.indexOf("LIMIT 500"));
      expect(q).toContain(`event_iso >= '${SINCE}'`);
    }
  });

  it("the call query filters scored rows in both the outer query and the subquery, with a deterministic order", () => {
    const q = sunCallsQuery(SINCE, 500);
    expect(q).toContain("p.score IS NOT NULL");
    expect(q).toContain("q.score IS NOT NULL");
    expect(q).toContain("ORDER BY p.event_iso DESC, p.slug, p.event_kind");
  });

  it("the hourly query avoids the WINDOW keyword and reads only snapshot rows", () => {
    const q = hourlyQuery("2026-10-01T00:00:00.000Z", "2026-10-04T00:00:00.000Z");
    expect(q).toContain("AS win");
    expect(q).not.toMatch(/AS window\b/);
    expect(q).toContain("row_kind = 'snapshot'");
    expect(q).toContain("ORDER BY hour_utc, slug");
  });

  it("the observation query is bounded by the same window", () => {
    expect(sunObservationsQuery(SINCE)).toContain(`event_iso >= '${SINCE}'`);
  });
});

describe.skipIf(!makeDb)("query behaviour on real SQL", () => {
  function seed(): Db {
    const db = (makeDb as () => Db)();
    db.exec(`CREATE TABLE sun_event_predictions (
      slug TEXT, event_kind TEXT, event_iso TEXT, as_of_hour_utc TEXT, lead_minutes INTEGER,
      score INTEGER, band TEXT, algo_version TEXT, observed_score REAL, observed_source TEXT, archived_at TEXT);
      CREATE TABLE sun_event_observations (slug TEXT, event_kind TEXT, event_date_local TEXT, cam_id TEXT,
      event_iso TEXT, view TEXT, observed_score REAL, scored_at TEXT);`);
    return db;
  }
  const row = (
    event: string,
    asOf: string,
    lead: number,
    score: number | null,
    observed: number | null = null,
    slug = "boca-raton",
  ) =>
    `INSERT INTO sun_event_predictions VALUES ('${slug}', 'sunrise', '${event}', '${asOf}', ${lead}, ${score ?? "NULL"},
      NULL, 'v1', ${observed ?? "NULL"}, ${observed == null ? "NULL" : "'sun-cam:c:solar'"}, '${asOf}')`;

  it("the call is the latest SCORED forecast made 60+ minutes ahead; a later unscored row cannot hide it", () => {
    const db = seed();
    const e = "2026-10-06T11:15:00.000Z";
    db.exec(row(e, "2026-10-06T07:00:00.000Z", 255, 40)); // older
    db.exec(row(e, "2026-10-06T09:00:00.000Z", 135, 55)); // the call
    db.exec(row(e, "2026-10-06T10:00:00.000Z", 75, null)); // later, but unscored: must not win
    db.exec(row(e, "2026-10-06T11:00:00.000Z", 15, 70)); // too close to the event
    const rows = db.prepare(sunCallsQuery(SINCE, 100)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ as_of_hour_utc: "2026-10-06T09:00:00.000Z", score: 55 });
  });

  it("a row cap drops the OLDEST events and keeps the newest", () => {
    const db = seed();
    for (const day of ["06", "07", "08", "09"]) {
      db.exec(row(`2026-10-${day}T11:00:00.000Z`, `2026-10-${day}T05:00:00.000Z`, 360, 50, 60));
    }
    const paired = db.prepare(sunPairedQuery(SINCE, 2)).all();
    expect(paired.map((r) => r.event_iso)).toEqual(["2026-10-09T11:00:00.000Z", "2026-10-08T11:00:00.000Z"]);
    const calls = db.prepare(sunCallsQuery(SINCE, 2)).all();
    expect(calls.map((r) => r.event_iso)).toEqual(["2026-10-09T11:00:00.000Z", "2026-10-08T11:00:00.000Z"]);
  });

  it("events before the window are left out, and the lifetime query still counts them", () => {
    const db = seed();
    db.exec(row("2026-05-01T11:00:00.000Z", "2026-05-01T05:00:00.000Z", 360, 50, 60)); // before SINCE
    db.exec(row("2026-10-01T11:00:00.000Z", "2026-10-01T05:00:00.000Z", 360, 50, 60));
    expect(db.prepare(sunPairedQuery(SINCE, 100)).all()).toHaveLength(1);
    expect(db.prepare(sunCallsQuery(SINCE, 100)).all()).toHaveLength(1);
    const life = db.prepare(sunLifetimeQuery()).all()[0];
    expect(life).toMatchObject({ forecast_rows: 2, forecast_events: 2, paired_rows: 2, observations: 0 });
    expect(life.first_archived_at).toBe("2026-05-01T05:00:00.000Z");
  });

  it("the call ordering is deterministic across beaches and kinds", () => {
    const db = seed();
    const e = "2026-10-06T11:00:00.000Z";
    for (const slug of ["zeta", "alpha", "mid"]) db.exec(row(e, "2026-10-06T06:00:00.000Z", 300, 50, null, slug));
    const rows = db.prepare(sunCallsQuery(SINCE, 100)).all();
    expect(rows.map((r) => r.slug)).toEqual(["alpha", "mid", "zeta"]);
  });
});
