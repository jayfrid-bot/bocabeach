// Store-level coverage for sun-event observations (migrations/0015) on the
// in-memory store: the upsert, the "best cam" rule, and the write-back onto
// sun_event_predictions. lib/db/d1Store.sql.test.ts runs the same rules
// against the real SQL.

import { describe, it, expect, beforeEach } from "vitest";
import { getStore } from "@/lib/db/store";
import { resetMemoryStore } from "@/lib/db/memoryStore";
import { observationRow, predictionRow } from "@/lib/sunObservations.fixtures";

const EVENT = "2026-10-06T11:15:09.672Z";

beforeEach(() => {
  resetMemoryStore();
});

async function truth() {
  const store = await getStore();
  const rows = await store.sunEventPredictionsFor("boca-raton", EVENT);
  return rows.map((r) => ({ score: r.observed_score, source: r.observed_source, at: r.observed_at }));
}

describe("recordSunEventObservation (memory store)", () => {
  it("stores the row, reads it back, and replaces it on a re-post of the same key", async () => {
    const store = await getStore();
    await store.recordSunEventObservation(observationRow({ observed_score: 70 }));
    await store.recordSunEventObservation(observationRow({ observed_score: 91, score_version: "v2" }));
    const rows = await store.sunEventObservationsFor("boca-raton", "sunrise", "2026-10-06");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ observed_score: 91, score_version: "v2" });
    expect(await store.sunEventObservationsFor("boca-raton", "sunset", "2026-10-06")).toEqual([]);
    expect(await store.sunEventObservationsFor("boca-raton", "sunrise", "2026-10-07")).toEqual([]);
  });

  it("returns the best observation first: solar before antisolar, then nearest, then cam_id", async () => {
    const store = await getStore();
    await store.recordSunEventObservation(observationRow({ cam_id: "z-cam", view: "antisolar", distance_mi: 0 }));
    await store.recordSunEventObservation(observationRow({ cam_id: "b-cam", view: "solar", distance_mi: 2.9 }));
    await store.recordSunEventObservation(observationRow({ cam_id: "a-cam", view: "solar", distance_mi: 2.9 }));
    await store.recordSunEventObservation(observationRow({ cam_id: "c-cam", view: "solar", distance_mi: 0.5 }));
    const order = (await store.sunEventObservationsFor("boca-raton", "sunrise", "2026-10-06")).map((r) => r.cam_id);
    expect(order).toEqual(["c-cam", "a-cam", "b-cam", "z-cam"]);
  });

  it("never overwrites a solar observation with an antisolar one, in either arrival order", async () => {
    const store = await getStore();
    await store.upsertSunEventPredictions([predictionRow()]);
    await store.recordSunEventObservation(observationRow({ cam_id: "solar-cam", view: "solar", distance_mi: 2.9, observed_score: 85 }));
    await store.recordSunEventObservation(observationRow({ cam_id: "anti-cam", view: "antisolar", distance_mi: 0, observed_score: 30 }));
    expect(await truth()).toEqual([{ score: 85, source: "sun-cam:solar-cam:solar", at: "2026-10-06T14:05:00.000Z" }]);

    resetMemoryStore();
    const fresh = await getStore();
    await fresh.upsertSunEventPredictions([predictionRow()]);
    await fresh.recordSunEventObservation(observationRow({ cam_id: "anti-cam", view: "antisolar", distance_mi: 0, observed_score: 30 }));
    expect(await truth()).toEqual([{ score: 30, source: "sun-cam:anti-cam:antisolar", at: "2026-10-06T14:05:00.000Z" }]);
    await fresh.recordSunEventObservation(observationRow({ cam_id: "solar-cam", view: "solar", distance_mi: 2.9, observed_score: 85 }));
    expect(await truth()).toEqual([{ score: 85, source: "sun-cam:solar-cam:solar", at: "2026-10-06T14:05:00.000Z" }]);
  });

  it("matches prediction rows within 15 minutes of the event, inclusive, and no further", async () => {
    const store = await getStore();
    const at = (min: number) => new Date(Date.parse(EVENT) + min * 60_000).toISOString();
    await store.upsertSunEventPredictions([
      predictionRow({ event_iso: at(-15), as_of_hour_utc: "2026-10-06T08:00:00.000Z", snapshot_generated_at: "2026-10-06T08:05:00.000Z" }),
      predictionRow({ event_iso: at(15), as_of_hour_utc: "2026-10-06T09:00:00.000Z", snapshot_generated_at: "2026-10-06T09:05:00.000Z" }),
      predictionRow({ event_iso: at(-16), as_of_hour_utc: "2026-10-06T07:00:00.000Z", snapshot_generated_at: "2026-10-06T07:05:00.000Z" }),
      predictionRow({ event_iso: at(16), as_of_hour_utc: "2026-10-06T06:00:00.000Z", snapshot_generated_at: "2026-10-06T06:05:00.000Z" }),
    ]);
    const r = await store.recordSunEventObservation(observationRow());
    expect(r.predictionsUpdated).toBe(2);
    const filled = async (min: number) => (await store.sunEventPredictionsFor("boca-raton", at(min)))[0].observed_score;
    expect(await filled(-15)).toBe(90);
    expect(await filled(15)).toBe(90);
    expect(await filled(-16)).toBeNull();
    expect(await filled(16)).toBeNull();
  });

  it("leaves a hand-labelled prediction alone and refreshes a sun-cam label", async () => {
    const store = await getStore();
    await store.upsertSunEventPredictions([
      predictionRow({ observed_score: 88, observed_source: "manual", observed_at: "2026-10-06T13:00:00.000Z" }),
    ]);
    expect((await store.recordSunEventObservation(observationRow())).predictionsUpdated).toBe(0);
    expect(await truth()).toEqual([{ score: 88, source: "manual", at: "2026-10-06T13:00:00.000Z" }]);

    resetMemoryStore();
    const s2 = await getStore();
    await s2.upsertSunEventPredictions([predictionRow()]);
    await s2.recordSunEventObservation(observationRow({ observed_score: 60 }));
    await s2.recordSunEventObservation(observationRow({ observed_score: 92 })); // a re-score
    expect((await truth())[0].score).toBe(92);
  });

  it("writes nothing onto another beach or the other event kind", async () => {
    const store = await getStore();
    await store.upsertSunEventPredictions([
      predictionRow({ slug: "fort-lauderdale" }),
      predictionRow({ event_kind: "sunset", as_of_hour_utc: "2026-10-06T10:00:00.000Z" }),
    ]);
    expect((await store.recordSunEventObservation(observationRow())).predictionsUpdated).toBe(0);
  });
});
