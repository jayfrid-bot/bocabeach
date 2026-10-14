// The history archiver hands every row it writes to the quality watchdog
// (lib/quality/watchdog.ts). Real SQLite holds the earlier hour and the alerts;
// the build and the owner push are fakes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HAS_SQLITE, makeCamDb, type CamDb } from "@/lib/camFrames/testDb";
import { scorableResponse } from "@/lib/alerts/fixtures";
import { getLocation, listLocations } from "@/config/locations";
import { getStore } from "@/lib/db/store";
import { hourUtcOf, rowFromConditions } from "@/lib/history/archive";
import type { OwnerPush } from "@/lib/quality/notify";

const ctl = vi.hoisted(() => ({ db: null as unknown, sent: [] as unknown[] }));
vi.mock("@/lib/db/d1Store", () => ({ getD1: async () => ctl.db }));
vi.mock("@/lib/quality/notify", async (orig) => ({
  ...(await orig<typeof import("@/lib/quality/notify")>()),
  sendOwnerPush: async (msg: OwnerPush) => {
    ctl.sent.push(msg);
    return { ok: true, sent: 1, failed: 0 };
  },
}));
vi.mock("@/lib/conditions", () => ({
  getConditionsForLocation: async () => {
    const res = scorableResponse();
    res.snapshot.generatedAt = new Date().toISOString();
    return res;
  },
}));

import { POST } from "@/app/api/history/archive/route";
import { resetMemoryStore } from "@/lib/db/memoryStore";

const SECRET = "test-cron-secret";
const NOW = Date.parse("2026-10-13T16:20:00.000Z"); // 12:20 PM EDT
const HOUR = hourUtcOf(NOW);
const PREV_HOUR = hourUtcOf(NOW - 3_600_000);

function post(): Promise<Response> {
  return POST(new Request("http://localhost/api/history/archive", { method: "POST", headers: { "x-cron-secret": SECRET } }));
}

/** What this hour's row will be, so the earlier hour can be built to differ from it in one chosen way. */
function thisHoursRow() {
  const res = scorableResponse();
  res.snapshot.generatedAt = new Date(NOW).toISOString();
  return rowFromConditions(res, getLocation("boca-raton")!, NOW, { hourUtc: HOUR });
}

let h: CamDb;
async function insertPrev(over: Record<string, unknown>): Promise<void> {
  const row = { ...thisHoursRow(), hour_utc: PREV_HOUR, ...over } as Record<string, unknown>;
  const cols = Object.keys(row);
  await h.db
    .prepare(`INSERT INTO beach_hourly (${cols.join(", ")}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(", ")})`)
    .bind(...cols.map((c) => row[c]))
    .run();
}

/** Every other beach already has this hour, so the one build this tick goes to Boca Raton. */
async function fillOtherBeaches(): Promise<void> {
  const store = await getStore();
  for (const loc of listLocations()) {
    if (loc.slug === "boca-raton") continue;
    const res = scorableResponse();
    res.snapshot.generatedAt = new Date(NOW).toISOString();
    await store.upsertBeachHourly(rowFromConditions(res, loc, NOW, { hourUtc: HOUR }));
  }
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network (test)"); }));
  vi.spyOn(console, "error").mockImplementation(() => {}); // the cam feed is "down" in every test; the route logs it
  resetMemoryStore();
  process.env.CRON_SECRET = SECRET;
  process.env.HISTORY_MAX_BUILDS_PER_DAY = "5000";
  h = makeCamDb({ allMigrations: true }) as CamDb;
  ctl.db = h?.db ?? null;
  ctl.sent = [];
  await fillOtherBeaches();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.HISTORY_MAX_BUILDS_PER_DAY;
  h?.close();
});

describe.skipIf(!HAS_SQLITE)("archive route and the quality watchdog", () => {
  it("an unexplained score drop from the hour before becomes an alert, and the archive still counts the row", async () => {
    const cur = thisHoursRow();
    await insertPrev({ score: (cur.score as number) + 30 });
    const out = (await (await post()).json()) as { archived: number };
    expect(out.archived).toBe(1);
    const alerts = h.all("SELECT slug, signal, kind, dedupe_key FROM quality_alerts");
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts.find((a) => a.signal === "score")).toEqual({
      slug: "boca-raton", signal: "score", kind: "hourly-jump", dedupe_key: `hourly:boca-raton:score:${HOUR}`,
    });
    expect(ctl.sent.length).toBeGreaterThanOrEqual(1);
  });

  it("a drop that rain explains makes no alert", async () => {
    const cur = thisHoursRow();
    await insertPrev({ score: (cur.score as number) + 30, rain_now: cur.rain_now === 1 ? 0 : 1 });
    await post();
    expect(h.all("SELECT COUNT(*) AS n FROM quality_alerts WHERE signal = 'score'")[0].n).toBe(0);
  });

  it("no earlier hour means nothing to compare and no alert", async () => {
    expect(((await (await post()).json()) as { archived: number }).archived).toBe(1);
    expect(h.all("SELECT COUNT(*) AS n FROM quality_alerts")[0].n).toBe(0);
  });

  it("a watchdog failure never fails the archive row", async () => {
    const cur = thisHoursRow();
    await insertPrev({ score: (cur.score as number) + 30 });
    h.exec("DROP TABLE quality_alerts");
    const out = (await (await post()).json()) as { archived: number; skipped: number };
    expect(out).toMatchObject({ archived: 1, skipped: 0 });
  });
});
