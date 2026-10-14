import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HAS_SQLITE, makeCamDb, type CamDb } from "@/lib/camFrames/testDb";
import { recordAlert } from "@/lib/quality/alerts";
import { drainOwnerPushes, MAX_DRAIN_PER_TICK } from "@/lib/quality/drain";
import { ATTEMPT_UNKNOWN_MS, claimQueuedPushes, QUEUED_MAX_AGE_MS, reservePushSlot } from "@/lib/quality/pushSlots";
import { insertAlert } from "@/lib/quality/store";
import { fakeSender } from "@/lib/quality/testHelpers";
import type { HourlyAlertPayload, SeaweedAlertPayload } from "@/lib/quality/types";

let h: CamDb;
beforeEach(() => {
  h = makeCamDb({ allMigrations: true }) as CamDb;
});
afterEach(() => h?.close());

const NOON = Date.parse("2026-10-14T16:00:00.000Z");
const payload: HourlyAlertPayload = {
  observedAt: "2026-10-14T16:00:00.000Z", fromHourUtc: "2026-10-14T15:00:00.000Z", from: 78, to: 58, delta: -20, cause: null, published: { value: 58 },
};
const seaweed: SeaweedAlertPayload = {
  camId: "boca-inlet-surf", camName: "Boca Inlet Cam", observedAt: "2026-10-14T15:55:00.000Z", published: { level: "none", pct: 0 },
  claim: { level: "moderate", coveragePct: 35, note: null, provider: "gemini", model: null },
  secondOpinion: { provider: "clef", model: null, level: "none", coveragePct: 0, note: null },
  others: [{ id: "b", name: "Boca South", level: "none", coveragePct: 0, carried: false }],
  claimTarget: { frameSha: "a".repeat(20), frameAt: null, claimedAt: "2026-10-14T15:56:00Z" }, localDate: "2026-10-14",
  frame: { sha256: null, archivedThisTick: false },
};

async function queue(slug: string, signal: "score" | "sand" | "surf", at = NOON, kind: "hourly-jump" | "seaweed-held-disagreed" = "hourly-jump") {
  return recordAlert(
    h.db,
    { slug, signal: kind === "seaweed-held-disagreed" ? "seaweed" : signal, kind, createdAt: new Date(at).toISOString(), payload: kind === "hourly-jump" ? payload : seaweed, dedupeKey: `${slug}-${signal}-${kind}-${at}` },
    at,
  );
}
const state = () => h.all("SELECT alert_id, state FROM quality_push_slots ORDER BY alert_id");

describe.skipIf(!HAS_SQLITE)("drainOwnerPushes", () => {
  it("sends each queued push with plain text and a link to its alert, then marks it sent and its alert pushed", async () => {
    const a = await queue("boca-raton", "score");
    const send = fakeSender();
    const r = await drainOwnerPushes(h.db, NOON + 30_000, send);
    expect(r).toEqual({ sent: 1, released: 0, stale: 0, unknown: 0, ambiguous: 0 });
    expect(send.sent).toEqual([
      {
        title: "Boca Raton",
        body: "Check: Beach Day score went from 78 to 58 in an hour, and nothing obvious explains it.",
        url: `https://app.isitbeachday.com/admin/review?alert=${a.id}`,
        tag: `quality-${a.id}`,
      },
    ]);
    expect(state()).toEqual([{ alert_id: a.id, state: "sent" }]);
    expect(h.all("SELECT pushed FROM quality_alerts")[0].pushed).toBe(1);
  });

  it("a seaweed alert reads like the plan's example", async () => {
    await queue("boca-raton", "score", NOON, "seaweed-held-disagreed");
    const send = fakeSender();
    await drainOwnerPushes(h.db, NOON + 30_000, send);
    expect(send.sent[0].body).toBe("Check: Boca Inlet cam says moderate seaweed (35%). Other cams: none.");
  });

  it("a send that fails gives its slot back, so the day's push and the repeat window are free again", async () => {
    await queue("boca-raton", "score");
    const r = await drainOwnerPushes(h.db, NOON + 30_000, fakeSender({ ok: false, sent: 0, failed: 1 }));
    expect(r).toEqual({ sent: 0, released: 1, stale: 0, unknown: 0, ambiguous: 0 });
    expect(state()).toEqual([]);
    expect(h.all("SELECT pushed FROM quality_alerts")[0].pushed).toBe(0);
    // the same beach and signal can queue again at once
    expect(await queue("boca-raton", "score", NOON + 60_000)).toMatchObject({ queued: true });
  });

  it("sends all three of a full day's pushes in one tick, then nothing more", async () => {
    for (const [slug, sig] of [["boca-raton", "score"], ["deerfield-beach", "score"], ["fort-lauderdale", "score"]] as const) await queue(slug, sig);
    const send = fakeSender();
    expect(MAX_DRAIN_PER_TICK).toBe(3); // the per-tick ceiling equals the daily cap, so one tick can never send more than a day allows
    expect((await drainOwnerPushes(h.db, NOON + 30_000, send)).sent).toBe(3);
    expect((await drainOwnerPushes(h.db, NOON + 90_000, send)).sent).toBe(0);
  });

  it("drops a queued push that went stale, unsent, and gives the slot back", async () => {
    const a = (await insertAlert(h.db, { slug: "boca-raton", signal: "score", kind: "hourly-jump", createdAt: new Date(NOON).toISOString(), payload, dedupeKey: "old" })).id;
    await reservePushSlot(h.db, { alertId: a, slug: "boca-raton", signal: "score" }, NOON);
    const send = fakeSender();
    const r = await drainOwnerPushes(h.db, NOON + QUEUED_MAX_AGE_MS + 1000, send);
    expect(r).toMatchObject({ sent: 0, stale: 1, unknown: 0, ambiguous: 0 });
    expect(send.sent).toEqual([]);
    expect(state()).toEqual([]);
  });

  it("does not send in quiet hours: the slot is released and the alert stays in the list", async () => {
    await queue("boca-raton", "score", Date.parse("2026-10-14T00:58:00.000Z")); // 8:58 PM EDT: queued
    const send = fakeSender();
    const r = await drainOwnerPushes(h.db, Date.parse("2026-10-14T01:01:00.000Z"), send); // 9:01 PM
    expect(r).toEqual({ sent: 0, released: 1, stale: 0, unknown: 0, ambiguous: 0 });
    expect(send.sent).toEqual([]);
    expect(h.all("SELECT COUNT(*) AS n FROM quality_alerts")[0].n).toBe(1);
  });

  it("an alert whose payload cannot be read releases its slot instead of failing the drain", async () => {
    const a = (await insertAlert(h.db, { slug: "boca-raton", signal: "score", kind: "hourly-jump", createdAt: new Date(NOON).toISOString(), payload, dedupeKey: "bad" })).id;
    h.exec(`UPDATE quality_alerts SET payload_json = '{nope' WHERE id = ${a}`);
    await reservePushSlot(h.db, { alertId: a, slug: "boca-raton", signal: "score" }, NOON);
    expect(await drainOwnerPushes(h.db, NOON + 30_000, fakeSender())).toEqual({ sent: 0, released: 1, stale: 0, unknown: 0, ambiguous: 0 });
  });

  it("two drains at once send a push once", async () => {
    await queue("boca-raton", "score");
    const send = fakeSender();
    const [x, y] = await Promise.all([drainOwnerPushes(h.db, NOON + 30_000, send), drainOwnerPushes(h.db, NOON + 30_001, send)]);
    expect(x.sent + y.sent).toBe(1);
    expect(send.sent).toHaveLength(1);
    expect(state().map((r) => r.state)).toEqual(["sent"]);
  });

  it("the claim comes BEFORE the send: a drain that finds the slot taken sends nothing", async () => {
    const a = await queue("boca-raton", "score");
    // another drain claimed it and has not finished
    await claimQueuedPushes(h.db, 3, NOON + 10_000);
    const send = fakeSender();
    expect(await drainOwnerPushes(h.db, NOON + 20_000, send)).toEqual({ sent: 0, released: 0, stale: 0, unknown: 0, ambiguous: 0 });
    expect(send.sent).toEqual([]);
    expect(state()).toEqual([{ alert_id: a.id, state: "attempting" }]);
  });

  it("an attempt that never finished becomes unknown after 10 minutes and is NOT sent again", async () => {
    const a = await queue("boca-raton", "score");
    await claimQueuedPushes(h.db, 3, NOON + 1000); // the process died after APNs may have said yes
    const send = fakeSender();
    const r = await drainOwnerPushes(h.db, NOON + 1000 + ATTEMPT_UNKNOWN_MS + 1000, send);
    expect(r).toEqual({ sent: 0, released: 0, stale: 0, unknown: 1, ambiguous: 0 });
    expect(send.sent).toEqual([]);
    expect(state()).toEqual([{ alert_id: a.id, state: "unknown" }]);
    expect(h.all("SELECT pushed FROM quality_alerts")[0].pushed).toBe(0);
  });

  it("an answered alert is never pushed, and its queued slot is given back", async () => {
    const a = await queue("boca-raton", "score");
    h.exec(`UPDATE quality_alerts SET status = 'answered' WHERE id = ${a.id}`);
    const send = fakeSender();
    expect(await drainOwnerPushes(h.db, NOON + 30_000, send)).toEqual({ sent: 0, released: 0, stale: 1, unknown: 0, ambiguous: 0 });
    expect(send.sent).toEqual([]);
    expect(state()).toEqual([]);
  });

  it("a send that fails after a lost race frees nothing that another drain sent", async () => {
    // Drain 1 claimed and is slow. Drain 2 cannot claim. Only the holder's attempt id can release.
    await queue("boca-raton", "score");
    const [mine] = await claimQueuedPushes(h.db, 3, NOON + 1000);
    const { releaseAttempt } = await import("@/lib/quality/pushSlots");
    expect(await releaseAttempt(h.db, mine.alert.id, "another-drains-id")).toBe(false);
    expect(state().map((r) => r.state)).toEqual(["attempting"]);
  });

  it("a send with no answer from Apple keeps the slot: it becomes unknown and a duplicate POST cannot push again", async () => {
    const a = await queue("boca-raton", "score");
    const send = fakeSender({ ok: false, sent: 0, failed: 1, ambiguous: 1 });
    const r = await drainOwnerPushes(h.db, NOON + 30_000, send);
    expect(r).toEqual({ sent: 0, released: 0, stale: 0, unknown: 0, ambiguous: 1 });
    expect(state()).toEqual([{ alert_id: a.id, state: "attempting" }]); // NOT released
    // the producer POSTs the same alert again: its slot is still taken, so nothing is queued
    expect(await queue("boca-raton", "score")).toMatchObject({ queued: false });
    expect(state()).toHaveLength(1);
    // and the drain never sends it again, before or after it turns unknown
    const again = fakeSender();
    await drainOwnerPushes(h.db, NOON + 60_000, again);
    const later = await drainOwnerPushes(h.db, NOON + 30_000 + ATTEMPT_UNKNOWN_MS + 1000, again);
    expect(later.unknown).toBe(1);
    expect(again.sent).toEqual([]);
    expect(state()).toEqual([{ alert_id: a.id, state: "unknown" }]);
    expect(h.all("SELECT pushed FROM quality_alerts")[0].pushed).toBe(0);
  });

  it("a partial success (one phone took it, one timed out) counts as sent", async () => {
    const a = await queue("boca-raton", "score");
    const r = await drainOwnerPushes(h.db, NOON + 30_000, fakeSender({ ok: true, sent: 1, failed: 1, ambiguous: 1 }));
    expect(r).toMatchObject({ sent: 1, ambiguous: 0, released: 0 });
    expect(state()).toEqual([{ alert_id: a.id, state: "sent" }]);
  });

  it("does nothing when nothing is queued", async () => {
    const send = fakeSender();
    expect(await drainOwnerPushes(h.db, NOON, send)).toEqual({ sent: 0, released: 0, stale: 0, unknown: 0, ambiguous: 0 });
    expect(send.sent).toEqual([]);
  });
});
