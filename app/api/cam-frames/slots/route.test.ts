// GET /api/cam-frames/slots — the capture script's pre-check. Real SQLite, frozen clock.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HAS_SQLITE, makeCamDb, type CamDb } from "@/lib/camFrames/testDb";
import { CLAIM_A, frameRow } from "@/lib/camFrames/testFixtures";
import { claimSlot, markReady } from "@/lib/camFrames/store";

const ctl = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db/d1Store", () => ({ getD1: async () => ctl.db }));

import { GET } from "@/app/api/cam-frames/slots/route";

const TOKEN = "test-ingest-token";
// 12:20 PM EDT: far from both golden windows (sunrise 10:57-11:57Z, sunset 22:16-23:16Z).
const NOW = Date.parse("2026-10-11T16:20:00.000Z");
const SLOT_NOW = "2026-10-11T16:00:00.000Z";
const SLOT_PREV = "2026-10-11T15:00:00.000Z";

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
      now: "2026-10-11T16:20:00.000Z",
      currentSlotUtc: SLOT_NOW,
      golden: expect.any(Array), // all windows of the previous, current and next local dates: see below
      slots: { [SLOT_NOW]: [], [SLOT_PREV]: [], "2026-10-11T14:00:00.000Z": [], "2026-10-11T13:00:00.000Z": [] },
    });
  });

  it("lists cams whose slot is ready or freshly pending (at most 10 minutes), per slot", async () => {
    await put("boca-south", SLOT_NOW, "2026-10-11T16:01:00.000Z", true);
    await put("boca-inlet", SLOT_NOW, "2026-10-11T16:15:00.000Z", false); // fresh pending
    await put("boca-inlet-north", SLOT_NOW, "2026-10-11T16:05:00.000Z", false); // pending, 15 min old: not filled
    await put("boca-south-surf", SLOT_PREV, "2026-10-11T15:30:00.000Z", true);
    await put("boca-inlet-surf", "2026-10-11T14:00:00.000Z", "2026-10-11T14:30:00.000Z", true); // two hours back
    await put("deerfield-beach-cam", SLOT_NOW, "2026-10-11T16:01:00.000Z", true, "deerfield-beach");
    const out = (await (await get()).json()) as { slots: Record<string, string[]> };
    expect(out.slots).toEqual({
      [SLOT_NOW]: ["boca-inlet", "boca-south"],
      [SLOT_PREV]: ["boca-south-surf"],
      "2026-10-11T14:00:00.000Z": ["boca-inlet-surf"], // two hours back: now inside the window
      "2026-10-11T13:00:00.000Z": [],
    });
  });

  it("follows the clock into the next hour", async () => {
    await put("boca-south", SLOT_NOW, "2026-10-11T16:01:00.000Z", true);
    vi.setSystemTime(Date.parse("2026-10-11T17:02:00.000Z"));
    const out = (await (await get()).json()) as { slots: Record<string, string[]>; currentSlotUtc: string };
    expect([...Object.keys(out.slots)].sort()).toEqual([
      "2026-10-11T14:00:00.000Z",
      "2026-10-11T15:00:00.000Z",
      SLOT_NOW,
      "2026-10-11T17:00:00.000Z",
    ]);
    expect(out.currentSlotUtc).toBe("2026-10-11T17:00:00.000Z");
    expect(out.slots[SLOT_NOW]).toEqual(["boca-south"]);
    expect(out.slots["2026-10-11T17:00:00.000Z"]).toEqual([]);
  });

  describe("golden-hour windows", () => {
    // Boca, 2026-10-11: sunrise window 10:57:34Z-11:57:34Z (sunrise 11:17:34Z, 7:17 AM EDT).
    const IN_WINDOW = Date.parse("2026-10-11T11:24:30.000Z"); // 7:24 AM EDT

    type Out = { currentSlotUtc: string; golden: { kind: string; startUtc: string; endUtc: string }[]; slots: Record<string, string[]> };

    it("inside a window the current slot is the 10-minute slot, and the window's slots are listed", async () => {
      vi.setSystemTime(IN_WINDOW);
      const out = (await (await get()).json()) as Out;
      expect(out.currentSlotUtc).toBe("2026-10-11T11:20:00.000Z");
      expect(out.golden).toContainEqual({ kind: "sunrise", startUtc: "2026-10-11T10:57:34.565Z", endUtc: "2026-10-11T11:57:34.565Z" });
      // The 10-minute slots of the window, from the one holding its start up to now, plus the four hour slots.
      for (const s of ["10:50", "11:00", "11:10", "11:20"]) expect(out.slots).toHaveProperty([`2026-10-11T${s}:00.000Z`]);
      expect(out.slots).not.toHaveProperty(["2026-10-11T11:30:00.000Z"]); // still in the future
      for (const s of ["11:00", "10:00", "09:00", "08:00"]) expect(out.slots).toHaveProperty([`2026-10-11T${s}:00.000Z`]);
    });

    it("says whether the slot a frame taken now would land in is filled", async () => {
      vi.setSystemTime(IN_WINDOW);
      await put("boca-south", "2026-10-11T11:20:00.000Z", "2026-10-11T11:21:00.000Z", true);
      await put("boca-inlet", "2026-10-11T11:10:00.000Z", "2026-10-11T11:12:00.000Z", true); // the slot before: not the current one
      const out = (await (await get()).json()) as Out;
      expect(out.slots[out.currentSlotUtc]).toEqual(["boca-south"]);
      expect(out.slots["2026-10-11T11:10:00.000Z"]).toEqual(["boca-inlet"]);
    });

    it("outside every window the current slot is the hour slot and no golden SLOT is listed", async () => {
      const out = (await (await get()).json()) as Out;
      expect(out.currentSlotUtc).toBe(SLOT_NOW);
      expect(Object.keys(out.slots)).toHaveLength(4);
    });

    it("returns ALL windows of the previous, current and next local dates, however far from now", async () => {
      // 12:20 PM EDT on Oct 11: no window is near, but the day before, the day itself and the day after all report.
      const out = (await (await get()).json()) as Out;
      expect(out.golden.map((w) => [w.kind, w.startUtc.slice(0, 10)])).toEqual([
        ["sunrise", "2026-10-10"],
        ["sunset", "2026-10-10"],
        ["sunrise", "2026-10-11"],
        ["sunset", "2026-10-11"],
        ["sunrise", "2026-10-12"],
        ["sunset", "2026-10-12"],
      ]);
      expect(JSON.stringify(out.golden).length).toBeLessThan(900);
    });

    it("a window that opens one minute after the request is already in the reply", async () => {
      // 6:56 AM EDT; the sunrise window opens at 10:57:34Z (6:57:34 AM).
      vi.setSystemTime(Date.parse("2026-10-11T10:56:00.000Z"));
      const out = (await (await get()).json()) as Out;
      expect(out.currentSlotUtc).toBe("2026-10-11T10:00:00.000Z"); // an hour slot right now
      expect(out.golden).toContainEqual({ kind: "sunrise", startUtc: "2026-10-11T10:57:34.565Z", endUtc: "2026-10-11T11:57:34.565Z" });
    });

    it("lists a window that ended earlier in the 3-hour range, but not one wholly before it", async () => {
      // 8:30 AM EDT: the sunrise window ended at 11:57Z (a half hour back).
      vi.setSystemTime(Date.parse("2026-10-11T12:30:00.000Z"));
      const out = (await (await get()).json()) as Out;
      expect(out.slots).toHaveProperty(["2026-10-11T11:50:00.000Z"]);
      expect(out.slots).not.toHaveProperty(["2026-10-11T12:10:00.000Z"]); // no 10-minute slot after the window
      // 4 hours after the window: it is out of the slot range (the window itself is still in `golden`).
      vi.setSystemTime(Date.parse("2026-10-11T16:30:00.000Z"));
      const later = (await (await get()).json()) as Out;
      expect(Object.keys(later.slots).filter((k) => !k.endsWith(":00:00.000Z"))).toEqual([]);
    });
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
