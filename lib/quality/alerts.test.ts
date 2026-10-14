import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HAS_SQLITE, makeCamDb, type CamDb } from "@/lib/camFrames/testDb";
import { recordAlert } from "@/lib/quality/alerts";
import type { NewAlert } from "@/lib/quality/store";
import type { HourlyAlertPayload } from "@/lib/quality/types";

let h: CamDb;
beforeEach(() => {
  h = makeCamDb({ allMigrations: true }) as CamDb;
});
afterEach(() => h?.close());

const NOON = Date.parse("2026-10-14T16:00:00.000Z"); // noon EDT

const payload: HourlyAlertPayload = {
  observedAt: "2026-10-14T16:00:00.000Z",
  fromHourUtc: "2026-10-14T15:00:00.000Z",
  from: 78,
  to: 58,
  delta: -20,
  cause: null,
  published: { value: 58 },
};
const alert = (over: Partial<NewAlert> = {}): NewAlert => ({
  slug: "boca-raton",
  signal: "score",
  kind: "hourly-jump",
  createdAt: new Date(NOON).toISOString(),
  payload,
  dedupeKey: "k",
  ...over,
});
const slots = () => h.all("SELECT alert_id, slug, signal, state FROM quality_push_slots ORDER BY alert_id");

describe.skipIf(!HAS_SQLITE)("recordAlert: store always, queue when the rules allow, send never", () => {
  it("stores the alert and queues one push slot; nothing is sent from here", async () => {
    const r = await recordAlert(h.db, alert(), NOON);
    expect(r).toMatchObject({ created: true, queued: true, reason: "queued" });
    expect(slots()).toEqual([{ alert_id: r.id, slug: "boca-raton", signal: "score", state: "queued" }]);
    expect(h.all("SELECT pushed FROM quality_alerts")[0].pushed).toBe(0); // pushed becomes 1 only when the drain sends it
  });

  it("a retry of the same alert writes and queues nothing", async () => {
    await recordAlert(h.db, alert(), NOON);
    const again = await recordAlert(h.db, alert(), NOON + 1000);
    expect(again).toMatchObject({ created: false, queued: false, reason: "exists" });
    expect(h.all("SELECT COUNT(*) AS n FROM quality_alerts")[0].n).toBe(1);
    expect(slots()).toHaveLength(1);
  });

  it("an unwatched beach is stored but takes no slot", async () => {
    const r = await recordAlert(h.db, alert({ slug: "miami-beach" }), NOON);
    expect(r).toMatchObject({ created: true, queued: false, reason: "unwatched" });
    expect(slots()).toEqual([]);
    expect(h.all("SELECT COUNT(*) AS n FROM quality_alerts")[0].n).toBe(1);
  });

  it("between 9 PM and 7 AM an alert is stored and waits in the list, without a slot", async () => {
    const r = await recordAlert(h.db, alert(), Date.parse("2026-10-14T03:00:00.000Z"));
    expect(r).toMatchObject({ created: true, queued: false, reason: "quiet-hours" });
    expect(slots()).toEqual([]);
  });

  it("the same beach and signal does not queue again inside 3 hours, but another signal does", async () => {
    const at = (ms: number) => ({ createdAt: new Date(ms).toISOString() });
    await recordAlert(h.db, alert({ dedupeKey: "a" }), NOON);
    expect(await recordAlert(h.db, alert({ dedupeKey: "b", ...at(NOON + 2 * 3_600_000) }), NOON + 2 * 3_600_000)).toMatchObject({ queued: false, reason: "duplicate" });
    expect(await recordAlert(h.db, alert({ dedupeKey: "c", signal: "sand", ...at(NOON + 2 * 3_600_000) }), NOON + 2 * 3_600_000)).toMatchObject({ queued: true });
    expect(await recordAlert(h.db, alert({ dedupeKey: "d", ...at(NOON + 3 * 3_600_000 + 1) }), NOON + 3 * 3_600_000 + 1)).toMatchObject({ queued: true });
  });

  it("at most 3 a day across all beaches; the 4th is stored with the reason", async () => {
    const beaches = ["boca-raton", "deerfield-beach", "fort-lauderdale", "boca-raton"];
    const out = [];
    for (let i = 0; i < beaches.length; i++) {
      out.push(
        await recordAlert(
          h.db,
          alert({ slug: beaches[i], signal: i === 3 ? "sand" : "score", dedupeKey: `k${i}`, createdAt: new Date(NOON + i * 60_000).toISOString() }),
          NOON + i * 60_000,
        ),
      );
    }
    expect(out.map((r) => r.reason)).toEqual(["queued", "queued", "queued", "daily-cap"]);
    expect(h.all("SELECT COUNT(*) AS n FROM quality_alerts")[0].n).toBe(4);
  });

  it("the hourly rate limit refuses an alert and writes nothing", async () => {
    for (let i = 0; i < 3; i++) await recordAlert(h.db, alert({ dedupeKey: `r${i}` }), NOON, { maxPerSlugPerHour: 3 });
    const r = await recordAlert(h.db, alert({ dedupeKey: "r3" }), NOON, { maxPerSlugPerHour: 3 });
    expect(r).toEqual({ id: 0, created: false, queued: false, reason: "rate-limited" });
    expect(h.all("SELECT COUNT(*) AS n FROM quality_alerts")[0].n).toBe(3);
  });

  it("alerts arriving at once never queue more than 3 pushes for a day (Codex: the daily cap used to race)", async () => {
    const slugs = ["boca-raton", "deerfield-beach", "fort-lauderdale"];
    const sigs = ["score", "sand", "surf", "clarity"] as const;
    const jobs = Array.from({ length: 12 }, (_, i) => recordAlert(h.db, alert({ slug: slugs[i % 3], signal: sigs[i % 4], dedupeKey: `x${i}` }), NOON + i));
    const results = await Promise.all(jobs);
    expect(results.filter((r) => r.queued)).toHaveLength(3);
    expect(slots()).toHaveLength(3);
  });

  it("alerts at once for one beach and signal never queue two (Codex: the 3-hour window used to race)", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => recordAlert(h.db, alert({ dedupeKey: `y${i}` }), NOON + i)));
    expect(results.filter((r) => r.queued)).toHaveLength(1);
  });

  it("the alert and its slot are written in ONE batch: a failing slot statement leaves no alert behind", async () => {
    // Break the slot table, then try: the whole batch rolls back, so no alert exists without its slot decision.
    h.exec("DROP TABLE quality_push_slots");
    await expect(recordAlert(h.db, alert(), NOON)).rejects.toBeTruthy();
    expect(h.all("SELECT COUNT(*) AS n FROM quality_alerts")[0].n).toBe(0);
  });

  it("a retry that finds the alert WITHOUT a slot reserves the missing one while it is still eligible", async () => {
    // The alert exists (an older build wrote it), and no slot was ever taken.
    await recordAlert(h.db, alert({ dedupeKey: "lost" }), NOON, { maxPerSlugPerHour: 50 });
    h.exec("DELETE FROM quality_push_slots");
    const again = await recordAlert(h.db, alert({ dedupeKey: "lost" }), NOON + 60_000);
    expect(again).toMatchObject({ created: false, queued: true, reason: "queued" });
    expect(slots()).toHaveLength(1);
  });

  it("a retry does NOT reserve a slot once the alert is stale or answered", async () => {
    await recordAlert(h.db, alert({ dedupeKey: "lost" }), NOON);
    h.exec("DELETE FROM quality_push_slots");
    expect(await recordAlert(h.db, alert({ dedupeKey: "lost" }), NOON + 31 * 60_000)).toMatchObject({ created: false, queued: false, reason: "exists" });
    h.exec("UPDATE quality_alerts SET status = 'answered'");
    expect(await recordAlert(h.db, alert({ dedupeKey: "lost" }), NOON + 60_000)).toMatchObject({ queued: false, reason: "exists" });
    expect(slots()).toEqual([]);
  });

  it("a retry of an alert that already has its slot adds nothing", async () => {
    await recordAlert(h.db, alert(), NOON);
    const again = await recordAlert(h.db, alert(), NOON + 1000);
    expect(again).toMatchObject({ created: false, queued: false, reason: "exists" });
    expect(slots()).toHaveLength(1);
  });
});
