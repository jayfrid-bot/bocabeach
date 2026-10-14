import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HAS_SQLITE, makeCamDb, type CamDb } from "@/lib/camFrames/testDb";
import { NOTE_MAX, parseReport, saveReport } from "@/lib/quality/report";
import { insertFrame, insertHourly } from "@/lib/quality/testHelpers";

const NOW = Date.parse("2026-10-13T17:45:00.000Z");

describe("parseReport", () => {
  it("accepts any mix of fields and trims the note", () => {
    expect(parseReport({ slug: "boca-raton", seaweed: "low", clarity: "murky", surfFt: 3.25, sandF: 101, note: "  choppy  " })).toEqual({
      ok: true,
      value: { slug: "boca-raton", seaweed: "low", clarity: "murky", surfFt: 3.3, sandF: 101, note: "choppy" },
    });
    expect(parseReport({ slug: "boca-raton", sandF: 0 }).ok).toBe(false); // 0 F is not sand
    expect(parseReport({ slug: "boca-raton", surfFt: 0 })).toEqual({ ok: true, value: { slug: "boca-raton", surfFt: 0 } });
  });

  it("treats null and empty fields as not given, and a report of nothing as empty", () => {
    expect(parseReport({ slug: "boca-raton", seaweed: null, surfFt: "", note: "   " })).toEqual({ ok: false, error: "empty" });
    expect(parseReport({ slug: "boca-raton" })).toEqual({ ok: false, error: "empty" });
  });

  it("refuses an unknown beach, a bad word, or a number out of range", () => {
    expect(parseReport({ slug: "atlantis", seaweed: "low" })).toEqual({ ok: false, error: "unknown-beach" });
    expect(parseReport({ seaweed: "low" })).toEqual({ ok: false, error: "bad-request" });
    expect(parseReport({ slug: "boca-raton", seaweed: "lots" })).toEqual({ ok: false, error: "bad-request" });
    expect(parseReport({ slug: "boca-raton", clarity: "clear!" })).toEqual({ ok: false, error: "bad-request" });
    expect(parseReport({ slug: "boca-raton", surfFt: 99 })).toEqual({ ok: false, error: "bad-request" });
    expect(parseReport({ slug: "boca-raton", sandF: "hot" })).toEqual({ ok: false, error: "bad-request" });
    expect(parseReport({ slug: "boca-raton", note: 5 })).toEqual({ ok: false, error: "bad-request" });
  });

  it("cuts a long note", () => {
    const r = parseReport({ slug: "boca-raton", note: "x".repeat(NOTE_MAX + 100) });
    expect(r.ok && r.value.note).toHaveLength(NOTE_MAX);
  });
});

let h: CamDb;
beforeEach(() => {
  h = makeCamDb({ allMigrations: true }) as CamDb;
});
afterEach(() => h?.close());

describe.skipIf(!HAS_SQLITE)("saveReport", () => {
  it("saves one label per signal, each with the app's last value and the nearest frames", async () => {
    await insertHourly(h.db, { hour_utc: "2026-10-13T17:00:00.000Z", seaweed_level: "none", clarity_pct: 75, surf_ft: 2.5, sand_temp_f: 96 });
    await insertFrame(h.db, { cam_id: "boca-inlet-surf", at: "2026-10-13T17:40:00.000Z", sha256: "aa".repeat(32) });
    await insertFrame(h.db, { cam_id: "boca-south", at: "2026-10-13T17:20:00.000Z", sha256: "bb".repeat(32) });
    await insertFrame(h.db, { cam_id: "boca-south-surf", at: "2026-10-13T09:00:00.000Z", sha256: "cc".repeat(32) }); // far too old
    const r = await saveReport(h.db, { slug: "boca-raton", seaweed: "moderate", clarity: "murky", surfFt: 4, sandF: 110, note: "windy" }, NOW);
    expect(r.labelIds).toHaveLength(4);
    expect(r.frames).toBe(2);

    const rows = h.all("SELECT * FROM quality_labels ORDER BY id");
    expect(rows.map((x) => x.signal)).toEqual(["seaweed", "clarity", "surf", "sand"]);
    for (const row of rows) {
      expect(row).toMatchObject({ source: "report", verdict: null, claimed_value: null, note: "windy", observed_at_utc: "2026-10-13T17:45:00.000Z" });
      expect(row.r2_key).toContain("boca-inlet-surf"); // the nearest frame is first
      expect((JSON.parse(row.frames_json as string) as { camId: string }[]).map((f) => f.camId)).toEqual(["boca-inlet-surf", "boca-south"]);
    }
    expect(JSON.parse(rows[0].correct_value as string)).toEqual({ level: "moderate" });
    expect(JSON.parse(rows[0].published_value as string)).toEqual({ value: "none", hourUtc: "2026-10-13T17:00:00.000Z" });
    expect(JSON.parse(rows[1].correct_value as string)).toEqual({ word: "murky" });
    expect(JSON.parse(rows[1].published_value as string).value).toBe(75);
    expect(JSON.parse(rows[2].correct_value as string)).toEqual({ value: 4 });
    expect(JSON.parse(rows[2].published_value as string).value).toBe(2.5);
    expect(JSON.parse(rows[3].published_value as string).value).toBe(96);
  });

  it("saves only the signals given", async () => {
    const r = await saveReport(h.db, { slug: "boca-raton", seaweed: "none" }, NOW);
    expect(r).toEqual({ labelIds: [expect.any(Number)], frames: 0 });
    expect(h.all("SELECT signal, r2_key, frames_json FROM quality_labels")).toEqual([{ signal: "seaweed", r2_key: null, frames_json: null }]);
  });

  it("a note alone is one 'other' label", async () => {
    await saveReport(h.db, { slug: "boca-raton", note: "flag changed" }, NOW);
    expect(h.all("SELECT signal, note, correct_value, published_value FROM quality_labels")).toEqual([
      { signal: "other", note: "flag changed", correct_value: null, published_value: null },
    ]);
  });

  it("a beach with no archived hour records no 'what the app showed'", async () => {
    await saveReport(h.db, { slug: "boca-raton", sandF: 100 }, NOW);
    expect(JSON.parse(h.all("SELECT published_value FROM quality_labels")[0].published_value as string)).toEqual({ value: null, hourUtc: null });
  });

  it("does not attach another beach's frames", async () => {
    await insertFrame(h.db, { slug: "deerfield-beach", cam_id: "deerfield-beach-cam", at: "2026-10-13T17:40:00.000Z" });
    expect((await saveReport(h.db, { slug: "boca-raton", seaweed: "low" }, NOW)).frames).toBe(0);
  });
});
