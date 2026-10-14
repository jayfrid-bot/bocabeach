// POST /api/quality/drain — the cron's second call: send the owner pushes that alerts queued.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HAS_SQLITE, makeCamDb, type CamDb } from "@/lib/camFrames/testDb";
import { recordAlert } from "@/lib/quality/alerts";
import { seedOwnerSession } from "@/lib/quality/testHelpers";

const ctl = vi.hoisted(() => ({ db: null as unknown, sent: [] as { token: string; url: string }[], apns: true }));
vi.mock("@/lib/db/d1Store", () => ({ getD1: async () => ctl.db }));
vi.mock("@/lib/push/apns", () => ({
  getApns: () => (ctl.apns ? { keyId: "k", teamId: "t", bundleId: "b", privateKey: "p", production: false } : null),
  isDeadToken: () => false,
  openApnsSession: () => ({
    send: async (token: string, payload: { url: string }) => {
      ctl.sent.push({ token, url: payload.url });
      return { ok: true, status: 200 };
    },
    sendLiveActivityUpdate: async () => ({ ok: true, status: 200 }),
    close: () => {},
  }),
}));

import { POST } from "@/app/api/quality/drain/route";

const SECRET = "cron-secret-test";
const NOW = Date.parse("2026-10-14T16:00:30.000Z"); // noon EDT

const post = (headers: Record<string, string> = { "x-cron-secret": SECRET }) =>
  POST(new Request("http://localhost/api/quality/drain", { method: "POST", headers }));

let h: CamDb;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  process.env.CRON_SECRET = SECRET;
  h = makeCamDb({ allMigrations: true }) as CamDb;
  ctl.db = h?.db ?? null;
  ctl.sent = [];
  ctl.apns = true;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.CRON_SECRET;
  h?.close();
});

describe("auth", () => {
  it("503 without CRON_SECRET, 401 with the wrong one", async () => {
    expect((await post({})).status).toBe(401);
    expect((await post({ "x-cron-secret": "nope" })).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await post()).status).toBe(503);
    expect(ctl.sent).toEqual([]);
  });
});

describe.skipIf(!HAS_SQLITE)("drain", () => {
  async function queueOne() {
    return recordAlert(
      h.db,
      {
        slug: "boca-raton", signal: "score", kind: "hourly-jump", createdAt: new Date(NOW - 30_000).toISOString(), dedupeKey: "k",
        payload: { observedAt: "x", fromHourUtc: "y", from: 78, to: 58, delta: -20, cause: null, published: { value: 58 } },
      },
      NOW - 30_000,
    );
  }

  it("sends the queued push to the owner's phone and says so", async () => {
    await seedOwnerSession(h.db, { pushToken: "ab".repeat(32) });
    const a = await queueOne();
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, sent: 1, released: 0, stale: 0, unknown: 0 });
    expect(ctl.sent).toEqual([{ token: "ab".repeat(32), url: `https://app.isitbeachday.com/admin/review?alert=${a.id}` }]);
    expect(h.all("SELECT pushed FROM quality_alerts")[0].pushed).toBe(1);
  });

  it("with no owner phone enrolled it gives the slot back and sends nothing", async () => {
    await queueOne();
    expect(await (await post()).json()).toEqual({ ok: true, sent: 0, released: 1, stale: 0, unknown: 0 });
    expect(ctl.sent).toEqual([]);
    expect(h.all("SELECT COUNT(*) AS n FROM quality_push_slots")[0].n).toBe(0);
  });

  it("is a quiet no-op with nothing queued, and with no database", async () => {
    expect(await (await post()).json()).toEqual({ ok: true, sent: 0, released: 0, stale: 0, unknown: 0 });
    ctl.db = null;
    expect(await (await post()).json()).toMatchObject({ ok: true, sent: 0 });
  });

  it("answers 500, not a stack trace, when the database fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.exec("DROP TABLE quality_push_slots");
    const res = await post();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "drain-failed" });
  });
});
