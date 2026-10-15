// GET /api/quality/overrides — the owner's running seaweed verdicts, for the cam reader.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HAS_SQLITE, makeCamDb, type CamDb } from "@/lib/camFrames/testDb";
import { insertOverrideRow } from "@/lib/quality/testHelpers";

const ctl = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db/d1Store", () => ({ getD1: async () => ctl.db }));

import { GET } from "@/app/api/quality/overrides/route";

const TOKEN = "test-quality-token";
const NOW = Date.parse("2026-10-13T17:40:00.000Z");

const get = (slug: string | null = "boca-raton", headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) =>
  GET(new Request(`http://localhost/api/quality/overrides${slug === null ? "" : `?slug=${slug}`}`, { headers }));

let h: CamDb;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  process.env.QUALITY_INGEST_TOKEN = TOKEN;
  process.env.INGEST_TOKEN = "the-archive-token";
  h = makeCamDb({ allMigrations: true }) as CamDb;
  ctl.db = h?.db ?? null;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.QUALITY_INGEST_TOKEN;
  delete process.env.INGEST_TOKEN;
  h?.close();
});

describe("auth and input", () => {
  it("503 without QUALITY_INGEST_TOKEN, 401 without the right bearer token", async () => {
    expect((await get("boca-raton", {})).status).toBe(401);
    expect((await get("boca-raton", { authorization: "Bearer nope" })).status).toBe(401);
    delete process.env.QUALITY_INGEST_TOKEN;
    expect((await get()).status).toBe(503);
  });

  it("the archive's INGEST_TOKEN does not open it: the credentials are split", async () => {
    expect((await get("boca-raton", { authorization: "Bearer the-archive-token" })).status).toBe(401);
    delete process.env.QUALITY_INGEST_TOKEN;
    expect((await get("boca-raton", { authorization: "Bearer the-archive-token" })).status).toBe(503);
  });

  it("404 for a missing or unknown beach", async () => {
    expect((await get(null)).status).toBe(404);
    expect((await get("atlantis")).status).toBe(404);
    expect((await get("boca-raton%27%3B--")).status).toBe(404);
  });
});

describe.skipIf(!HAS_SQLITE)("overrides", () => {
  it("503 with no database", async () => {
    ctl.db = null;
    expect((await get()).status).toBe(503);
  });

  it("is empty when nobody has answered", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, slug: "boca-raton", now: "2026-10-13T17:40:00.000Z", overrides: [] });
  });

  it("lists today's verdicts for that beach, each bound to its exact claim, and only the ones in force", async () => {
    await insertOverrideRow(h.db, { alert_id: 1, cam_id: "boca-inlet-surf", verdict: "wrong", action: "reject", level: null, coverage_pct: null });
    await insertOverrideRow(h.db, { alert_id: 2, cam_id: "boca-south", frame_sha: null, frame_at: "2026-10-13T17:19:30Z" });
    await insertOverrideRow(h.db, { alert_id: 3, cam_id: "old", until_utc: "2026-10-13T17:00:00.000Z" }); // ended
    await insertOverrideRow(h.db, { alert_id: 4, cam_id: "replaced", superseded: 1 }); // superseded by a later tap
    await insertOverrideRow(h.db, { alert_id: 5, cam_id: "other", slug: "deerfield-beach" });
    await insertOverrideRow(h.db, { alert_id: 6, cam_id: "clarity-thing", signal: "clarity" });
    const out = (await (await get()).json()) as { overrides: Record<string, unknown>[] };
    expect(out.overrides).toEqual([
      {
        signal: "seaweed", id: expect.any(Number), camId: "boca-inlet-surf", verdict: "wrong", action: "reject", level: null, coveragePct: null, note: null,
        frameSha: "a".repeat(20), frameAt: null, claimedAt: "2026-10-13T17:21:00Z", localDate: "2026-10-13",
        createdAtUtc: "2026-10-13T17:35:00.000Z", untilUtc: "2026-10-14T04:00:00.000Z",
      },
      {
        signal: "seaweed", id: expect.any(Number), camId: "boca-south", verdict: "right", action: "publish", level: "moderate", coveragePct: 35, note: null,
        frameSha: null, frameAt: "2026-10-13T17:19:30Z", claimedAt: "2026-10-13T17:21:00Z", localDate: "2026-10-13",
        createdAtUtc: "2026-10-13T17:35:00.000Z", untilUtc: "2026-10-14T04:00:00.000Z",
      },
    ]);
  });

  it("answers 500, not a stack trace, when the database fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.exec("DROP TABLE quality_overrides");
    const res = await get();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "store-unavailable" });
  });
});
