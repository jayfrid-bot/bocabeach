// The daily cap runs against a REAL SQLite database with migration 0018
// applied, so the atomic statement itself is what is tested.

import { beforeEach, describe, expect, it } from "vitest";
import { HAS_SQLITE, makeCamDb, type CamDb } from "@/lib/camFrames/testDb";
import type { D1Like } from "@/lib/db/d1Store";
import { CLEF_DAILY_CAP, secondsToUtcMidnight, takeClefDailySlot } from "@/lib/vision/dailyCap";

const NOON = Date.parse("2026-10-12T12:00:00.000Z");
const MODEL = "@cf/cloudflare/clef";

let h: CamDb;
beforeEach(() => {
  if (HAS_SQLITE) h = makeCamDb({ files: ["0018_vision_daily_cap.sql"] })!;
});

const count = (day = "2026-10-12") =>
  (h.all("SELECT count FROM vision_daily_calls WHERE day = ? AND model = ?", day, MODEL)[0]?.count ?? null) as number | null;

describe("takeClefDailySlot", () => {
  it("caps at 600 a day", () => {
    expect(CLEF_DAILY_CAP).toBe(600);
  });

  describe.skipIf(!HAS_SQLITE)("on real SQLite", () => {
    it("counts calls one by one under the UTC day and model", async () => {
      expect(await takeClefDailySlot(h.db, NOON)).toEqual({ allowed: true, count: 1 });
      expect(await takeClefDailySlot(h.db, NOON)).toEqual({ allowed: true, count: 2 });
      expect(count()).toBe(2);
      expect(h.all("SELECT day, model FROM vision_daily_calls")).toEqual([{ day: "2026-10-12", model: MODEL }]);
    });

    it("allows the 600th call and denies the 601st without counting it", async () => {
      h.exec(`INSERT INTO vision_daily_calls (day, model, count) VALUES ('2026-10-12', '${MODEL}', 599)`);
      expect(await takeClefDailySlot(h.db, NOON)).toEqual({ allowed: true, count: 600 });
      expect(await takeClefDailySlot(h.db, NOON)).toEqual({ allowed: false, reason: "daily-cap", retryAfterSec: 12 * 3600 });
      expect(await takeClefDailySlot(h.db, NOON)).toMatchObject({ allowed: false, reason: "daily-cap" });
      expect(count()).toBe(600);
    });

    it("starts a fresh count at 00:00 UTC", async () => {
      h.exec(`INSERT INTO vision_daily_calls (day, model, count) VALUES ('2026-10-12', '${MODEL}', 600)`);
      expect(await takeClefDailySlot(h.db, Date.parse("2026-10-13T00:00:01.000Z"))).toEqual({ allowed: true, count: 1 });
      expect(count("2026-10-12")).toBe(600);
      expect(count("2026-10-13")).toBe(1);
    });

    it("keeps a separate count per model", async () => {
      await takeClefDailySlot(h.db, NOON, 1, "model-a");
      expect(await takeClefDailySlot(h.db, NOON, 1, "model-b")).toEqual({ allowed: true, count: 1 });
      expect(await takeClefDailySlot(h.db, NOON, 1, "model-a")).toMatchObject({ allowed: false, reason: "daily-cap" });
    });

    it("never hands out more than the cap under concurrent claims", async () => {
      // 50 claims race for 10 slots. Each call is one atomic statement, so exactly 10 win.
      const results = await Promise.all(Array.from({ length: 50 }, () => takeClefDailySlot(h.db, NOON, 10)));
      const won = results.filter((r) => r.allowed);
      expect(won).toHaveLength(10);
      expect(results.filter((r) => !r.allowed && r.reason === "daily-cap")).toHaveLength(40);
      expect(won.map((r) => (r.allowed ? r.count : 0)).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(count()).toBe(10);
    });

    it("the statement is a single INSERT ... ON CONFLICT ... WHERE count < ? RETURNING", async () => {
      const seen: string[] = [];
      const spy: D1Like = {
        prepare(sql: string) {
          seen.push(sql);
          return h.db.prepare(sql);
        },
      };
      await takeClefDailySlot(spy, NOON);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatch(/^INSERT INTO vision_daily_calls .*ON CONFLICT \(day, model\) DO UPDATE SET count = .*count \+ 1 WHERE .*count < \? RETURNING count$/);
    });
  });

  describe("fails closed", () => {
    it("with no DB binding (there is no in-memory fallback)", async () => {
      expect(await takeClefDailySlot(null, NOON)).toEqual({ allowed: false, reason: "cap-unavailable" });
    });

    it("when the DB throws", async () => {
      const broken: D1Like = {
        prepare() {
          throw new Error("D1 down");
        },
      };
      expect(await takeClefDailySlot(broken, NOON)).toEqual({ allowed: false, reason: "cap-unavailable" });
    });

    it("when the table is missing (migration not applied)", async () => {
      if (!HAS_SQLITE) return;
      const bare = makeCamDb({ files: [] })!;
      expect(await takeClefDailySlot(bare.db, NOON)).toEqual({ allowed: false, reason: "cap-unavailable" });
    });

    it("when the reply is not a sane count", async () => {
      const odd: D1Like = {
        prepare() {
          const s = { bind: () => s, first: async () => ({ count: "banana" }), run: async () => ({}), all: async () => ({}) };
          return s as never;
        },
      };
      expect(await takeClefDailySlot(odd, NOON)).toEqual({ allowed: false, reason: "cap-unavailable" });
    });
  });

  it("reports the seconds to the next UTC midnight", () => {
    expect(secondsToUtcMidnight(NOON)).toBe(12 * 3600);
  });
});
