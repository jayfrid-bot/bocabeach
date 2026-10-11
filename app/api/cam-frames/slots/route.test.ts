// GET /api/cam-frames/slots — the capture script's pre-check. Real SQLite, frozen clock.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HAS_SQLITE, makeCamDb, type CamDb } from "@/lib/camFrames/testDb";
import { CLAIM_A, frameRow } from "@/lib/camFrames/testFixtures";
import { claimSlot, markReady } from "@/lib/camFrames/store";

const ctl = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db/d1Store", () => ({ getD1: async () => ctl.db }));

import { GET } from "@/app/api/cam-frames/slots/route";

const TOKEN = "test-ingest-token";
const NOW = Date.parse("2026-10-11T14:20:00.000Z");
const SLOT_NOW = "2026-10-11T14:00:00.000Z";
const SLOT_PREV = "2026-10-11T13:00:00.000Z";

let h: CamDb;

function get(slug = "boca-raton", headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }): Promise<Response> {
  return GET(new Request(`http://localhost/api/cam-frames/slots?slug=${slug}`, { headers }));
}

async function put(cam: string, slot: string, claimedAt: string, ready: boolean, slug = "boca-raton"): Promise<void> {
  const row = frameRow({ slug, cam_id: cam, slot_utc: slot, claimed_at_utc: claimedAt, received_at_utc: claimedAt });
  await claimSlot(h.db, row);
  if (ready) await markReady(h.db, slug, cam, slot, CLAIM_A);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  process.env.INGEST_TOKEN = TOKEN;
  h = makeCamDb() as CamDb;
  ctl.db = h?.db ?? null;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.INGEST_TOKEN;
  h?.close();
});

describe("auth and input", () => {
  it("503s without INGEST_TOKEN and 401s without the right bearer token", async () => {
    expect((await get("boca-raton", {})).status).toBe(401);
    expect((await get("boca-raton", { authorization: "Bearer nope" })).status).toBe(401);
    delete process.env.INGEST_TOKEN;
    expect((await get()).status).toBe(503);
  });

  it("404s on a missing, malformed or unknown slug, or one with no archived cams", async () => {
    for (const slug of ["", "nowhere", "BOCA", "boca-raton%27%3B--", "fort-myers"]) {
      expect((await get(slug)).status).toBe(404);
    }
  });
});

describe.skipIf(!HAS_SQLITE)("slots", () => {
  it("503s with no database", async () => {
    ctl.db = null;
    expect((await get()).status).toBe(503);
  });

  it("returns empty lists for the current and previous three slots when nothing is stored", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      ok: true,
      slug: "boca-raton",
      now: "2026-10-11T14:20:00.000Z",
      slots: { [SLOT_NOW]: [], [SLOT_PREV]: [], "2026-10-11T12:00:00.000Z": [], "2026-10-11T11:00:00.000Z": [] },
    });
  });

  it("lists cams whose slot is ready or freshly pending (at most 10 minutes), per slot", async () => {
    await put("boca-south", SLOT_NOW, "2026-10-11T14:01:00.000Z", true);
    await put("boca-inlet", SLOT_NOW, "2026-10-11T14:15:00.000Z", false); // fresh pending
    await put("boca-inlet-north", SLOT_NOW, "2026-10-11T14:05:00.000Z", false); // pending, 15 min old: not filled
    await put("boca-south-surf", SLOT_PREV, "2026-10-11T13:30:00.000Z", true);
    await put("boca-inlet-surf", "2026-10-11T12:00:00.000Z", "2026-10-11T12:30:00.000Z", true); // two hours back
    await put("deerfield-beach-cam", SLOT_NOW, "2026-10-11T14:01:00.000Z", true, "deerfield-beach");
    const out = (await (await get()).json()) as { slots: Record<string, string[]> };
    expect(out.slots).toEqual({
      [SLOT_NOW]: ["boca-inlet", "boca-south"],
      [SLOT_PREV]: ["boca-south-surf"],
      "2026-10-11T12:00:00.000Z": ["boca-inlet-surf"], // two hours back: now inside the window
      "2026-10-11T11:00:00.000Z": [],
    });
  });

  it("follows the clock into the next hour", async () => {
    await put("boca-south", SLOT_NOW, "2026-10-11T14:01:00.000Z", true);
    vi.setSystemTime(Date.parse("2026-10-11T15:02:00.000Z"));
    const out = (await (await get()).json()) as { slots: Record<string, string[]> };
    expect(Object.keys(out.slots)).toEqual([
      "2026-10-11T15:00:00.000Z",
      SLOT_NOW,
      "2026-10-11T13:00:00.000Z",
      "2026-10-11T12:00:00.000Z",
    ]);
    expect(out.slots[SLOT_NOW]).toEqual(["boca-south"]);
    expect(out.slots["2026-10-11T15:00:00.000Z"]).toEqual([]);
  });

  it("503s without leaking detail when D1 throws", async () => {
    ctl.db = {
      prepare() {
        throw new Error("secret detail (test)");
      },
    };
    const res = await get();
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("secret detail");
  });
});
