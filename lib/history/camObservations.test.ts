import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { getStore } from "@/lib/db/store";
import { resetMemoryStore } from "@/lib/db/memoryStore";
import {
  archiveCamObservations,
  camReadRowsFromFeed,
  fetchCamFeed,
  hasVisionCamFeed,
  newObservationRows,
  MAX_CAM_ROWS_PER_PASS,
  type CamFeedDoc,
} from "@/lib/history/camObservations";
import { camReadRow, parseCapturedAtUtc, rowFromHistoryEntry } from "@/lib/history/camObservationRow.mjs";
import * as script from "@/scripts/backfill_cam_history.mjs";

const entry = (t: string, over: Record<string, unknown> = {}) => ({
  t,
  hour: 13,
  level: "moderate",
  people: 30,
  crowdPct: 55,
  seaweed: "low",
  cov: 12,
  water: "clear",
  clr: 70,
  ...over,
});

beforeEach(() => resetMemoryStore());
afterEach(() => vi.restoreAllMocks());

describe("parseCapturedAtUtc (shared by the archiver and the backfill script)", () => {
  it("converts offset-bearing local times, across DST, to UTC ISO", () => {
    expect(parseCapturedAtUtc("2026-06-04T13:00-04:00")).toBe("2026-06-04T17:00:00.000Z");
    expect(parseCapturedAtUtc("2026-12-04T13:00-05:00")).toBe("2026-12-04T18:00:00.000Z");
    expect(parseCapturedAtUtc("2026-06-04T17:00:00.000Z")).toBe("2026-06-04T17:00:00.000Z");
  });
  it("returns null for garbage", () => {
    for (const bad of ["nope", "", undefined, null, 5]) expect(parseCapturedAtUtc(bad)).toBeNull();
  });
  it("is literally the same function the backfill script exports (cannot drift)", () => {
    expect(script.parseCapturedAtUtc).toBe(parseCapturedAtUtc);
    expect(script.rowFromHistoryEntry).toBe(rowFromHistoryEntry);
  });
});

describe("rowFromHistoryEntry", () => {
  it("stores every field the entry carries, plus the verbatim entry and a source tag", () => {
    const e = entry("2026-10-06T07:00-04:00");
    const row = rowFromHistoryEntry("boca-raton", e)!;
    expect(row).toMatchObject({
      slug: "boca-raton",
      captured_at_utc: "2026-10-06T11:00:00.000Z",
      crowd_level: "moderate",
      crowd_pct: 55,
      people: 30,
      seaweed_level: "low",
      cov_pct: 12,
      water_word: "clear",
      clarity_pct: 70,
      uw_pct: null,
      uw_level: null,
      source: "feed",
    });
    expect(JSON.parse(row.raw_json)).toEqual(e);
  });

  it("records the underwater read and attaches the note from the feed's uw block", () => {
    const e = entry("2026-10-06T07:00-04:00", { uw: 55, uwLevel: "slightly_hazy" });
    const feed = { uw: { pct: 55, level: "slightly_hazy", note: "fine silt, 10 ft view", capturedAtLocal: "2026-10-06T07:12-04:00" } };
    const row = rowFromHistoryEntry("deerfield-beach", e, feed)!;
    expect(row.uw_pct).toBe(55);
    expect(row.uw_level).toBe("slightly_hazy");
    expect(JSON.parse(row.raw_json)).toMatchObject({ uw: 55, uwNote: "fine silt, 10 ft view" });
  });

  it("does not attach a note from an unrelated uw read (different percent, or hours apart)", () => {
    const e = entry("2026-10-06T07:00-04:00", { uw: 55, uwLevel: "hazy" });
    const other = { uw: { pct: 40, note: "x", capturedAtLocal: "2026-10-06T07:05-04:00" } };
    const old = { uw: { pct: 55, note: "x", capturedAtLocal: "2026-10-06T03:00-04:00" } };
    expect(JSON.parse(rowFromHistoryEntry("d", e, other)!.raw_json)).not.toHaveProperty("uwNote");
    expect(JSON.parse(rowFromHistoryEntry("d", e, old)!.raw_json)).not.toHaveProperty("uwNote");
  });

  it("skips an entry without a parseable capture time; tolerates missing/garbage fields", () => {
    expect(rowFromHistoryEntry("b", { seaweed: "low" })).toBeNull();
    const row = rowFromHistoryEntry("b", { t: "2026-10-06T07:00-04:00", crowdPct: "x", level: 4 })!;
    expect(row.crowd_pct).toBeNull();
    expect(row.crowd_level).toBeNull();
  });
});

describe("camReadRow / camReadRowsFromFeed (per-cam detail)", () => {
  const cam = (id: string) => ({
    id,
    name: `Cam ${id}`,
    level: "moderate",
    coveragePct: 33,
    note: "patches",
    crowd: "light",
    crowdPct: 20,
    people: 12,
    crowdNote: "few",
    water: "slightly_hazy",
    waterPct: 60,
    waterNote: "ok",
    provider: "gemini",
  });

  it("maps one cam read, keeping the full reading in raw_json", () => {
    const row = camReadRow("boca-raton", { capturedAtLocal: "2026-10-06T07:00-04:00" }, cam("a"))!;
    expect(row).toMatchObject({
      captured_at_utc: "2026-10-06T11:00:00.000Z",
      cam_id: "a",
      seaweed_level: "moderate",
      cov_pct: 33,
      crowd_level: "light",
      people: 12,
      water_word: "slightly_hazy",
      water_pct: 60,
    });
    expect(JSON.parse(row.raw_json).provider).toBe("gemini");
  });

  it("dedupes the same capture shared by morning and latest", () => {
    const g = { capturedAtLocal: "2026-10-06T07:00-04:00", cams: [cam("a"), cam("b")] };
    expect(camReadRowsFromFeed("boca-raton", { morning: g, latest: g })).toHaveLength(2);
  });

  it("skips a cam with no id/name, and a group with no capture time", () => {
    expect(camReadRow("b", { capturedAtLocal: "2026-10-06T07:00-04:00" }, { level: "low" })).toBeNull();
    expect(camReadRow("b", {}, cam("a"))).toBeNull();
  });
});

describe("newObservationRows", () => {
  const feed: CamFeedDoc = {
    history: [
      entry("2026-10-06T09:00-04:00"),
      entry("2026-10-06T08:00-04:00"),
      entry("2026-10-06T07:00-04:00"),
      { garbage: true },
      entry("2026-10-06T07:00-04:00"), // duplicate time
    ],
  };

  it("with nothing stored returns every parseable entry, oldest first, de-duplicated", () => {
    const rows = newObservationRows("boca-raton", feed, { latestUtc: null, recentUtcs: new Set() });
    expect(rows.map((r) => r.captured_at_utc)).toEqual([
      "2026-10-06T11:00:00.000Z",
      "2026-10-06T12:00:00.000Z",
      "2026-10-06T13:00:00.000Z",
    ]);
  });

  it("returns only entries newer than the newest stored read", () => {
    const rows = newObservationRows("boca-raton", feed, {
      latestUtc: "2026-10-06T12:00:00.000Z",
      recentUtcs: new Set(["2026-10-06T11:00:00.000Z", "2026-10-06T12:00:00.000Z"]),
    });
    expect(rows.map((r) => r.captured_at_utc)).toEqual(["2026-10-06T13:00:00.000Z"]);
  });

  it("also repairs a hole inside the repair window", () => {
    const rows = newObservationRows("boca-raton", feed, {
      latestUtc: "2026-10-06T13:00:00.000Z",
      recentUtcs: new Set(["2026-10-06T11:00:00.000Z", "2026-10-06T13:00:00.000Z"]), // 12:00 missing
    });
    expect(rows.map((r) => r.captured_at_utc)).toEqual(["2026-10-06T12:00:00.000Z"]);
  });

  it("caps a catch-up pass, keeping the OLDEST so no read is ever skipped", () => {
    const history = Array.from({ length: MAX_CAM_ROWS_PER_PASS + 50 }, (_, i) => {
      const utc = new Date(Date.UTC(2026, 8, 23, 0, i)).toISOString();
      return entry(utc);
    });
    const rows = newObservationRows("b", { history }, { latestUtc: null, recentUtcs: new Set() });
    expect(rows).toHaveLength(MAX_CAM_ROWS_PER_PASS);
    expect(rows[0].captured_at_utc).toBe(new Date(Date.UTC(2026, 8, 23, 0, 0)).toISOString());
  });
});

describe("archiveCamObservations (memory store)", () => {
  const feed: CamFeedDoc = {
    uw: { pct: 55, note: "silty", capturedAtLocal: "2026-10-06T08:00-04:00" },
    latest: {
      capturedAtLocal: "2026-10-06T08:00-04:00",
      cams: [{ id: "a", name: "A", level: "low", crowd: "light" }, { id: "b", name: "B", level: "none" }],
    },
    history: [
      entry("2026-10-06T07:00-04:00"),
      entry("2026-10-06T08:00-04:00", { uw: 55, uwLevel: "hazy" }),
    ],
  };

  it("writes the history reads and per-cam reads, and a second run writes nothing", async () => {
    const store = await getStore();
    const first = await archiveCamObservations(store, "deerfield-beach", async () => feed);
    expect(first).toEqual({ observations: 2, reads: 2 });
    const stored = await store.camObservationsSince("deerfield-beach", "2026-01-01T00:00:00.000Z");
    expect(stored.map((r) => r.uw_pct)).toEqual([null, 55]);
    expect(JSON.parse(stored[1].raw_json!).uwNote).toBe("silty");
    expect((await store.camReadsAt("deerfield-beach", "2026-10-06T12:00:00.000Z")).map((c) => c.cam_id)).toEqual(["a", "b"]);

    expect(await archiveCamObservations(store, "deerfield-beach", async () => feed)).toEqual({ observations: 0, reads: 0 });
  });

  it("picks up only the new read when the feed grows", async () => {
    const store = await getStore();
    await archiveCamObservations(store, "deerfield-beach", async () => feed);
    const grown: CamFeedDoc = { ...feed, history: [...feed.history!, entry("2026-10-06T09:00-04:00")] };
    const r = await archiveCamObservations(store, "deerfield-beach", async () => grown);
    expect(r.observations).toBe(1);
    expect(await store.latestCamObservationUtc("deerfield-beach")).toBe("2026-10-06T13:00:00.000Z");
  });

  it("a missing feed archives nothing; a throwing fetcher propagates (the route isolates it)", async () => {
    const store = await getStore();
    expect(await archiveCamObservations(store, "boca-raton", async () => null)).toEqual({ observations: 0, reads: 0 });
    await expect(
      archiveCamObservations(store, "boca-raton", async () => {
        throw new Error("feed down");
      }),
    ).rejects.toThrow("feed down");
  });
});

describe("fetchCamFeed + hasVisionCamFeed", () => {
  it("knows which beaches have a vision feed", () => {
    expect(hasVisionCamFeed("boca-raton")).toBe(true);
    expect(hasVisionCamFeed("toString")).toBe(false);
    expect(hasVisionCamFeed("some-camless-beach")).toBe(false);
  });

  it("uses the shared resolver: Boca falls back to the legacy file on a 404", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        urls.push(String(u));
        return urls.length === 1
          ? new Response("nf", { status: 404 })
          : new Response(JSON.stringify({ history: [] }), { status: 200 });
      }),
    );
    const doc = await fetchCamFeed("boca-raton");
    expect(doc).toEqual({ history: [] });
    expect(urls[0]).toMatch(/cam_seaweed\.boca-raton\.json$/);
    expect(urls[1]).toMatch(/cam_seaweed\.json$/);
    vi.unstubAllGlobals();
  });

  it("returns null for a 404 on a beach with no legacy fallback, and throws on a 500", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nf", { status: 404 })));
    expect(await fetchCamFeed("deerfield-beach")).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 500 })));
    await expect(fetchCamFeed("deerfield-beach")).rejects.toThrow();
    vi.unstubAllGlobals();
  });
});
