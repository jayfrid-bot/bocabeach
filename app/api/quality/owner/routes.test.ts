// The owner-only quality routes: check, list, answer, report. Real SQLite for the
// quality tables; the owner check runs for real against the in-memory device store.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HAS_SQLITE, makeCamDb, type CamDb } from "@/lib/camFrames/testDb";
import { getStore, hashInstallToken } from "@/lib/db/store";
import { resetMemoryStore } from "@/lib/db/memoryStore";
import { resetMemoryRateLimit } from "@/lib/plus/rateLimit";
import { insertAlert } from "@/lib/quality/store";
import { insertFrame, insertHourly } from "@/lib/quality/testHelpers";

const ctl = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db/d1Store", () => ({ getD1: async () => ctl.db }));

import { POST as check } from "@/app/api/quality/owner/check/route";
import { POST as list } from "@/app/api/quality/owner/list/route";
import { POST as answer } from "@/app/api/quality/owner/answer/route";
import { POST as report } from "@/app/api/quality/owner/report/route";

const OWNER = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";
const TOKEN = "owner-install-token";
const SHA = "ab".repeat(32);
const NOW = Date.parse("2026-10-13T17:45:00.000Z");

type Route = (req: Request) => Promise<Response>;
function call(route: Route, body: Record<string, unknown>, headers: Record<string, string> = { "x-install-token": TOKEN }): Promise<Response> {
  return route(
    new Request("http://localhost/api/quality/owner/x", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}
const asOwner = (route: Route, body: Record<string, unknown> = {}) => call(route, { deviceId: OWNER, ...body });

let h: CamDb;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  process.env.OWNER_DEVICE_IDS = OWNER;
  process.env.CAM_FRAME_URL_KEY = "test-signing-key";
  resetMemoryStore();
  resetMemoryRateLimit();
  const store = await getStore();
  await store.upsertDevice(OWNER, {});
  await store.setInstallTokenHash(OWNER, hashInstallToken(TOKEN), Date.now());
  await store.upsertDevice(OTHER, {});
  await store.setInstallTokenHash(OTHER, hashInstallToken("other"), Date.now());
  h = makeCamDb({ allMigrations: true }) as CamDb;
  ctl.db = h?.db ?? null;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.OWNER_DEVICE_IDS;
  delete process.env.CAM_FRAME_URL_KEY;
  h?.close();
});

describe("every owner route is closed to everyone else", () => {
  const routes: [string, Route, Record<string, unknown>][] = [
    ["check", check, {}],
    ["list", list, {}],
    ["answer", answer, { alertId: 1, verdict: "right" }],
    ["report", report, { slug: "boca-raton", seaweed: "low" }],
  ];

  for (const [name, route, extra] of routes) {
    it(`${name}: refuses a phone that is not the owner, one with no token, and a closed list`, async () => {
      const notOwner = await call(route, { deviceId: OTHER, ...extra }, { "x-install-token": "other" });
      expect(notOwner.status).toBe(403);
      expect(await notOwner.json()).toEqual({ ok: false, error: "not-owner" });
      expect((await call(route, { deviceId: OWNER, ...extra }, {})).status).toBe(401);
      expect((await call(route, { deviceId: OWNER, ...extra }, { "x-install-token": "wrong" })).status).toBe(401);
      expect((await call(route, { ...extra })).status).toBe(400);
      delete process.env.OWNER_DEVICE_IDS;
      expect((await asOwner(route, extra)).status).toBe(503);
    });
  }

  it("a refused request writes nothing", async () => {
    await call(report, { deviceId: OTHER, slug: "boca-raton", seaweed: "low" }, { "x-install-token": "other" });
    if (HAS_SQLITE) expect(h.all("SELECT COUNT(*) AS n FROM quality_labels")[0].n).toBe(0);
  });
});

describe("check", () => {
  it("tells the owner phone it is the owner", async () => {
    const res = await asOwner(check);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.json()).toEqual({ ok: true, owner: true });
  });
});

describe.skipIf(!HAS_SQLITE)("list", () => {
  it("503 with no database", async () => {
    ctl.db = null;
    expect((await asOwner(list)).status).toBe(503);
  });

  it("returns open alerts with a signed picture link, and nothing a visitor could use", async () => {
    await insertFrame(h.db, { sha256: SHA, at: "2026-10-13T17:21:00.000Z" });
    await insertAlert(h.db, {
      slug: "boca-raton", signal: "seaweed", kind: "seaweed-held-disagreed", createdAt: "2026-10-13T17:30:00.000Z", dedupeKey: "a",
      payload: {
        camId: "boca-inlet-surf", camName: "Boca Inlet Cam", observedAt: "2026-10-13T17:20:00.000Z", published: { level: "none", pct: 0 },
        claim: { level: "moderate", coveragePct: 35, note: null, provider: "gemini", model: null },
        secondOpinion: { provider: "clef", model: null, level: "none", coveragePct: 0, note: null },
        others: [{ id: "b", name: "Boca South", level: "none", coveragePct: 0, carried: false }],
        frame: { sha256: SHA, archivedThisTick: true },
      },
    });
    const res = await asOwner(list);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { ok: boolean; now: string; open: { statement: string; frames: { url: string; exact: boolean }[] }[]; recent: unknown[] };
    expect(out.now).toBe("2026-10-13T17:45:00.000Z");
    expect(out.open).toHaveLength(1);
    expect(out.open[0].statement).toBe("Boca Inlet cam says moderate seaweed (35%)");
    expect(out.open[0].frames[0].exact).toBe(true);
    expect(out.open[0].frames[0].url).toMatch(/^\/api\/cam-frames\/img\?k=boca-raton%2Fboca-inlet-surf/);
    expect(JSON.stringify(out)).not.toContain(OWNER);
    expect(out.recent).toEqual([]);
  });

  it("is empty, not an error, when there are no alerts", async () => {
    expect(await (await asOwner(list)).json()).toMatchObject({ ok: true, open: [], recent: [] });
  });
});

describe.skipIf(!HAS_SQLITE)("answer", () => {
  async function seed(): Promise<number> {
    return (
      await insertAlert(h.db, {
        slug: "boca-raton", signal: "seaweed", kind: "seaweed-held-disagreed", createdAt: "2026-10-13T17:30:00.000Z", dedupeKey: "a",
        payload: {
          camId: "boca-inlet-surf", camName: "Boca Inlet Cam", observedAt: "2026-10-13T17:20:00.000Z", published: null,
          claim: { level: "moderate", coveragePct: 35, note: null, provider: "gemini", model: null },
          secondOpinion: { provider: "clef", model: null, level: "none", coveragePct: 0, note: null },
          others: [], frame: { sha256: null, archivedThisTick: false },
        },
      })
    ).id;
  }

  it("Wrong with the correct value: label, closed alert, override", async () => {
    const id = await seed();
    const res = await asOwner(answer, { alertId: id, verdict: "wrong", correct: { level: "none" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, overrideAdded: true });
    expect(h.all("SELECT verdict, correct_value FROM quality_labels")).toEqual([{ verdict: "wrong", correct_value: '{"level":"none"}' }]);
    expect(h.all("SELECT cam_id FROM quality_overrides")).toEqual([{ cam_id: "boca-inlet-surf" }]);
    expect(h.all("SELECT status FROM quality_alerts")).toEqual([{ status: "answered" }]);
  });

  it("Right: label, closed alert, and a Right override that carries the claim", async () => {
    const id = await seed();
    const res = await asOwner(answer, { alertId: id, verdict: "right" });
    expect(await res.json()).toMatchObject({ ok: true, overrideAdded: true });
    expect(h.all("SELECT cam_id, verdict, claim_json FROM quality_overrides")).toEqual([
      { cam_id: "boca-inlet-surf", verdict: "right", claim_json: '{"level":"moderate","coveragePct":35,"note":null}' },
    ]);
  });

  it("409 on a second answer, 404 on an unknown alert, 400 on a bad request or value", async () => {
    const id = await seed();
    expect((await asOwner(answer, { alertId: id, verdict: "right" })).status).toBe(200);
    expect((await asOwner(answer, { alertId: id, verdict: "right" })).status).toBe(409);
    expect((await asOwner(answer, { alertId: 4040, verdict: "right" })).status).toBe(404);
    const id2 = (await insertAlert(h.db, { slug: "boca-raton", signal: "seaweed", kind: "seaweed-held-disagreed", createdAt: "2026-10-13T17:31:00.000Z", dedupeKey: "b", payload: { camId: "boca-south", observedAt: "2026-10-13T17:20:00.000Z" } })).id;
    expect((await asOwner(answer, { alertId: id2, verdict: "wrong", correct: { level: "huge" } })).status).toBe(400);
    for (const bad of [{ alertId: "1", verdict: "right" }, { alertId: 1.5, verdict: "right" }, { alertId: 0, verdict: "right" }, { alertId: 1, verdict: "maybe" }, { alertId: 1 }]) {
      expect((await asOwner(answer, bad)).status).toBe(400);
    }
    expect(h.all("SELECT COUNT(*) AS n FROM quality_labels")[0].n).toBe(1);
  });
});

describe.skipIf(!HAS_SQLITE)("report", () => {
  it("saves the owner's report with the nearest frames", async () => {
    await insertHourly(h.db, { hour_utc: "2026-10-13T17:00:00.000Z", seaweed_level: "none" });
    await insertFrame(h.db, { at: "2026-10-13T17:40:00.000Z" });
    const res = await asOwner(report, { slug: "boca-raton", seaweed: "moderate", clarity: "slightly_murky", surfFt: 3, sandF: 98, note: "weed line at the jetty" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, saved: 4, frames: 1 });
    expect(h.all("SELECT signal, source, verdict FROM quality_labels ORDER BY id")).toEqual([
      { signal: "seaweed", source: "report", verdict: null },
      { signal: "clarity", source: "report", verdict: null },
      { signal: "surf", source: "report", verdict: null },
      { signal: "sand", source: "report", verdict: null },
    ]);
  });

  it("400 for an empty report, an unknown beach, or a bad value, and nothing is saved", async () => {
    for (const bad of [{ slug: "boca-raton" }, { slug: "atlantis", seaweed: "low" }, { slug: "boca-raton", seaweed: "lots" }, { slug: "boca-raton", surfFt: 500 }]) {
      expect((await asOwner(report, bad)).status).toBe(400);
    }
    expect(h.all("SELECT COUNT(*) AS n FROM quality_labels")[0].n).toBe(0);
  });

  it("answers 500, not a stack trace, when the database fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.exec("DROP TABLE quality_labels");
    const res = await asOwner(report, { slug: "boca-raton", seaweed: "low" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "store-unavailable" });
  });
});
