import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HAS_SQLITE, makeCamDb, type CamDb } from "@/lib/camFrames/testDb";
import { answerAlert, parseCorrect } from "@/lib/quality/answer";
import { insertAlert } from "@/lib/quality/store";
import { insertFrame } from "@/lib/quality/testHelpers";
import type { HourlyAlertPayload, SeaweedAlertPayload } from "@/lib/quality/types";

const SHA = "ab".repeat(32);
const NOW = Date.parse("2026-10-13T17:45:00.000Z"); // 1:45 PM EDT

const seaweedPayload: SeaweedAlertPayload = {
  camId: "boca-inlet-surf",
  camName: "Boca Inlet Surf Cam",
  observedAt: "2026-10-13T17:20:00.000Z",
  published: { level: "none", pct: 0 },
  claim: { level: "moderate", coveragePct: 35, note: "rocks", provider: "gemini", model: "m" },
  secondOpinion: { provider: "clef", model: "m", level: "none", coveragePct: 0, note: null },
  others: [],
  frame: { sha256: SHA, archivedThisTick: true },
};
const hourlyPayload: HourlyAlertPayload = {
  observedAt: "2026-10-13T17:00:00.000Z",
  fromHourUtc: "2026-10-13T16:00:00.000Z",
  from: 90,
  to: 60,
  delta: -30,
  cause: { key: "waves", label: "Sea state", delta: -20 },
  published: { value: 60 },
};

let h: CamDb;
beforeEach(() => {
  h = makeCamDb({ allMigrations: true }) as CamDb;
});
afterEach(() => h?.close());

async function seaweedAlert(): Promise<number> {
  return (
    await insertAlert(h.db, {
      slug: "boca-raton", signal: "seaweed", kind: "seaweed-held-disagreed",
      createdAt: "2026-10-13T17:30:00.000Z", payload: seaweedPayload, dedupeKey: "s1",
    })
  ).id;
}
async function hourlyAlert(signal: "score" | "surf" | "sand" | "clarity" = "score"): Promise<number> {
  return (
    await insertAlert(h.db, {
      slug: "boca-raton", signal, kind: "hourly-jump",
      createdAt: "2026-10-13T17:10:00.000Z", payload: hourlyPayload, dedupeKey: `h-${signal}`,
    })
  ).id;
}

describe("parseCorrect", () => {
  it("accepts the owner's words and numbers per signal", () => {
    expect(parseCorrect("seaweed", { level: "low" })).toEqual({ ok: true, value: { level: "low" } });
    expect(parseCorrect("clarity", { word: "slightly_murky" })).toEqual({ ok: true, value: { word: "slightly_murky" } });
    expect(parseCorrect("surf", { value: 3.25 })).toEqual({ ok: true, value: { value: 3.3 } });
    expect(parseCorrect("sand", { value: 104 })).toEqual({ ok: true, value: { value: 104 } });
    expect(parseCorrect("score", { value: 0 })).toEqual({ ok: true, value: { value: 0 } });
  });

  it("nothing given is fine", () => {
    for (const s of ["seaweed", "clarity", "surf", "sand", "score", "crowd", "other"] as const) {
      expect(parseCorrect(s, undefined)).toEqual({ ok: true, value: null });
      expect(parseCorrect(s, null)).toEqual({ ok: true, value: null });
    }
  });

  it("refuses the wrong shape, an unknown word, or a number out of range", () => {
    for (const bad of ["moderate", [], { level: "enormous" }, { word: "clear" }, {}, 5]) {
      expect(parseCorrect("seaweed", bad)).toEqual({ ok: false });
    }
    expect(parseCorrect("clarity", { word: "foggy" })).toEqual({ ok: false });
    expect(parseCorrect("surf", { value: -1 })).toEqual({ ok: false });
    expect(parseCorrect("surf", { value: 31 })).toEqual({ ok: false });
    expect(parseCorrect("sand", { value: 400 })).toEqual({ ok: false });
    expect(parseCorrect("score", { value: 101 })).toEqual({ ok: false });
    expect(parseCorrect("surf", { value: "3" })).toEqual({ ok: false });
    expect(parseCorrect("surf", { value: Number.NaN })).toEqual({ ok: false });
    expect(parseCorrect("crowd", { value: 3 })).toEqual({ ok: false });
  });
});

describe.skipIf(!HAS_SQLITE)("answerAlert", () => {
  it("Right: writes a label with the claim, closes the alert, and adds a Right override that publishes the claim", async () => {
    const id = await seaweedAlert();
    await insertFrame(h.db, { sha256: SHA, at: "2026-10-13T17:21:00.000Z" });
    const r = await answerAlert(h.db, { alertId: id, verdict: "right", correct: { level: "none" } }, NOW);
    expect(r).toMatchObject({ ok: true, overrideAdded: true });
    const label = h.all("SELECT * FROM quality_labels")[0];
    expect(label).toMatchObject({
      slug: "boca-raton", signal: "seaweed", source: "alert", verdict: "right", correct_value: null, cam_id: "boca-inlet-surf",
      observed_at_utc: "2026-10-13T17:20:00.000Z", created_at: "2026-10-13T17:45:00.000Z",
    });
    expect(JSON.parse(label.claimed_value as string)).toMatchObject({ level: "moderate", coveragePct: 35 });
    expect(JSON.parse(label.published_value as string)).toEqual({ level: "none", pct: 0 });
    expect(label.r2_key).toMatch(/^boca-raton\/boca-inlet-surf\/2026-10-13\/1721Z-/);
    expect(h.all("SELECT status, label_id FROM quality_alerts")[0]).toEqual({ status: "answered", label_id: label.id });
    const [o] = h.all("SELECT slug, signal, cam_id, verdict, claim_json, created_at_utc, until_utc, label_id FROM quality_overrides");
    expect(o).toMatchObject({
      slug: "boca-raton", signal: "seaweed", cam_id: "boca-inlet-surf", verdict: "right", label_id: label.id,
      created_at_utc: "2026-10-13T17:45:00.000Z", until_utc: "2026-10-14T04:00:00.000Z",
    });
    expect(JSON.parse(o.claim_json as string)).toEqual({ level: "moderate", coveragePct: 35, note: "rocks" });
  });

  it("Wrong on a seaweed alert: stores the truth and adds a Wrong override to the end of the beach day", async () => {
    const id = await seaweedAlert();
    const r = await answerAlert(h.db, { alertId: id, verdict: "wrong", correct: { level: "none" } }, NOW);
    expect(r).toMatchObject({ ok: true, overrideAdded: true });
    const label = h.all("SELECT * FROM quality_labels")[0];
    expect(label).toMatchObject({ verdict: "wrong" });
    expect(JSON.parse(label.correct_value as string)).toEqual({ level: "none" });
    expect(h.all("SELECT slug, signal, cam_id, verdict, claim_json, created_at_utc, until_utc, label_id FROM quality_overrides")).toEqual([
      {
        slug: "boca-raton", signal: "seaweed", cam_id: "boca-inlet-surf", verdict: "wrong", claim_json: null,
        created_at_utc: "2026-10-13T17:45:00.000Z",
        until_utc: "2026-10-14T04:00:00.000Z", // midnight EDT
        label_id: label.id,
      },
    ]);
  });

  it("Wrong with no value given still closes the alert and drops the claim", async () => {
    const id = await seaweedAlert();
    const r = await answerAlert(h.db, { alertId: id, verdict: "wrong" }, NOW);
    expect(r).toMatchObject({ ok: true, overrideAdded: true });
    expect(h.all("SELECT correct_value FROM quality_labels")[0].correct_value).toBeNull();
  });

  it("Wrong on an hourly alert stores the label only (no override for other signals yet)", async () => {
    const id = await hourlyAlert("score");
    const r = await answerAlert(h.db, { alertId: id, verdict: "wrong", correct: { value: 82 } }, NOW);
    expect(r).toMatchObject({ ok: true, overrideAdded: false });
    const label = h.all("SELECT * FROM quality_labels")[0];
    expect(label).toMatchObject({ signal: "score", verdict: "wrong", cam_id: null, observed_at_utc: "2026-10-13T17:00:00.000Z" });
    expect(JSON.parse(label.correct_value as string)).toEqual({ value: 82 });
    expect(JSON.parse(label.claimed_value as string)).toMatchObject({ from: 90, to: 60 });
    expect(h.all("SELECT * FROM quality_overrides")).toEqual([]);
  });

  it("an hourly label records the nearest frame of any cam", async () => {
    const id = await hourlyAlert("clarity");
    await insertFrame(h.db, { cam_id: "boca-south", at: "2026-10-13T17:12:00.000Z", sha256: "cd".repeat(32) });
    await answerAlert(h.db, { alertId: id, verdict: "right" }, NOW);
    expect(h.all("SELECT r2_key FROM quality_labels")[0].r2_key).toContain("boca-raton/boca-south/");
  });

  it("falls back to the nearest frame of the cam when the exact one was not archived", async () => {
    const id = await seaweedAlert();
    await insertFrame(h.db, { sha256: "cd".repeat(32), at: "2026-10-13T17:05:00.000Z" });
    await answerAlert(h.db, { alertId: id, verdict: "right" }, NOW);
    expect(h.all("SELECT r2_key FROM quality_labels")[0].r2_key).toContain("1705Z-cdcdcdcd");
  });

  it("a label with no frame at all still saves", async () => {
    const id = await seaweedAlert();
    await answerAlert(h.db, { alertId: id, verdict: "right" }, NOW);
    expect(h.all("SELECT r2_key FROM quality_labels")[0].r2_key).toBeNull();
  });

  it("refuses a second answer, an unknown alert, and a bad correct value, writing nothing", async () => {
    const id = await seaweedAlert();
    expect(await answerAlert(h.db, { alertId: 999, verdict: "right" }, NOW)).toEqual({ ok: false, error: "not-found" });
    expect(await answerAlert(h.db, { alertId: id, verdict: "wrong", correct: { level: "huge" } }, NOW)).toEqual({ ok: false, error: "bad-correct" });
    expect(h.all("SELECT COUNT(*) AS n FROM quality_labels")[0].n).toBe(0);
    expect((await answerAlert(h.db, { alertId: id, verdict: "right" }, NOW)).ok).toBe(true);
    expect(await answerAlert(h.db, { alertId: id, verdict: "wrong" }, NOW)).toEqual({ ok: false, error: "already-answered" });
    expect(h.all("SELECT COUNT(*) AS n FROM quality_labels")[0].n).toBe(1);
    expect(h.all("SELECT COUNT(*) AS n FROM quality_overrides")[0].n).toBe(1); // the one from the first, real answer
  });

  it("an expired alert can still be answered", async () => {
    const id = await seaweedAlert();
    h.exec("UPDATE quality_alerts SET status = 'expired'");
    expect((await answerAlert(h.db, { alertId: id, verdict: "right" }, NOW)).ok).toBe(true);
  });

  it("a label names the exact frame kept with the alert, ahead of any archived one", async () => {
    const key = "quality/boca-raton/boca-inlet-surf/2026-10-13/172015Z-abcdef12.jpg";
    const id = (
      await insertAlert(h.db, {
        slug: "boca-raton", signal: "seaweed", kind: "seaweed-held-disagreed", createdAt: "2026-10-13T17:30:00.000Z", dedupeKey: "x",
        payload: { ...seaweedPayload, frame: { sha256: SHA, archivedThisTick: true, r2Key: key } },
      })
    ).id;
    await insertFrame(h.db, { sha256: SHA, at: "2026-10-13T17:21:00.000Z" });
    await answerAlert(h.db, { alertId: id, verdict: "right" }, NOW);
    expect(h.all("SELECT r2_key FROM quality_labels")[0].r2_key).toBe(key);
  });

  it("ignores a correct value on a Right tap", async () => {
    const id = await seaweedAlert();
    await answerAlert(h.db, { alertId: id, verdict: "right", correct: { level: "bogus" } }, NOW);
    expect(h.all("SELECT correct_value FROM quality_labels")[0].correct_value).toBeNull();
  });
});
