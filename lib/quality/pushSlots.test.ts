import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HAS_SQLITE, makeCamDb, type CamDb } from "@/lib/camFrames/testDb";
import { decidePush, DEDUPE_WINDOW_MS, MAX_PUSHES_PER_DAY } from "@/lib/quality/pushPolicy";
import {
  ATTEMPT_UNKNOWN_MS,
  claimQueuedPushes,
  dropClosedAlertSlots,
  dropStaleSlots,
  markPushSent,
  markStaleAttempts,
  purgeOldSlots,
  QUEUED_MAX_AGE_MS,
  releaseAttempt,
  releaseQueuedSlot,
  reservePushSlot,
  SLOT_RETENTION_MS,
} from "@/lib/quality/pushSlots";
import { insertAlert } from "@/lib/quality/store";

let h: CamDb;
beforeEach(() => {
  h = makeCamDb({ allMigrations: true }) as CamDb;
});
afterEach(() => h?.close());

const NOON = Date.parse("2026-10-14T16:00:00.000Z"); // noon EDT
const HOUR = 3_600_000;

let n = 0;
async function newAlert(slug = "boca-raton", signal: "score" | "sand" | "surf" = "score", at = NOON): Promise<number> {
  n += 1;
  return (
    await insertAlert(h.db, { slug, signal, kind: "hourly-jump", createdAt: new Date(at).toISOString(), payload: { observedAt: "x" }, dedupeKey: `k${n}` })
  ).id;
}
const reserve = async (slug: string, signal: "score" | "sand" | "surf", at: number) =>
  reservePushSlot(h.db, { alertId: await newAlert(slug, signal, at), slug, signal }, at);

describe.skipIf(!HAS_SQLITE)("reservePushSlot: the rules, enforced by D1", () => {
  it("hands out slots 1, 2, 3 in the owner day and refuses the 4th", async () => {
    const beaches = ["boca-raton", "deerfield-beach", "fort-lauderdale", "boca-raton"];
    const out = [];
    for (let i = 0; i < beaches.length; i++) out.push(await reserve(beaches[i], i === 3 ? "sand" : "score", NOON + i * 60_000));
    expect(out).toEqual([{ reserved: true }, { reserved: true }, { reserved: true }, { reserved: false, reason: "daily-cap" }]);
    expect(h.all("SELECT slot FROM quality_push_slots ORDER BY slot").map((r) => r.slot)).toEqual([1, 2, 3]);
    expect(MAX_PUSHES_PER_DAY).toBe(3);
  });

  it("refuses the same beach and signal inside 3 hours, but not another signal, another beach, or 3 hours later", async () => {
    expect(await reserve("boca-raton", "score", NOON)).toEqual({ reserved: true });
    expect(await reserve("boca-raton", "score", NOON + 3 * HOUR - 1)).toEqual({ reserved: false, reason: "duplicate" });
    expect(await reserve("boca-raton", "sand", NOON + HOUR)).toEqual({ reserved: true });
    expect(await reserve("deerfield-beach", "score", NOON + HOUR)).toEqual({ reserved: true });
  });

  it("3 hours exactly is outside the window", async () => {
    expect(await reserve("boca-raton", "score", NOON)).toEqual({ reserved: true });
    expect(await reserve("boca-raton", "score", NOON + DEDUPE_WINDOW_MS + 1)).toEqual({ reserved: true });
  });

  it("the daily count restarts at the owner's midnight, and is not UTC's", async () => {
    const lateEvening = Date.parse("2026-10-14T00:00:00.000Z"); // 8 PM EDT on the 13th
    for (const slug of ["boca-raton", "deerfield-beach", "fort-lauderdale"]) {
      expect(await reserve(slug, "score", lateEvening)).toEqual({ reserved: true });
    }
    expect(await reserve("boca-raton", "sand", lateEvening + 60_000)).toMatchObject({ reserved: false, reason: "daily-cap" });
    // 11:59 PM EDT is still the 13th (UTC says the 14th): still full
    expect(await reserve("boca-raton", "surf", Date.parse("2026-10-14T03:59:00.000Z"))).toMatchObject({ reserved: false });
    // 12:01 AM EDT: a new owner day
    expect(await reserve("boca-raton", "surf", Date.parse("2026-10-14T04:01:00.000Z"))).toEqual({ reserved: true });
  });

  it("a released slot gives the day's push and the repeat window back", async () => {
    const a = await newAlert("boca-raton", "score");
    await reservePushSlot(h.db, { alertId: a, slug: "boca-raton", signal: "score" }, NOON);
    expect(await reserve("boca-raton", "score", NOON + 60_000)).toMatchObject({ reserved: false, reason: "duplicate" });
    await releaseQueuedSlot(h.db, a);
    expect(await reserve("boca-raton", "score", NOON + 120_000)).toEqual({ reserved: true });
  });

  it("a failed attempt gives the slot back only to the attempt that holds it", async () => {
    const a = await newAlert("boca-raton", "score");
    await reservePushSlot(h.db, { alertId: a, slug: "boca-raton", signal: "score" }, NOON);
    const [claim] = await claimQueuedPushes(h.db, 5, NOON + 1000);
    expect(await releaseAttempt(h.db, a, "someone-elses-attempt")).toBe(false);
    expect(h.all("SELECT state FROM quality_push_slots")).toEqual([{ state: "attempting" }]);
    expect(await releaseAttempt(h.db, a, claim.attemptId)).toBe(true);
    expect(await reserve("boca-raton", "score", NOON + 120_000)).toEqual({ reserved: true });
  });

  it("an alert the owner already answered takes no slot, even on a retry", async () => {
    const a = await newAlert();
    h.exec(`UPDATE quality_alerts SET status = 'answered' WHERE id = ${a}`);
    expect(await reservePushSlot(h.db, { alertId: a, slug: "boca-raton", signal: "score" }, NOON)).toEqual({ reserved: false, reason: "closed" });
    expect(h.all("SELECT COUNT(*) AS n FROM quality_push_slots")[0].n).toBe(0);
  });

  it("an alert older than the fresh window takes no slot", async () => {
    const a = await newAlert("boca-raton", "score", NOON - 31 * 60_000);
    expect((await reservePushSlot(h.db, { alertId: a, slug: "boca-raton", signal: "score" }, NOON)).reserved).toBe(false);
  });

  it("an alert takes at most one slot", async () => {
    const a = await newAlert();
    expect(await reservePushSlot(h.db, { alertId: a, slug: "boca-raton", signal: "score" }, NOON)).toEqual({ reserved: true });
    const again = await reservePushSlot(h.db, { alertId: a, slug: "boca-raton", signal: "score" }, NOON + 5 * HOUR);
    expect(again.reserved).toBe(false);
    expect(h.all("SELECT COUNT(*) AS n FROM quality_push_slots")[0].n).toBe(1);
  });

  it("many alerts reserving at once never exceed the daily cap", async () => {
    const slugs = ["boca-raton", "deerfield-beach", "fort-lauderdale"];
    const sigs = ["score", "sand", "surf"] as const;
    const jobs = Array.from({ length: 12 }, (_, i) => reserve(slugs[i % 3], sigs[Math.floor(i / 3) % 3], NOON + i));
    const results = await Promise.all(jobs);
    expect(results.filter((r) => r.reserved)).toHaveLength(3);
    expect(h.all("SELECT COUNT(*) AS n FROM quality_push_slots")[0].n).toBe(3);
  });

  it("many alerts for one beach and signal at once make exactly one slot", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => reserve("boca-raton", "score", NOON + i)));
    expect(results.filter((r) => r.reserved)).toHaveLength(1);
  });

  it("agrees with the pure rules in pushPolicy.decidePush, step by step", async () => {
    // A scenario run through both: the D1 reservation and the pure spec must give the same yes/no.
    const steps: Array<[string, "score" | "sand" | "surf", number]> = [
      ["boca-raton", "score", 0],
      ["boca-raton", "score", 30 * 60_000],
      ["boca-raton", "sand", HOUR],
      ["deerfield-beach", "score", 2 * HOUR],
      ["boca-raton", "score", 3 * HOUR + 60_000],
      ["fort-lauderdale", "surf", 4 * HOUR],
      ["boca-raton", "surf", 5 * HOUR],
    ];
    const granted: Array<{ slug: string; signal: string; at: number }> = [];
    for (const [slug, signal, offset] of steps) {
      const at = NOON + offset;
      const last = granted.filter((g) => g.slug === slug && g.signal === signal).map((g) => g.at).sort((a, b) => b - a)[0] ?? null;
      const expected = decidePush({ nowMs: at, slug, pushedToday: granted.length, lastPushedSameKeyMs: last });
      const got = await reserve(slug, signal, at);
      expect(got.reserved, `${slug} ${signal} +${offset / 60_000}m`).toBe(expected.push);
      if (got.reserved) granted.push({ slug, signal, at });
      else expect(got).toMatchObject({ reason: expected.reason });
    }
  });
});

describe.skipIf(!HAS_SQLITE)("the queue: claim, finalize, release", () => {
  it("claims queued pushes for open alerts, oldest first, honoring the limit", async () => {
    const a = await newAlert("boca-raton", "score");
    const b = await newAlert("deerfield-beach", "score");
    await reservePushSlot(h.db, { alertId: b, slug: "deerfield-beach", signal: "score" }, NOON + 5000);
    await reservePushSlot(h.db, { alertId: a, slug: "boca-raton", signal: "score" }, NOON);
    const q = await claimQueuedPushes(h.db, 5, NOON + 10_000);
    expect(q.map((x) => x.alert.id)).toEqual([a, b]);
    expect(q[0].alert).toMatchObject({ slug: "boca-raton", signal: "score", kind: "hourly-jump" });
    expect(new Set(q.map((x) => x.attemptId)).size).toBe(2);
    expect(h.all("SELECT state, attempted_at FROM quality_push_slots ORDER BY alert_id").map((r) => r.state)).toEqual(["attempting", "attempting"]);
    expect(await claimQueuedPushes(h.db, 5, NOON + 20_000)).toEqual([]);
  });

  it("the limit leaves the rest queued", async () => {
    for (const slug of ["boca-raton", "deerfield-beach"]) {
      const id = await newAlert(slug, "score");
      await reservePushSlot(h.db, { alertId: id, slug, signal: "score" }, NOON);
    }
    expect(await claimQueuedPushes(h.db, 1, NOON)).toHaveLength(1);
    expect(h.all("SELECT state FROM quality_push_slots ORDER BY alert_id").map((r) => r.state)).toEqual(["attempting", "queued"]);
  });

  it("two drains cannot claim the same slot: exactly one wins", async () => {
    const a = await newAlert();
    await reservePushSlot(h.db, { alertId: a, slug: "boca-raton", signal: "score" }, NOON);
    const [x, y] = await Promise.all([claimQueuedPushes(h.db, 3, NOON + 1), claimQueuedPushes(h.db, 3, NOON + 2)]);
    expect(x.length + y.length).toBe(1);
  });

  it("an alert answered between the pick and the claim is not claimed", async () => {
    const a = await newAlert();
    await reservePushSlot(h.db, { alertId: a, slug: "boca-raton", signal: "score" }, NOON);
    h.exec(`UPDATE quality_alerts SET status = 'answered' WHERE id = ${a}`);
    expect(await claimQueuedPushes(h.db, 3, NOON)).toEqual([]);
    expect(h.all("SELECT state FROM quality_push_slots")).toEqual([{ state: "queued" }]);
  });

  it("markPushSent finalizes the attempt and flags its alert pushed, together", async () => {
    const a = await newAlert();
    await reservePushSlot(h.db, { alertId: a, slug: "boca-raton", signal: "score" }, NOON);
    const [claim] = await claimQueuedPushes(h.db, 5, NOON);
    await markPushSent(h.db, a, claim.attemptId, NOON + 1000);
    expect(h.all("SELECT state, sent_at FROM quality_push_slots")[0]).toEqual({ state: "sent", sent_at: new Date(NOON + 1000).toISOString() });
    expect(h.all("SELECT pushed FROM quality_alerts WHERE id = ?", a)[0].pushed).toBe(1);
  });

  it("a stale or foreign attempt id finalizes nothing and flags nothing", async () => {
    const a = await newAlert();
    await reservePushSlot(h.db, { alertId: a, slug: "boca-raton", signal: "score" }, NOON);
    await claimQueuedPushes(h.db, 5, NOON);
    await markPushSent(h.db, a, "not-the-attempt", NOON + 1000);
    expect(h.all("SELECT state FROM quality_push_slots")).toEqual([{ state: "attempting" }]);
    expect(h.all("SELECT pushed FROM quality_alerts WHERE id = ?", a)[0].pushed).toBe(0);
  });

  it("a sent slot still counts toward the day and the repeat window", async () => {
    const a = await newAlert();
    await reservePushSlot(h.db, { alertId: a, slug: "boca-raton", signal: "score" }, NOON);
    const [claim] = await claimQueuedPushes(h.db, 5, NOON);
    await markPushSent(h.db, a, claim.attemptId, NOON);
    expect(await reserve("boca-raton", "score", NOON + HOUR)).toMatchObject({ reserved: false, reason: "duplicate" });
  });

  it("an attempt older than ten minutes becomes unknown, is never claimed again, and still counts", async () => {
    const a = await newAlert();
    await reservePushSlot(h.db, { alertId: a, slug: "boca-raton", signal: "score" }, NOON);
    await claimQueuedPushes(h.db, 5, NOON);
    expect(await markStaleAttempts(h.db, NOON + ATTEMPT_UNKNOWN_MS - 1)).toBe(0);
    expect(await markStaleAttempts(h.db, NOON + ATTEMPT_UNKNOWN_MS + 1)).toBe(1);
    expect(h.all("SELECT state FROM quality_push_slots")).toEqual([{ state: "unknown" }]);
    expect(await claimQueuedPushes(h.db, 5, NOON + 2 * ATTEMPT_UNKNOWN_MS)).toEqual([]);
    expect(await reserve("boca-raton", "score", NOON + HOUR)).toMatchObject({ reserved: false, reason: "duplicate" });
  });

  it("dropStaleSlots deletes only queued slots reserved before the cutoff", async () => {
    const old = await newAlert("boca-raton", "score", NOON - 2 * QUEUED_MAX_AGE_MS);
    const sent = await newAlert("deerfield-beach", "score", NOON - 2 * QUEUED_MAX_AGE_MS + 1);
    const fresh = await newAlert("fort-lauderdale", "score");
    await reservePushSlot(h.db, { alertId: old, slug: "boca-raton", signal: "score" }, NOON - 2 * QUEUED_MAX_AGE_MS);
    await reservePushSlot(h.db, { alertId: sent, slug: "deerfield-beach", signal: "score" }, NOON - 2 * QUEUED_MAX_AGE_MS + 1);
    h.exec(`UPDATE quality_push_slots SET state = 'sent' WHERE alert_id = ${sent}`);
    await reservePushSlot(h.db, { alertId: fresh, slug: "fort-lauderdale", signal: "score" }, NOON);
    expect(await dropStaleSlots(h.db, NOON - QUEUED_MAX_AGE_MS)).toBe(1);
    expect(h.all("SELECT alert_id FROM quality_push_slots ORDER BY alert_id").map((r) => r.alert_id)).toEqual([sent, fresh]);
  });

  it("dropClosedAlertSlots deletes queued slots of answered alerts only", async () => {
    const answered = await newAlert("boca-raton", "score");
    const open = await newAlert("deerfield-beach", "score");
    await reservePushSlot(h.db, { alertId: answered, slug: "boca-raton", signal: "score" }, NOON);
    await reservePushSlot(h.db, { alertId: open, slug: "deerfield-beach", signal: "score" }, NOON);
    h.exec(`UPDATE quality_alerts SET status = 'answered' WHERE id = ${answered}`);
    expect(await dropClosedAlertSlots(h.db)).toBe(1);
    expect(h.all("SELECT alert_id FROM quality_push_slots").map((r) => r.alert_id)).toEqual([open]);
  });
});

describe.skipIf(!HAS_SQLITE)("purgeOldSlots", () => {
  it("deletes sent and unknown rows older than 30 days, and keeps the rest", async () => {
    const mk = async (slug: string, state: string, reservedAt: number) => {
      const id = await newAlert(slug, "score", reservedAt);
      await reservePushSlot(h.db, { alertId: id, slug, signal: "score" }, reservedAt);
      h.exec(`UPDATE quality_push_slots SET state = '${state}' WHERE alert_id = ${id}`);
      return id;
    };
    const old = NOON - SLOT_RETENTION_MS - HOUR;
    const oldSent = await mk("boca-raton", "sent", old);
    const oldUnknown = await mk("deerfield-beach", "unknown", old + 1);
    const oldQueued = await mk("fort-lauderdale", "queued", old + 2);
    const recentSent = await mk("boca-raton", "sent", NOON - 10 * 86_400_000);
    expect(await purgeOldSlots(h.db, NOON)).toBe(2);
    const left = h.all("SELECT alert_id FROM quality_push_slots ORDER BY alert_id").map((r) => r.alert_id);
    expect(left).toEqual([oldQueued, recentSent]);
    expect(left).not.toContain(oldSent);
    expect(left).not.toContain(oldUnknown);
  });
});
