import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HAS_SQLITE, makeCamDb, type CamDb } from "@/lib/camFrames/testDb";
import { answerAlert, parseCorrect, verdictEffect } from "@/lib/quality/answer";
import { insertAlert } from "@/lib/quality/store";
import { insertFrame } from "@/lib/quality/testHelpers";
import type { HourlyAlertPayload, SeaweedAlertPayload } from "@/lib/quality/types";

const SHA = "ab".repeat(32);
const SHA20 = SHA.slice(0, 20);
const NOW = Date.parse("2026-10-13T17:45:00.000Z"); // 1:45 PM EDT

const seaweedPayload = (over: Partial<SeaweedAlertPayload> = {}): SeaweedAlertPayload => ({
  camId: "boca-inlet-surf",
  camName: "Boca Inlet Surf Cam",
  observedAt: "2026-10-13T17:20:00.000Z",
  published: { level: "none", pct: 0 },
  claim: { level: "moderate", coveragePct: 35, note: "rocks", provider: "gemini", model: "m" },
  secondOpinion: { provider: "clef", model: "m", level: "none", coveragePct: 0, note: null },
  others: [],
  claimTarget: { frameSha: SHA20, frameAt: "2026-10-13T17:19:30Z", claimedAt: "2026-10-13T17:21:00Z" },
  localDate: "2026-10-13",
  frame: { sha256: SHA, archivedThisTick: true },
  ...over,
});
const hourlyPayload: HourlyAlertPayload = {
  observedAt: "2026-10-13T17:00:00.000Z", fromHourUtc: "2026-10-13T16:00:00.000Z", from: 90, to: 60, delta: -30,
  cause: { key: "waves", label: "Sea state", delta: -20 }, published: { value: 60 }, localDate: "2026-10-13",
};

let h: CamDb;
beforeEach(() => {
  h = makeCamDb({ allMigrations: true }) as CamDb;
});
afterEach(() => {
  vi.restoreAllMocks();
  h?.close();
});

async function seaweedAlert(payload = seaweedPayload(), createdAt = "2026-10-13T17:30:00.000Z", key = "s1"): Promise<number> {
  return (await insertAlert(h.db, { slug: "boca-raton", signal: "seaweed", kind: "seaweed-held-disagreed", createdAt, payload, dedupeKey: key })).id;
}
async function hourlyAlert(signal: "score" | "surf" | "sand" | "clarity" = "score"): Promise<number> {
  return (await insertAlert(h.db, { slug: "boca-raton", signal, kind: "hourly-jump", createdAt: "2026-10-13T17:10:00.000Z", payload: hourlyPayload, dedupeKey: `h-${signal}` })).id;
}
const labels = (extra = "") => h.all(`SELECT id, alert_id, superseded, verdict, correct_value, r2_key FROM quality_labels ${extra} ORDER BY id`);
const overrides = () =>
  h.all("SELECT alert_id, superseded, cam_id, frame_sha, frame_at, claimed_at, local_date, verdict, action, level, coverage_pct, label_id, created_at_utc, until_utc FROM quality_overrides ORDER BY id");

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
    for (const bad of ["moderate", [], { level: "enormous" }, { word: "clear" }, {}, 5]) expect(parseCorrect("seaweed", bad)).toEqual({ ok: false });
    expect(parseCorrect("clarity", { word: "foggy" })).toEqual({ ok: false });
    for (const [s, v] of [["surf", -1], ["surf", 31], ["sand", 400], ["score", 101]] as const) expect(parseCorrect(s, { value: v })).toEqual({ ok: false });
    expect(parseCorrect("surf", { value: "3" })).toEqual({ ok: false });
    expect(parseCorrect("surf", { value: Number.NaN })).toEqual({ ok: false });
    expect(parseCorrect("crowd", { value: 3 })).toEqual({ ok: false });
  });
});

describe("verdictEffect", () => {
  const claim = seaweedPayload().claim;
  it("Right publishes the claim as it was", () => {
    expect(verdictEffect("right", claim, null)).toEqual({ action: "publish", level: "moderate", coveragePct: 35, note: "rocks" });
  });
  it("Wrong with a corrected moderate or high publishes at the corrected level", () => {
    expect(verdictEffect("wrong", claim, { level: "high" })).toEqual({ action: "publish", level: "high", coveragePct: null, note: null });
    expect(verdictEffect("wrong", claim, { level: "moderate" })).toMatchObject({ action: "publish", level: "moderate" });
  });
  it("Wrong with none, low, or no value rejects", () => {
    for (const c of [{ level: "none" }, { level: "low" }, null]) expect(verdictEffect("wrong", claim, c)).toEqual({ action: "reject", level: null, coveragePct: null, note: null });
  });
});

describe.skipIf(!HAS_SQLITE)("answerAlert: the verdict binds to the exact claim", () => {
  it("Right: a label, a closed alert, and a PUBLISH override carrying the claim's exact identity", async () => {
    const id = await seaweedAlert();
    await insertFrame(h.db, { sha256: SHA, at: "2026-10-13T17:21:00.000Z" });
    const r = await answerAlert(h.db, { alertId: id, verdict: "right", correct: { level: "none" } }, NOW);
    expect(r).toMatchObject({ ok: true, overrideAdded: true });
    expect((r as { why?: string }).why).toBeUndefined();
    const [label] = labels();
    expect(label).toMatchObject({ alert_id: id, superseded: 0, verdict: "right", correct_value: null });
    expect(String(label.r2_key)).toMatch(/^boca-raton\/boca-inlet-surf\/2026-10-13\/1721Z-/);
    expect(h.all("SELECT status, label_id FROM quality_alerts")[0]).toEqual({ status: "answered", label_id: label.id });
    expect(overrides()).toEqual([
      {
        alert_id: id, superseded: 0, cam_id: "boca-inlet-surf", frame_sha: SHA20, frame_at: "2026-10-13T17:19:30Z",
        claimed_at: "2026-10-13T17:21:00Z", local_date: "2026-10-13", verdict: "right", action: "publish", level: "moderate",
        coverage_pct: 35, label_id: label.id, created_at_utc: "2026-10-13T17:45:00.000Z", until_utc: "2026-10-14T04:00:00.000Z",
      },
    ]);
    expect(JSON.parse(h.all("SELECT claimed_value FROM quality_labels")[0].claimed_value as string).claimTarget).toEqual(seaweedPayload().claimTarget);
  });

  it("Wrong with a corrected moderate/high is a PUBLISH at the corrected level, with the truth in the label", async () => {
    const id = await seaweedAlert();
    await answerAlert(h.db, { alertId: id, verdict: "wrong", correct: { level: "high" } }, NOW);
    expect(overrides()[0]).toMatchObject({ verdict: "wrong", action: "publish", level: "high", coverage_pct: null });
    expect(JSON.parse(labels()[0].correct_value as string)).toEqual({ level: "high" });
  });

  it("Wrong with none, low, or no value is a REJECT", async () => {
    let n = 0;
    for (const correct of [{ level: "none" }, { level: "low" }, undefined]) {
      n += 1;
      const id = await seaweedAlert(seaweedPayload({ claimTarget: { frameSha: `${n}`.repeat(20), frameAt: null, claimedAt: "2026-10-13T17:21:00Z" } }), "2026-10-13T17:30:00.000Z", `k${n}`);
      await answerAlert(h.db, { alertId: id, verdict: "wrong", correct }, NOW);
    }
    expect(overrides().map((o) => [o.verdict, o.action, o.level])).toEqual([["wrong", "reject", null], ["wrong", "reject", null], ["wrong", "reject", null]]);
  });

  it("a claim with no frame identity is recorded as a label only: it cannot be told apart from its neighbors", async () => {
    const id = await seaweedAlert(seaweedPayload({ claimTarget: { frameSha: null, frameAt: null, claimedAt: null } }));
    const r = await answerAlert(h.db, { alertId: id, verdict: "wrong" }, NOW);
    expect(r).toMatchObject({ ok: true, overrideAdded: false, why: "unbound" });
    expect(overrides()).toEqual([]);
    expect(labels()).toHaveLength(1);
  });

  it("an alert about an EARLIER day stores the label only: yesterday's Wrong cannot suppress today's seaweed", async () => {
    const id = await seaweedAlert(seaweedPayload({ localDate: "2026-10-12" }), "2026-10-12T17:30:00.000Z");
    // 20 hours later, still inside the open window, but a different beach-local day
    const r = await answerAlert(h.db, { alertId: id, verdict: "wrong", correct: { level: "none" } }, Date.parse("2026-10-13T13:30:00.000Z"));
    expect(r).toMatchObject({ ok: true, overrideAdded: false, why: "earlier-day" });
    expect(overrides()).toEqual([]);
    expect(labels()).toHaveLength(1);
    expect(h.all("SELECT status FROM quality_alerts")[0].status).toBe("answered");
  });

  it("answering after midnight an alert from the night before is label only (cross-midnight)", async () => {
    const id = await seaweedAlert(seaweedPayload({ observedAt: "2026-10-14T02:30:00.000Z", localDate: "2026-10-13" }), "2026-10-14T02:35:00.000Z");
    const justAfterMidnight = Date.parse("2026-10-14T04:30:00.000Z"); // 12:30 AM EDT on the 14th
    expect(await answerAlert(h.db, { alertId: id, verdict: "wrong" }, justAfterMidnight)).toMatchObject({ overrideAdded: false, why: "earlier-day" });
    const before = await seaweedAlert(seaweedPayload({ observedAt: "2026-10-14T02:30:00.000Z", localDate: "2026-10-13" }), "2026-10-14T02:35:00.000Z", "again");
    expect(await answerAlert(h.db, { alertId: before, verdict: "wrong" }, Date.parse("2026-10-14T03:30:00.000Z"))).toMatchObject({ overrideAdded: true }); // 11:30 PM: still the 13th
    expect(overrides()[0].until_utc).toBe("2026-10-14T04:00:00.000Z");
  });

  it("an expired alert, and one older than the open window, store the label only", async () => {
    const a = await seaweedAlert();
    h.exec("UPDATE quality_alerts SET status = 'expired'");
    expect(await answerAlert(h.db, { alertId: a, verdict: "right" }, NOW)).toMatchObject({ overrideAdded: false, why: "expired" });
    const b = await seaweedAlert(seaweedPayload(), "2026-10-12T17:30:00.000Z", "old"); // status still 'open' but 28 h old
    expect(await answerAlert(h.db, { alertId: b, verdict: "right" }, NOW)).toMatchObject({ overrideAdded: false, why: "expired" });
    expect(overrides()).toEqual([]);
  });

  it("an hourly alert stores the label only, with the nearest frame of any cam", async () => {
    const id = await hourlyAlert("clarity");
    await insertFrame(h.db, { cam_id: "boca-south", at: "2026-10-13T17:12:00.000Z", sha256: "cd".repeat(32) });
    expect(await answerAlert(h.db, { alertId: id, verdict: "wrong", correct: { word: "murky" } }, NOW)).toMatchObject({ overrideAdded: false, why: "not-seaweed" });
    expect(String(labels()[0].r2_key)).toContain("boca-raton/boca-south/");
    expect(JSON.parse(labels()[0].correct_value as string)).toEqual({ word: "murky" });
    expect(overrides()).toEqual([]);
  });

  it("a label names the exact frame kept with the alert, ahead of any archived one", async () => {
    const key = "quality/boca-raton/boca-inlet-surf/2026-10-13/172015Z-abcdef12.jpg";
    const id = await seaweedAlert(seaweedPayload({ frame: { sha256: SHA, archivedThisTick: true, r2Key: key } }));
    await insertFrame(h.db, { sha256: SHA, at: "2026-10-13T17:21:00.000Z" });
    await answerAlert(h.db, { alertId: id, verdict: "right" }, NOW);
    expect(labels()[0].r2_key).toBe(key);
  });

  it("falls back to the nearest archived frame, then to none", async () => {
    const a = await seaweedAlert();
    await insertFrame(h.db, { sha256: "cd".repeat(32), at: "2026-10-13T17:05:00.000Z" });
    await answerAlert(h.db, { alertId: a, verdict: "right" }, NOW);
    expect(String(labels()[0].r2_key)).toContain("1705Z-cdcdcdcd");
    const b = await seaweedAlert(seaweedPayload({ camId: "boca-south" }), "2026-10-13T17:30:00.000Z", "nof");
    await answerAlert(h.db, { alertId: b, verdict: "right" }, NOW);
    expect(labels()[1].r2_key).toBeNull();
  });

  it("refuses an unknown alert and a bad correct value, writing nothing", async () => {
    const id = await seaweedAlert();
    expect(await answerAlert(h.db, { alertId: 999, verdict: "right" }, NOW)).toEqual({ ok: false, error: "not-found" });
    expect(await answerAlert(h.db, { alertId: id, verdict: "wrong", correct: { level: "huge" } }, NOW)).toEqual({ ok: false, error: "bad-correct" });
    expect(labels()).toEqual([]);
    expect(overrides()).toEqual([]);
    expect(h.all("SELECT status FROM quality_alerts")[0].status).toBe("open");
  });

  it("ignores a correct value on a Right tap", async () => {
    const id = await seaweedAlert();
    await answerAlert(h.db, { alertId: id, verdict: "right", correct: { level: "bogus" } }, NOW);
    expect(labels()[0].correct_value).toBeNull();
  });
});

describe.skipIf(!HAS_SQLITE)("answerAlert: one atomic step, and a second tap supersedes cleanly", () => {
  it("a second tap supersedes the first: one active label and one active override, the old ones kept as history", async () => {
    const id = await seaweedAlert();
    await answerAlert(h.db, { alertId: id, verdict: "right" }, NOW);
    const second = await answerAlert(h.db, { alertId: id, verdict: "wrong", correct: { level: "none" } }, NOW + 60_000);
    expect(second).toMatchObject({ ok: true, overrideAdded: true });
    expect(labels().map((l) => [l.verdict, l.superseded])).toEqual([["right", 1], ["wrong", 0]]);
    expect(overrides().map((o) => [o.verdict, o.action, o.superseded])).toEqual([["right", "publish", 1], ["wrong", "reject", 0]]);
    const active = labels("WHERE superseded = 0")[0];
    expect(h.all("SELECT label_id FROM quality_alerts")[0].label_id).toBe(active.id);
    expect(overrides().find((o) => o.superseded === 0)!.label_id).toBe(active.id);
    expect((second as { labelId: number }).labelId).toBe(active.id);
  });

  it("a tap that turns a live answer into a label-only one retires the old override", async () => {
    const id = await seaweedAlert();
    await answerAlert(h.db, { alertId: id, verdict: "right" }, NOW);
    // midnight passes; the owner changes the answer the next morning
    await answerAlert(h.db, { alertId: id, verdict: "wrong" }, Date.parse("2026-10-14T13:00:00.000Z"));
    expect(overrides().map((o) => o.superseded)).toEqual([1]);
    expect(labels("WHERE superseded = 0")).toHaveLength(1);
  });

  it("two taps at once leave exactly one active verdict, never two, and the label and override agree", async () => {
    const id = await seaweedAlert();
    const results = await Promise.all([
      answerAlert(h.db, { alertId: id, verdict: "right" }, NOW),
      answerAlert(h.db, { alertId: id, verdict: "wrong", correct: { level: "none" } }, NOW + 1),
      answerAlert(h.db, { alertId: id, verdict: "right" }, NOW + 2),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(labels()).toHaveLength(3);
    const activeLabels = labels("WHERE superseded = 0");
    const activeOverrides = overrides().filter((o) => o.superseded === 0);
    expect(activeLabels).toHaveLength(1);
    expect(activeOverrides).toHaveLength(1);
    expect(activeOverrides[0].verdict).toBe(activeLabels[0].verdict);
    expect(activeOverrides[0].label_id).toBe(activeLabels[0].id);
    expect(h.all("SELECT label_id FROM quality_alerts")[0].label_id).toBe(activeLabels[0].id);
  });

  it("the three writes are one step: if the override cannot be written, no label is left behind and the alert stays open", async () => {
    const id = await seaweedAlert();
    h.exec("DROP TABLE quality_overrides");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(answerAlert(h.db, { alertId: id, verdict: "right" }, NOW)).rejects.toThrow();
    expect(labels()).toEqual([]);
    expect(h.all("SELECT status, label_id FROM quality_alerts")[0]).toEqual({ status: "open", label_id: null });
  });

  it("a failed second tap changes nothing: the first answer is still the active one", async () => {
    const id = await seaweedAlert();
    await answerAlert(h.db, { alertId: id, verdict: "right" }, NOW);
    h.exec("CREATE TRIGGER fail_override BEFORE INSERT ON quality_overrides BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    await expect(answerAlert(h.db, { alertId: id, verdict: "wrong" }, NOW + 1000)).rejects.toThrow(/disk full/);
    expect(labels().map((l) => [l.verdict, l.superseded])).toEqual([["right", 0]]);
    expect(overrides().map((o) => [o.verdict, o.superseded])).toEqual([["right", 0]]);
  });
});
