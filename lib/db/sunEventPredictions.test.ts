// Store-level coverage for the sun-event prediction log
// (migrations/0013_sun_event_predictions.sql) on the in-memory store.

import { describe, it, expect, beforeEach } from "vitest";
import { getStore } from "@/lib/db/store";
import { resetMemoryStore } from "@/lib/db/memoryStore";
import type { SunEventPredictionRow } from "@/lib/history/types";

function sunRow(over: Partial<SunEventPredictionRow> = {}): SunEventPredictionRow {
  return {
    slug: "boca-raton",
    event_kind: "sunrise",
    event_iso: "2026-10-06T11:15:00.000Z",
    as_of_hour_utc: "2026-10-06T11:00:00.000Z",
    snapshot_generated_at: "2026-10-06T11:05:00.000Z",
    archived_at: "2026-10-06T11:05:01.000Z",
    lead_minutes: 10,
    score: 58,
    band: "good",
    model_path: "factor",
    note: "test note",
    breakdown_json: '{"horizonPath":"x","cloudCanvas":"y"}',
    low_cloud_pct: 0,
    mid_cloud_pct: 67,
    high_cloud_pct: 48,
    total_cloud_pct: 67,
    humidity_pct: 87,
    aod: 0.14,
    pm2_5: 13.6,
    horizon_cloud_pct: 40,
    horizon_source: "overhead",
    horizon_fresh: 1,
    seasonal_prior: 55,
    point_time: "2026-10-06T11:00:00.000Z",
    peak_color_iso: "2026-10-06T11:15:00.000Z",
    peak_offset_minutes: 0,
    algo_version: "2026-10-06.1",
    engine_version: "test-1",
    build_sha: "abc123",
    observed_score: null,
    observed_source: null,
    observed_at: null,
    ...over,
  };
}

beforeEach(() => {
  resetMemoryStore();
});

describe("upsertSunEventPredictions (memory store)", () => {
  it("writes a sunrise+sunset pair in one call and reads them back", async () => {
    const store = await getStore();
    const r = await store.upsertSunEventPredictions([
      sunRow(),
      sunRow({ event_kind: "sunset", event_iso: "2026-10-06T23:10:00.000Z", score: 70 }),
    ]);
    expect(r.written).toBe(2);
    const back = await store.sunEventPredictionsFor("boca-raton", "2026-10-06T11:15:00.000Z");
    expect(back).toHaveLength(1);
    expect(back[0].score).toBe(58);
  });

  it("keeps one row per as_of hour so an event's forecast history accumulates", async () => {
    const store = await getStore();
    for (const [h, score] of [["09", 40], ["10", 50], ["11", 58]] as const) {
      await store.upsertSunEventPredictions([
        sunRow({
          as_of_hour_utc: `2026-10-06T${h}:00:00.000Z`,
          snapshot_generated_at: `2026-10-06T${h}:05:00.000Z`,
          score,
        }),
      ]);
    }
    const hist = await store.sunEventPredictionsFor("boca-raton", "2026-10-06T11:15:00.000Z");
    expect(hist.map((r) => r.score)).toEqual([40, 50, 58]);
  });

  it("replaces only on a strictly newer snapshot, and never clears the observed_* columns", async () => {
    const store = await getStore();
    await store.upsertSunEventPredictions([sunRow()]);
    expect((await store.upsertSunEventPredictions([sunRow({ score: 1 })])).written).toBe(0); // same snapshot
    expect(
      (await store.upsertSunEventPredictions([sunRow({ snapshot_generated_at: "2026-10-06T11:30:00.000Z", score: 61 })]))
        .written,
    ).toBe(1);
    const [r] = await store.sunEventPredictionsFor("boca-raton", "2026-10-06T11:15:00.000Z");
    expect(r.score).toBe(61);
  });

  it("an empty batch is a no-op", async () => {
    const store = await getStore();
    expect(await store.upsertSunEventPredictions([])).toEqual({ written: 0 });
  });
});
