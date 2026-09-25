import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { modelNowFromSeries, ripNwpsFeedUrl, type RipNwpsBeachSeries } from "@/lib/sources/ripNwps";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const SERIES: RipNwpsBeachSeries = {
  office: "mfl",
  run: "2026-09-24T00:00:00.000Z",
  point: { lon: -80.066, lat: 26.3616 },
  hours: [
    { t: "2026-09-24T18:00:00.000Z", prob: 2.6, hsFt: 1.27, periodS: 7.2, dirDeg: -10 },
    { t: "2026-09-24T19:00:00.000Z", prob: 3.1, hsFt: 1.31, periodS: 7.1, dirDeg: -12 },
    { t: "2026-09-24T20:00:00.000Z", prob: 55, hsFt: 1.39, periodS: 7.2, dirDeg: -16 },
  ],
};

describe("modelNowFromSeries", () => {
  it("finds the row for the clock hour containing tMs (no interpolation)", () => {
    const now = Date.parse("2026-09-24T18:00:00.000Z");
    const m = modelNowFromSeries(SERIES, now);
    expect(m?.prob).toBe(2.6);
    expect(m?.level).toBe("low");
    expect(m?.run).toBe(SERIES.run);
  });

  it("bands the probability per the app's Low/Moderate/High thresholds", () => {
    const now = Date.parse("2026-09-24T20:00:00.000Z");
    const m = modelNowFromSeries(SERIES, now);
    expect(m?.prob).toBe(55);
    expect(m?.level).toBe("high");
  });

  it("returns null for an hour with no matching row", () => {
    const now = Date.parse("2026-09-25T05:00:00.000Z");
    expect(modelNowFromSeries(SERIES, now)).toBeNull();
  });

  it("returns null for a null series", () => {
    expect(modelNowFromSeries(null, Date.now())).toBeNull();
  });
});

describe("ripNwpsFeedUrl", () => {
  it("points at rip_nwps.json on its OWN rip-data branch (never sargassum-data, which sargassum.yml/backfill-pct.yml force-push as an orphan branch and would wipe it)", () => {
    expect(ripNwpsFeedUrl()).toBe(
      "https://raw.githubusercontent.com/jayfrid-bot/bocabeach/rip-data/rip_nwps.json",
    );
  });
});

describe("fetchRipNwps", () => {
  beforeEach(() => {
    vi.resetModules();
    // The fixture's model run is 2026-09-24T00:00Z; the adapter's 36-h
    // staleness gate reads the real clock, so pin "now" to the fixture's day
    // (this file failed once the calendar moved past that window).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-24T17:30:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("no coverage for an unmapped beach — never fetches", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { fetchRipNwps } = await import("@/lib/sources/ripNwps");
    const r = await fetchRipNwps("nowhere-beach");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.data).toBeNull();
    expect(r.note).toMatch(/no NOAA rip model coverage/i);
  });

  it("returns the beach's series for a mapped, fresh beach", async () => {
    const feed = { generatedAt: new Date().toISOString(), beaches: { "boca-raton": SERIES } };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(feed));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchRipNwps } = await import("@/lib/sources/ripNwps");
    const r = await fetchRipNwps("boca-raton");
    expect(r.status).toBe("ok");
    expect(r.data?.office).toBe("mfl");
    expect(r.data?.hours).toHaveLength(3);
  });

  it("treats a run older than 36h as unavailable (staleness gate)", async () => {
    const staleSeries = { ...SERIES, run: new Date(Date.now() - 40 * 3_600_000).toISOString() };
    const feed = { generatedAt: new Date().toISOString(), beaches: { "boca-raton": staleSeries } };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(feed));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchRipNwps } = await import("@/lib/sources/ripNwps");
    const r = await fetchRipNwps("boca-raton");
    expect(r.data).toBeNull();
    expect(r.note).toMatch(/stale/i);
  });

  it("a mapped beach missing from the published feed is honestly unavailable, not an error", async () => {
    const feed = { generatedAt: new Date().toISOString(), beaches: {} };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(feed));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchRipNwps } = await import("@/lib/sources/ripNwps");
    const r = await fetchRipNwps("boca-raton");
    expect(r.status).toBe("best-effort");
    expect(r.data).toBeNull();
  });
});

describe("fetchRipNwps — validation (item 7)", () => {
  beforeEach(() => {
    vi.resetModules();
    // The fixture's model run is 2026-09-24T00:00Z; the adapter's 36-h
    // staleness gate reads the real clock, so pin "now" to the fixture's day
    // (this file failed once the calendar moved past that window).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-24T17:30:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("drops individual hours with an out-of-range or sentinel prob, keeps the valid ones", async () => {
    const feed = {
      generatedAt: new Date().toISOString(),
      beaches: {
        "boca-raton": {
          ...SERIES,
          hours: [
            { t: "2026-09-24T18:00:00.000Z", prob: -999 },
            { t: "2026-09-24T19:00:00.000Z", prob: 3.1 },
            { t: "2026-09-24T20:00:00.000Z", prob: 150 },
          ],
        },
      },
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(feed));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchRipNwps } = await import("@/lib/sources/ripNwps");
    const r = await fetchRipNwps("boca-raton");
    expect(r.status).toBe("ok");
    expect(r.data?.hours).toHaveLength(1);
    expect(r.data?.hours[0].prob).toBe(3.1);
  });

  it("rejects the whole entry when `run` doesn't parse", async () => {
    const feed = {
      generatedAt: new Date().toISOString(),
      beaches: { "boca-raton": { ...SERIES, run: "not-a-date" } },
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(feed));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchRipNwps } = await import("@/lib/sources/ripNwps");
    const r = await fetchRipNwps("boca-raton");
    expect(r.data).toBeNull();
  });

  it("rejects the whole entry when `point` is out of geographic range", async () => {
    const feed = {
      generatedAt: new Date().toISOString(),
      beaches: { "boca-raton": { ...SERIES, point: { lon: -80, lat: 999 } } },
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(feed));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchRipNwps } = await import("@/lib/sources/ripNwps");
    const r = await fetchRipNwps("boca-raton");
    expect(r.data).toBeNull();
  });

  it("rejects the whole entry when every hour is invalid, leaving nothing usable", async () => {
    const feed = {
      generatedAt: new Date().toISOString(),
      beaches: { "boca-raton": { ...SERIES, hours: [{ t: "2026-09-24T18:00:00.000Z", prob: -1 }] } },
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(feed));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchRipNwps } = await import("@/lib/sources/ripNwps");
    const r = await fetchRipNwps("boca-raton");
    expect(r.data).toBeNull();
  });
});

describe("fetchRipNwps — in-flight promise dedup / cold-build budget (item: shared fetch)", () => {
  beforeEach(() => {
    vi.resetModules();
    // The fixture's model run is 2026-09-24T00:00Z; the adapter's 36-h
    // staleness gate reads the real clock, so pin "now" to the fixture's day
    // (this file failed once the calendar moved past that window).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-24T17:30:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("a burst of concurrent calls (simulating a cold build fetching many beaches at once) shares ONE fetch", async () => {
    const feed = {
      generatedAt: new Date().toISOString(),
      beaches: { "boca-raton": SERIES, "deerfield-beach": { ...SERIES, office: "mfl" } },
    };
    let resolveResponse: (r: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetchMock = vi.fn().mockReturnValueOnce(pending);
    vi.stubGlobal("fetch", fetchMock);
    const { fetchRipNwps } = await import("@/lib/sources/ripNwps");

    // 5 concurrent callers, as a cold build's Promise.all burst would produce,
    // BEFORE the single in-flight fetch has resolved.
    const calls = Promise.all([
      fetchRipNwps("boca-raton"),
      fetchRipNwps("boca-raton"),
      fetchRipNwps("boca-raton"),
      fetchRipNwps("boca-raton"),
      fetchRipNwps("boca-raton"),
    ]);
    resolveResponse!(jsonResponse(feed));
    const results = await calls;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const r of results) expect(r.status).toBe("ok");
  });
});
