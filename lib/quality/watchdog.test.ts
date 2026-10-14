import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HAS_SQLITE, makeCamDb, type CamDb } from "@/lib/camFrames/testDb";
import { alertFromDetection, JUMP_COLS, runHourlyWatchdog } from "@/lib/quality/watchdog";
import { detectJumps } from "@/lib/quality/jumps";
import { hourlyValues, insertHourly } from "@/lib/quality/testHelpers";
import type { HourlyAlertPayload } from "@/lib/quality/types";

let h: CamDb;
beforeEach(() => {
  h = makeCamDb({ allMigrations: true }) as CamDb;
});
afterEach(() => h?.close());

const NOW = Date.parse("2026-10-13T17:10:00.000Z"); // 1:10 PM EDT
const PREV = "2026-10-13T16:00:00.000Z";
const CUR = "2026-10-13T17:00:00.000Z";
const alerts = () => h.all("SELECT slug, signal, kind, pushed, dedupe_key FROM quality_alerts ORDER BY id");
const slots = () => h.all("SELECT alert_id, state FROM quality_push_slots");
const factors = (waves: number) =>
  JSON.stringify([
    { key: "airTemp", label: "Air temperature", score: 90, weight: 0.25 },
    { key: "sky", label: "Sky", score: 90, weight: 0.25 },
    { key: "wind", label: "Wind", score: 90, weight: 0.25 },
    { key: "waves", label: "Sea state", score: waves, weight: 0.25 },
  ]);

describe.skipIf(!HAS_SQLITE)("runHourlyWatchdog", () => {
  it("does nothing, in one read, when there is no earlier hour", async () => {
    const cur = await insertHourly(h.db, { hour_utc: CUR });
    expect(await runHourlyWatchdog(h.db, cur, NOW)).toEqual({ compared: false, found: 0, explained: 0, alertIds: [], queued: 0 });
    expect(alerts()).toEqual([]);
  });

  it("is quiet when nothing moved much", async () => {
    await insertHourly(h.db, { hour_utc: PREV });
    const cur = await insertHourly(h.db, { hour_utc: CUR, score: 78, sand_temp_f: 95 });
    expect(await runHourlyWatchdog(h.db, cur, NOW)).toMatchObject({ compared: true, found: 0 });
    expect(slots()).toEqual([]);
  });

  it("records an unexplained score drop and queues its push (it sends nothing itself)", async () => {
    await insertHourly(h.db, { hour_utc: PREV });
    const cur = await insertHourly(h.db, { hour_utc: CUR, score: 58, factors_json: factors(20) });
    const r = await runHourlyWatchdog(h.db, cur, NOW);
    expect(r).toMatchObject({ compared: true, found: 1, explained: 0, queued: 1 });
    expect(alerts()).toEqual([
      { slug: "boca-raton", signal: "score", kind: "hourly-jump", pushed: 0, dedupe_key: `hourly:boca-raton:score:${CUR}` },
    ]);
    expect(slots()).toEqual([{ alert_id: r.alertIds[0], state: "queued" }]);
    const stored = JSON.parse(h.all("SELECT payload_json FROM quality_alerts")[0].payload_json as string) as HourlyAlertPayload;
    expect(stored).toMatchObject({ from: 80, to: 58, delta: -22, fromHourUtc: PREV, observedAt: CUR, localDate: "2026-10-13" });
    expect(stored.cause).toMatchObject({ key: "waves", label: "Sea state", delta: -17.5 });
  });

  it("stores nothing for a jump that rain explains", async () => {
    await insertHourly(h.db, { hour_utc: PREV });
    const cur = await insertHourly(h.db, { hour_utc: CUR, score: 40, rain_now: 1 });
    expect(await runHourlyWatchdog(h.db, cur, NOW)).toMatchObject({ compared: true, found: 1, explained: 1, alertIds: [], queued: 0 });
    expect(alerts()).toEqual([]);
  });

  it("explains only what the matrix lets a cause explain: rain hides the clarity drop, not the surf jump", async () => {
    await insertHourly(h.db, { hour_utc: PREV });
    const cur = await insertHourly(h.db, { hour_utc: CUR, clarity_pct: 50, surf_ft: 6, rain_now: 1 });
    const r = await runHourlyWatchdog(h.db, cur, NOW);
    expect(r).toMatchObject({ found: 2, explained: 1 });
    expect(alerts().map((a) => a.signal)).toEqual(["surf"]);
  });

  it("alerts for each unexplained jump, and a re-run of the same hour adds nothing", async () => {
    await insertHourly(h.db, { hour_utc: PREV });
    const cur = await insertHourly(h.db, { hour_utc: CUR, sand_temp_f: 108, clarity_pct: 50 });
    const first = await runHourlyWatchdog(h.db, cur, NOW);
    expect(first.alertIds).toHaveLength(2);
    expect(await runHourlyWatchdog(h.db, cur, NOW + 60_000)).toMatchObject({ found: 2, alertIds: [], queued: 0 });
    expect(alerts().map((a) => a.signal).sort()).toEqual(["clarity", "sand"]);
  });

  it("an unwatched beach's alert is stored without a push slot", async () => {
    await insertHourly(h.db, { slug: "miami-beach", hour_utc: PREV });
    const cur = await insertHourly(h.db, { slug: "miami-beach", hour_utc: CUR, sand_temp_f: 70 });
    const r = await runHourlyWatchdog(h.db, cur, NOW);
    expect(r).toMatchObject({ found: 1, queued: 0 });
    expect(r.alertIds).toHaveLength(1);
    expect(slots()).toEqual([]);
  });

  it("reads only the columns it names", () => {
    const row = hourlyValues({ hour_utc: CUR });
    for (const col of JUMP_COLS.split(", ")) expect(col in row).toBe(true);
  });
});

describe("alertFromDetection", () => {
  it("builds the alert for one detection", () => {
    const prev = hourlyValues({ hour_utc: PREV }) as never;
    const cur = hourlyValues({ hour_utc: CUR, surf_ft: 5 }) as never;
    const [d] = detectJumps(prev, cur);
    expect(alertFromDetection(prev, cur, d, NOW)).toMatchObject({
      slug: "boca-raton",
      signal: "surf",
      kind: "hourly-jump",
      createdAt: "2026-10-13T17:10:00.000Z",
      dedupeKey: `hourly:boca-raton:surf:${CUR}`,
      payload: { from: 2, to: 5, delta: 3, published: { value: 5 }, observedAt: CUR, fromHourUtc: PREV, localDate: "2026-10-13" },
    });
  });
});
