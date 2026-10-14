import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HAS_SQLITE, makeCamDb, type CamDb } from "@/lib/camFrames/testDb";
import { recordAlert } from "@/lib/quality/alerts";
import { fakeSender } from "@/lib/quality/testHelpers";
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
const pushed = () => h.all("SELECT dedupe_key, pushed FROM quality_alerts ORDER BY id").map((r) => `${r.dedupe_key}:${r.pushed}`);

describe.skipIf(!HAS_SQLITE)("recordAlert", () => {
  it("stores the alert, pushes it with a plain message and a link to the review screen", async () => {
    const send = fakeSender();
    const r = await recordAlert(h.db, alert(), NOON, send);
    expect(r).toMatchObject({ created: true, pushed: true, reason: "ok" });
    expect(send.sent).toEqual([
      {
        title: "Boca Raton",
        body: "Check: Beach Day score went from 78 to 58 in an hour, and nothing obvious explains it.",
        url: `https://app.isitbeachday.com/admin/review?alert=${r.id}`,
        tag: `quality-${r.id}`,
      },
    ]);
    expect(pushed()).toEqual(["k:1"]);
  });

  it("a retry of the same alert writes and sends nothing", async () => {
    const send = fakeSender();
    await recordAlert(h.db, alert(), NOON, send);
    const again = await recordAlert(h.db, alert(), NOON + 1000, send);
    expect(again).toMatchObject({ created: false, pushed: false, reason: "exists" });
    expect(send.sent).toHaveLength(1);
    expect(h.all("SELECT COUNT(*) AS n FROM quality_alerts")[0].n).toBe(1);
  });

  it("an unwatched beach is stored but never pushed", async () => {
    const send = fakeSender();
    const r = await recordAlert(h.db, alert({ slug: "miami-beach" }), NOON, send);
    expect(r).toMatchObject({ created: true, pushed: false, reason: "unwatched" });
    expect(send.sent).toEqual([]);
    expect(pushed()).toEqual(["k:0"]);
  });

  it("between 9 PM and 7 AM an alert is stored and waits in the list", async () => {
    const send = fakeSender();
    const r = await recordAlert(h.db, alert(), Date.parse("2026-10-14T03:00:00.000Z"), send);
    expect(r).toMatchObject({ created: true, pushed: false, reason: "quiet-hours" });
    expect(send.sent).toEqual([]);
  });

  it("the same beach and signal does not push again inside 3 hours, but another signal does", async () => {
    const send = fakeSender();
    await recordAlert(h.db, alert({ dedupeKey: "a" }), NOON, send);
    const second = await recordAlert(h.db, alert({ dedupeKey: "b" }), NOON + 2 * 3_600_000, send);
    expect(second).toMatchObject({ pushed: false, reason: "duplicate" });
    const otherSignal = await recordAlert(h.db, alert({ dedupeKey: "c", signal: "sand" }), NOON + 2 * 3_600_000, send);
    expect(otherSignal.pushed).toBe(true);
    const later = await recordAlert(h.db, alert({ dedupeKey: "d" }), NOON + 3 * 3_600_000, send);
    expect(later.pushed).toBe(true);
    expect(pushed()).toEqual(["a:1", "b:0", "c:1", "d:1"]);
  });

  it("at most 3 pushes a day across all beaches; the 4th is stored", async () => {
    const send = fakeSender();
    const beaches = ["boca-raton", "deerfield-beach", "fort-lauderdale", "boca-raton"];
    const results = [];
    for (let i = 0; i < beaches.length; i++) {
      results.push(await recordAlert(h.db, alert({ slug: beaches[i], signal: i === 3 ? "sand" : "score", dedupeKey: `k${i}` }), NOON + i * 60_000, send));
    }
    expect(results.map((r) => r.reason)).toEqual(["ok", "ok", "ok", "daily-cap"]);
    expect(send.sent).toHaveLength(3);
  });

  it("the daily count starts at the owner's midnight", async () => {
    const send = fakeSender();
    // Three pushes late yesterday evening (before 9 PM), then one at noon today.
    const yesterday = Date.parse("2026-10-14T00:00:00.000Z"); // 8 PM EDT on the 13th
    for (let i = 0; i < 3; i++) {
      await recordAlert(
        h.db,
        alert({ slug: ["boca-raton", "deerfield-beach", "fort-lauderdale"][i], dedupeKey: `y${i}`, createdAt: new Date(yesterday).toISOString() }),
        yesterday,
        send,
      );
    }
    const today = await recordAlert(h.db, alert({ dedupeKey: "t" }), NOON, send);
    expect(today.pushed).toBe(true);
  });

  it("a push that fails does not use up the day, and leaves the alert unpushed", async () => {
    const send = fakeSender({ ok: false, sent: 0, failed: 1 });
    const r = await recordAlert(h.db, alert(), NOON, send);
    expect(r).toMatchObject({ created: true, pushed: false, reason: "send-failed" });
    expect(pushed()).toEqual(["k:0"]);
    const ok = fakeSender();
    const next = await recordAlert(h.db, alert({ dedupeKey: "k2" }), NOON + 60_000, ok);
    expect(next.pushed).toBe(true);
  });
});
