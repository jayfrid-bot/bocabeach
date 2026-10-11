// POST /api/cam-frames/purge — the daily cleanup. Real SQLite, frozen clock.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HAS_SQLITE, makeCamDb, type CamDb } from "@/lib/camFrames/testDb";
import { CLAIM_A, frameRow } from "@/lib/camFrames/testFixtures";
import { claimSlot, markReady } from "@/lib/camFrames/store";

const ctl = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db/d1Store", () => ({ getD1: async () => ctl.db }));

import { POST } from "@/app/api/cam-frames/purge/route";

const SECRET = "test-cron-secret";
const NOW = Date.parse("2026-10-11T08:17:00.000Z");
const DAY = 86_400_000;

let h: CamDb;

function post(headers: Record<string, string> = { "x-cron-secret": SECRET }): Promise<Response> {
  return POST(new Request("http://localhost/api/cam-frames/purge", { method: "POST", headers }));
}

async function add(cam: string, receivedAtMs: number, ready: boolean): Promise<void> {
  const row = frameRow({
    cam_id: cam,
    r2_key: `boca-raton/${cam}/2026-10-11/1420Z-01234567-cccccccc.jpg`,
    received_at_utc: new Date(receivedAtMs).toISOString(),
  });
  await claimSlot(h.db, row);
  if (ready) await markReady(h.db, row.slug, row.cam_id, row.slot_utc, CLAIM_A);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  process.env.CRON_SECRET = SECRET;
  h = makeCamDb() as CamDb;
  ctl.db = h?.db ?? null;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.CRON_SECRET;
  h?.close();
});

describe("auth", () => {
  it("503s when CRON_SECRET is not set", async () => {
    delete process.env.CRON_SECRET;
    expect((await post()).status).toBe(503);
  });

  it("401s on a missing or wrong x-cron-secret", async () => {
    expect((await post({})).status).toBe(401);
    expect((await post({ "x-cron-secret": "nope" })).status).toBe(401);
    expect((await post({ authorization: `Bearer ${SECRET}` })).status).toBe(401);
  });
});

describe.skipIf(!HAS_SQLITE)("purge", () => {
  it("503s when there is no database", async () => {
    ctl.db = null;
    expect((await post()).status).toBe(503);
  });

  it("deletes rows past 365 days and pending rows past 1 h, and returns counts", async () => {
    await add("old-1", NOW - 400 * DAY, true);
    await add("old-2", NOW - 366 * DAY, true);
    await add("keep", NOW - 100 * DAY, true);
    await add("stale-pending", NOW - 2 * 3_600_000, false);
    await add("fresh-pending", NOW - 5 * 60_000, false);

    const res = await post();
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, unknown>;
    expect(out).toMatchObject({ ok: true, purgedOld: 2, purgedPending: 1, more: false });
    expect(out.statements).toBeLessThanOrEqual(10);
    expect(h.all("SELECT cam_id FROM cam_frames ORDER BY cam_id").map((r) => r.cam_id)).toEqual(["fresh-pending", "keep"]);
  });

  it("does nothing on an empty table", async () => {
    const out = (await (await post()).json()) as Record<string, unknown>;
    expect(out).toMatchObject({ ok: true, purgedOld: 0, purgedPending: 0, more: false });
  });

  it("is idempotent: a second run finds nothing", async () => {
    await add("old", NOW - 500 * DAY, true);
    await post();
    const again = (await (await post()).json()) as Record<string, unknown>;
    expect(again).toMatchObject({ purgedOld: 0, purgedPending: 0 });
  });

  it("answers 500 without leaking detail when D1 throws", async () => {
    ctl.db = {
      prepare() {
        throw new Error("secret detail (test)");
      },
    };
    const res = await post();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret detail");
  });
});
