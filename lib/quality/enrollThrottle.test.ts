import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HAS_SQLITE, makeCamDb, type CamDb } from "@/lib/camFrames/testDb";
import { consumeEnrollAttempt, ENROLL_ALL, ENROLL_PER_IP, purgeEnrollAttempts } from "@/lib/quality/enrollThrottle";

let h: CamDb;
beforeEach(() => {
  h = makeCamDb({ allMigrations: true }) as CamDb;
});
afterEach(() => h?.close());

const T = Date.parse("2026-10-14T16:20:00.000Z");
const HOUR = 3_600_000;

describe.skipIf(!HAS_SQLITE)("the enrollment throttle", () => {
  it("allows exactly `max` attempts in an hour and then refuses, with the time left", async () => {
    const out = [];
    for (let i = 0; i < 7; i++) out.push(await consumeEnrollAttempt(h.db, "ip:1.2.3.4", T, ENROLL_PER_IP));
    expect(out.map((o) => o.allowed)).toEqual([true, true, true, true, true, false, false]);
    expect(out[5].retryAfterSec).toBe(40 * 60);
    // a refused attempt is not counted past the limit
    expect(h.all("SELECT n FROM owner_enroll_attempts")[0].n).toBe(ENROLL_PER_IP);
  });

  it("counts each bucket on its own, and starts again in the next hour", async () => {
    for (let i = 0; i < ENROLL_PER_IP; i++) await consumeEnrollAttempt(h.db, "ip:a", T, ENROLL_PER_IP);
    expect((await consumeEnrollAttempt(h.db, "ip:a", T, ENROLL_PER_IP)).allowed).toBe(false);
    expect((await consumeEnrollAttempt(h.db, "ip:b", T, ENROLL_PER_IP)).allowed).toBe(true);
    expect((await consumeEnrollAttempt(h.db, "ip:a", T + HOUR, ENROLL_PER_IP)).allowed).toBe(true);
  });

  it("is atomic: attempts that arrive at once never pass the limit", async () => {
    const results = await Promise.all(Array.from({ length: 30 }, () => consumeEnrollAttempt(h.db, "all", T, ENROLL_ALL)));
    expect(results.filter((r) => r.allowed)).toHaveLength(ENROLL_ALL);
    expect(h.all("SELECT n FROM owner_enroll_attempts")[0].n).toBe(ENROLL_ALL);
  });

  it("purges counters older than two days", async () => {
    await consumeEnrollAttempt(h.db, "ip:old", T - 3 * 24 * HOUR, 5);
    await consumeEnrollAttempt(h.db, "ip:new", T - 24 * HOUR, 5);
    expect(await purgeEnrollAttempts(h.db, T)).toBe(1);
    expect(h.all("SELECT bucket FROM owner_enroll_attempts").map((r) => r.bucket)).toEqual(["ip:new"]);
  });
});
