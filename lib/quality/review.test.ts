import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HAS_SQLITE, makeCamDb, type CamDb } from "@/lib/camFrames/testDb";
import { loadReview, shapeAlert } from "@/lib/quality/review";
import { frameBySha, nearestFrame, nearestFramesAllCams, signedFrameUrl, toFrameView } from "@/lib/quality/frames";
import { answerAlert } from "@/lib/quality/answer";
import { insertAlert, type AlertWithLabel } from "@/lib/quality/store";
import { insertFrame } from "@/lib/quality/testHelpers";
import { verify } from "@/lib/camFrames/sign";
import type { HourlyAlertPayload, SeaweedAlertPayload } from "@/lib/quality/types";

const SHA = "ab".repeat(32);
const NOW = Date.parse("2026-10-13T17:45:00.000Z");

const seaweedPayload: SeaweedAlertPayload = {
  camId: "boca-inlet-surf",
  camName: "Boca Inlet Surf Cam",
  observedAt: "2026-10-13T17:20:00.000Z",
  published: { level: "none", pct: 0 },
  claim: { level: "moderate", coveragePct: 35, note: "rocks", provider: "gemini", model: "m" },
  secondOpinion: { provider: "clef", model: "m", level: "none", coveragePct: 0, note: null },
  others: [{ id: "boca-south", name: "Boca South", level: "none", coveragePct: 0, carried: false }],
  frame: { sha256: SHA, archivedThisTick: true },
};
const hourlyPayload: HourlyAlertPayload = {
  observedAt: "2026-10-13T17:00:00.000Z",
  fromHourUtc: "2026-10-13T16:00:00.000Z",
  from: 80, to: 55, delta: -25, cause: null, published: { value: 55 },
};

function row(over: Partial<AlertWithLabel> = {}): AlertWithLabel {
  return {
    id: 7, slug: "boca-raton", signal: "seaweed", kind: "seaweed-held-disagreed",
    created_at: "2026-10-13T17:30:00.000Z", payload_json: JSON.stringify(seaweedPayload),
    status: "open", label_id: null, dedupe_key: "k", pushed: 1, label_verdict: null, label_correct: null,
    ...over,
  };
}

describe("shapeAlert", () => {
  it("shapes a seaweed alert for the card", () => {
    const v = shapeAlert(row())!;
    expect(v).toMatchObject({
      id: 7, beach: "Boca Raton", signal: "seaweed", signalWord: "Seaweed", status: "open", pushed: true, input: "seaweed", unit: "",
      statement: "Boca Inlet Surf cam says moderate seaweed (35%)",
      secondOpinion: "A second reading (Clef) says none.",
      others: [{ name: "Boca South", level: "none", carried: false }],
      answer: null, frames: [],
    });
    expect(v.published).toContain("showed none");
  });

  it("says plainly when the second reading had no level, and when the beach showed nothing", () => {
    const p = { ...seaweedPayload, published: null, secondOpinion: { ...seaweedPayload.secondOpinion, level: null, provider: "other" } };
    const v = shapeAlert(row({ payload_json: JSON.stringify(p) }))!;
    expect(v.secondOpinion).toBe("A second reading (other) says no seaweed level.");
    expect(v.published).toMatch(/^Held back/);
  });

  it("shapes an hourly alert and picks the right answer input and unit", () => {
    const base = { kind: "hourly-jump" as const, payload_json: JSON.stringify(hourlyPayload) };
    expect(shapeAlert(row({ ...base, signal: "score" }))).toMatchObject({ input: "number", unit: "", statement: "Beach Day score went from 80 to 55 in an hour", others: [], published: null });
    expect(shapeAlert(row({ ...base, signal: "surf" }))).toMatchObject({ input: "number", unit: "ft" });
    expect(shapeAlert(row({ ...base, signal: "sand" }))).toMatchObject({ input: "number", unit: "F" });
    expect(shapeAlert(row({ ...base, signal: "clarity" }))).toMatchObject({ input: "clarity" });
  });

  it("carries the owner's answer", () => {
    const v = shapeAlert(row({ status: "answered", label_id: 3, label_verdict: "wrong", label_correct: JSON.stringify({ level: "low" }) }))!;
    expect(v.answer).toEqual({ verdict: "wrong", correct: { level: "low" } });
  });

  it("returns null for an unreadable payload", () => {
    expect(shapeAlert(row({ payload_json: "{nope" }))).toBeNull();
  });
});

let h: CamDb;
beforeEach(() => {
  process.env.CAM_FRAME_URL_KEY = "test-signing-key";
  h = makeCamDb({ allMigrations: true }) as CamDb;
});
afterEach(() => {
  delete process.env.CAM_FRAME_URL_KEY;
  h?.close();
});

describe.skipIf(!HAS_SQLITE)("frames", () => {
  it("frameBySha finds the exact image, and refuses a malformed hash", async () => {
    await insertFrame(h.db, { sha256: SHA, at: "2026-10-13T17:21:00.000Z" });
    await insertFrame(h.db, { sha256: "cd".repeat(32), at: "2026-10-13T17:22:00.000Z", cam_id: "boca-south" });
    expect((await frameBySha(h.db, "boca-raton", "boca-inlet-surf", SHA))?.camId).toBe("boca-inlet-surf");
    expect(await frameBySha(h.db, "boca-raton", "boca-south", SHA)).toBeNull(); // right hash, wrong cam
    expect(await frameBySha(h.db, "boca-raton", "boca-inlet-surf", "short")).toBeNull();
  });

  it("nearestFrame picks the closest ready frame inside the window", async () => {
    await insertFrame(h.db, { at: "2026-10-13T16:50:00.000Z", sha256: "11".repeat(32) });
    await insertFrame(h.db, { at: "2026-10-13T17:15:00.000Z", sha256: "22".repeat(32) });
    await insertFrame(h.db, { at: "2026-10-13T17:50:00.000Z", sha256: "33".repeat(32) });
    expect((await nearestFrame(h.db, "boca-raton", "boca-inlet-surf", NOW - 20 * 60_000))?.sha256).toBe("22".repeat(32));
    expect(await nearestFrame(h.db, "boca-raton", "boca-inlet-surf", Date.parse("2026-10-13T12:00:00.000Z"))).toBeNull();
    expect(await nearestFrame(h.db, "boca-raton", "boca-south", NOW)).toBeNull();
  });

  it("ignores a frame whose upload never finished", async () => {
    await insertFrame(h.db, { at: "2026-10-13T17:21:00.000Z" });
    h.exec("UPDATE cam_frames SET state = 'pending'");
    expect(await nearestFrame(h.db, "boca-raton", "boca-inlet-surf", NOW)).toBeNull();
  });

  it("nearestFramesAllCams returns one per cam, nearest first, and honors the limit", async () => {
    await insertFrame(h.db, { cam_id: "boca-inlet-surf", at: "2026-10-13T17:40:00.000Z", sha256: "11".repeat(32) });
    await insertFrame(h.db, { cam_id: "boca-inlet-surf", at: "2026-10-13T17:10:00.000Z", sha256: "12".repeat(32) });
    await insertFrame(h.db, { cam_id: "boca-south", at: "2026-10-13T17:44:00.000Z", sha256: "22".repeat(32) });
    await insertFrame(h.db, { cam_id: "boca-south-surf", at: "2026-10-13T17:30:00.000Z", sha256: "33".repeat(32) });
    const all = await nearestFramesAllCams(h.db, "boca-raton", NOW);
    expect(all.map((f) => f.camId)).toEqual(["boca-south", "boca-inlet-surf", "boca-south-surf"]);
    expect(all[1].sha256).toBe("11".repeat(32));
    expect(await nearestFramesAllCams(h.db, "boca-raton", NOW, 1)).toHaveLength(1);
  });

  it("signs a link the image route accepts, and returns no link when signing is not configured", async () => {
    const f = await insertFrame(h.db, { at: "2026-10-13T17:21:00.000Z" });
    const url = await signedFrameUrl(f.r2_key);
    const q = new URL(url!, "http://x").searchParams;
    expect(q.get("k")).toBe(f.r2_key);
    expect(await verify(q.get("k"), q.get("exp"), q.get("sig"))).toBe(true);
    delete process.env.CAM_FRAME_URL_KEY;
    expect(await signedFrameUrl(f.r2_key)).toBeNull();
    expect(await toFrameView({ camId: "c", r2Key: f.r2_key, displayAtUtc: "t", sha256: "s", attribution: null }, true)).toMatchObject({ url: null, exact: true });
  });
});

describe.skipIf(!HAS_SQLITE)("loadReview", () => {
  const seaweedAlert = (key: string, createdAt: string, payload: unknown = seaweedPayload) =>
    insertAlert(h.db, { slug: "boca-raton", signal: "seaweed", kind: "seaweed-held-disagreed", createdAt, payload, dedupeKey: key });

  it("lists open alerts with their exact frame, and the rest as recent", async () => {
    await insertFrame(h.db, { sha256: SHA, at: "2026-10-13T17:21:00.000Z" });
    const open = await seaweedAlert("open", "2026-10-13T17:30:00.000Z");
    const done = await seaweedAlert("done", "2026-10-13T16:30:00.000Z", { ...seaweedPayload, frame: { sha256: null, archivedThisTick: false } });
    await answerAlert(h.db, { alertId: done.id, verdict: "wrong", correct: { level: "none" } }, NOW);
    const r = await loadReview(h.db, NOW);
    expect(r.open.map((a) => a.id)).toEqual([open.id]);
    expect(r.open[0].frames).toHaveLength(1);
    expect(r.open[0].frames[0]).toMatchObject({ camId: "boca-inlet-surf", exact: true });
    expect(r.open[0].frames[0].url).toMatch(/^\/api\/cam-frames\/img\?k=/);
    expect(r.recent.map((a) => a.id)).toEqual([done.id]);
    expect(r.recent[0].answer).toEqual({ verdict: "wrong", correct: { level: "none" } });
    expect(r.recent[0].frames).toEqual([]); // answered alerts show text only
  });

  it("marks an old open alert expired and lists it under recent", async () => {
    const old = await seaweedAlert("old", "2026-10-12T10:00:00.000Z");
    const r = await loadReview(h.db, NOW);
    expect(r.open).toEqual([]);
    expect(r.recent[0]).toMatchObject({ id: old.id, status: "expired" });
  });

  it("shows the exact frame kept with the alert, ahead of any archived one", async () => {
    const key = "quality/boca-raton/boca-inlet-surf/2026-10-13/172015Z-abcdef12.jpg";
    await insertFrame(h.db, { sha256: SHA, at: "2026-10-13T17:21:00.000Z" }); // an archived copy exists too
    await seaweedAlert("kept", "2026-10-13T17:30:00.000Z", { ...seaweedPayload, frame: { sha256: SHA, archivedThisTick: true, r2Key: key } });
    const r = await loadReview(h.db, NOW);
    const f = r.open[0].frames[0];
    expect(f).toMatchObject({ camId: "boca-inlet-surf", exact: true, takenAt: "2026-10-13T17:20:00.000Z" });
    expect(f.url).toContain(encodeURIComponent(key));
    expect(f.credit).toMatch(/video-monitoring|Palm Beach|courtesy/i);
    const q = new URL(f.url!, "http://x").searchParams;
    expect(await verify(q.get("k"), q.get("exp"), q.get("sig"))).toBe(true);
  });

  it("falls back to the archived frame when the kept one has no key", async () => {
    await insertFrame(h.db, { sha256: SHA, at: "2026-10-13T17:21:00.000Z" });
    await seaweedAlert("nokey", "2026-10-13T17:30:00.000Z", { ...seaweedPayload, frame: { sha256: SHA, archivedThisTick: true, r2Key: null } });
    const f = (await loadReview(h.db, NOW)).open[0].frames[0];
    expect(f.exact).toBe(true);
    expect(f.url).toContain("1721Z");
  });

  it("falls back to the nearest saved frame and says it is not the exact one", async () => {
    await insertFrame(h.db, { sha256: "cd".repeat(32), at: "2026-10-13T17:05:00.000Z" });
    await seaweedAlert("a", "2026-10-13T17:30:00.000Z");
    const r = await loadReview(h.db, NOW);
    expect(r.open[0].frames[0]).toMatchObject({ exact: false, takenAt: "2026-10-13T17:05:00.000Z" });
  });

  it("an hourly alert shows the beach's nearest frames per cam", async () => {
    await insertFrame(h.db, { cam_id: "boca-inlet-surf", at: "2026-10-13T17:08:00.000Z", sha256: "11".repeat(32) });
    await insertFrame(h.db, { cam_id: "boca-south", at: "2026-10-13T17:12:00.000Z", sha256: "22".repeat(32) });
    await insertAlert(h.db, { slug: "boca-raton", signal: "clarity", kind: "hourly-jump", createdAt: "2026-10-13T17:10:00.000Z", payload: hourlyPayload, dedupeKey: "h" });
    const r = await loadReview(h.db, NOW);
    expect(r.open[0].frames.map((f) => f.camId).sort()).toEqual(["boca-inlet-surf", "boca-south"]);
    expect(r.open[0].frames.every((f) => !f.exact)).toBe(true);
  });

  it("skips a row whose payload cannot be read, and an alert with no frames still lists", async () => {
    h.exec(
      "INSERT INTO quality_alerts (slug, signal, kind, created_at, payload_json, dedupe_key) VALUES ('boca-raton','seaweed','seaweed-held-disagreed','2026-10-13T17:00:00.000Z','{nope','bad')",
    );
    await seaweedAlert("good", "2026-10-13T17:30:00.000Z");
    const r = await loadReview(h.db, NOW);
    expect(r.open).toHaveLength(1);
    expect(r.open[0].frames).toEqual([]);
  });
});
