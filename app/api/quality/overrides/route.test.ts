// GET /api/quality/overrides — the owner's running seaweed verdicts, for the cam reader.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HAS_SQLITE, makeCamDb, type CamDb } from "@/lib/camFrames/testDb";
import { insertOverride } from "@/lib/quality/store";

const ctl = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db/d1Store", () => ({ getD1: async () => ctl.db }));

import { GET } from "@/app/api/quality/overrides/route";

const TOKEN = "test-ingest-token";
const NOW = Date.parse("2026-10-13T17:40:00.000Z");

const get = (slug: string | null = "boca-raton", headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) =>
  GET(new Request(`http://localhost/api/quality/overrides${slug === null ? "" : `?slug=${slug}`}`, { headers }));

let h: CamDb;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  process.env.INGEST_TOKEN = TOKEN;
  h = makeCamDb({ allMigrations: true }) as CamDb;
  ctl.db = h?.db ?? null;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.INGEST_TOKEN;
  h?.close();
});

describe("auth and input", () => {
  it("503 without INGEST_TOKEN, 401 without the right bearer token", async () => {
    expect((await get("boca-raton", {})).status).toBe(401);
    expect((await get("boca-raton", { authorization: "Bearer nope" })).status).toBe(401);
    delete process.env.INGEST_TOKEN;
    expect((await get()).status).toBe(503);
  });

  it("404 for a missing or unknown beach", async () => {
    expect((await get(null)).status).toBe(404);
    expect((await get("atlantis")).status).toBe(404);
    expect((await get("boca-raton%27%3B--")).status).toBe(404);
  });
});

describe.skipIf(!HAS_SQLITE)("overrides", () => {
  const base = { signal: "seaweed" as const, createdAtUtc: "2026-10-13T17:35:00.000Z", untilUtc: "2026-10-14T04:00:00.000Z", labelId: 1 };

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

  it("lists today's running verdicts for that beach, with the claim a Right publishes", async () => {
    await insertOverride(h.db, { ...base, slug: "boca-raton", camId: "boca-inlet-surf", verdict: "wrong" });
    await insertOverride(h.db, { ...base, slug: "boca-raton", camId: "boca-south", verdict: "right", claim: { level: "moderate", coveragePct: 35, note: null } });
    await insertOverride(h.db, { ...base, slug: "boca-raton", camId: "old", verdict: "wrong", untilUtc: "2026-10-13T17:00:00.000Z" }); // ended
    await insertOverride(h.db, { ...base, slug: "deerfield-beach", camId: "other", verdict: "wrong" });
    await insertOverride(h.db, { ...base, slug: "boca-raton", camId: "clarity-thing", signal: "clarity", verdict: "wrong" });
    const out = (await (await get()).json()) as { overrides: Record<string, unknown>[] };
    expect(out.overrides).toEqual([
      { signal: "seaweed", camId: "boca-inlet-surf", verdict: "wrong", createdAtUtc: base.createdAtUtc, untilUtc: base.untilUtc, claim: null },
      { signal: "seaweed", camId: "boca-south", verdict: "right", createdAtUtc: base.createdAtUtc, untilUtc: base.untilUtc, claim: { level: "moderate", coveragePct: 35, note: null } },
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
