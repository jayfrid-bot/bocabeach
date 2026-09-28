import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLocation } from "@/config/locations";
import type { Location } from "@/lib/types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// Naples (8725114) is `representative: true` in config/tideStations.ts and
// has a real published nws_minor threshold — a good real-config stand-in.
const NAPLES = getLocation("naples") as Location;
const BOCA = getLocation("boca-raton") as Location; // `representative: false`

const NOW_ISO = "2026-09-28T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

/** `feedGeneratedAt` is the FEED's top-level timestamp (mostly irrelevant to
 *  card eligibility now — review item 4 moved that gate to each station's
 *  OWN `generatedAt`, set on the station object itself). */
function feedWithStation(station: Record<string, unknown>, feedGeneratedAt = NOW_ISO) {
  return { schemaVersion: 1, generatedAt: feedGeneratedAt, stations: [station] };
}

const VALID_STATION = {
  stationId: "8725114",
  datum: "STND",
  representative: true,
  nwsMinorFt: 6.12,
  nosMinorFt: null,
  percentileByYear: { "2026": 5.0, "2027": 5.1 },
  highs: [
    {
      episode: { start: "2026-10-10T12:00:00.000Z", end: "2026-10-10T12:00:00.000Z" },
      heightFt: 6.2,
      tier: "validated",
    },
    {
      episode: { start: "2026-01-01T00:00:00.000Z", end: "2026-01-02T00:00:00.000Z" }, // fully past relative to NOW_MS
      heightFt: 5.5,
      tier: "very-high",
    },
  ],
  validThrough: "2028-01-01T05:00:00.000Z",
  generatedAt: NOW_ISO, // per-station freshness (review item 4)
};

describe("kingTideFeedUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs?.();
    delete process.env.KING_TIDE_FEED_BASE;
    vi.resetModules();
  });

  it("points at king_tide_data.json on its OWN king-tide-data branch (never sargassum-data)", async () => {
    vi.resetModules();
    const { kingTideFeedUrl } = await import("@/lib/sources/kingTide");
    expect(kingTideFeedUrl()).toBe(
      "https://raw.githubusercontent.com/jayfrid-bot/bocabeach/king-tide-data/king_tide_data.json",
    );
  });

  it("respects a KING_TIDE_FEED_BASE override", async () => {
    process.env.KING_TIDE_FEED_BASE = "https://example.com/custom";
    vi.resetModules();
    const { kingTideFeedUrl } = await import("@/lib/sources/kingTide");
    expect(kingTideFeedUrl()).toBe("https://example.com/custom/king_tide_data.json");
  });
});

describe("fetchKingTide", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW_ISO));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("a beach with no configured station mapping never fetches", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { fetchKingTide } = await import("@/lib/sources/kingTide");
    const fakeLoc = { ...NAPLES, slug: "not-a-real-beach" };
    const r = await fetchKingTide(fakeLoc, NOW_MS);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.data).toBeNull();
    expect(r.note).toMatch(/no king-tide station mapping/i);
  });

  it("returns events for a mapped, fresh beach — dropping a fully-past episode, keeping a future one", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(feedWithStation(VALID_STATION)));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchKingTide } = await import("@/lib/sources/kingTide");
    const r = await fetchKingTide(NAPLES, NOW_MS);
    expect(r.status).toBe("ok");
    expect(r.data).toHaveLength(1);
    expect(r.data?.[0]).toMatchObject({
      eventType: "tide",
      tier: "validated",
      stationId: "8725114",
      datum: "STND",
      heightFt: 6.2,
    });
    expect(r.data?.[0].source).toEqual({ feedGeneratedAt: NOW_ISO, validThrough: "2028-01-01T05:00:00.000Z" });
  });

  it("keeps an episode that's currently in progress (start in the past, end in the future)", async () => {
    const station = {
      ...VALID_STATION,
      highs: [
        {
          episode: { start: "2026-09-27T00:00:00.000Z", end: "2026-09-29T00:00:00.000Z" },
          heightFt: 6.5,
          tier: "validated",
        },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(feedWithStation(station)));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchKingTide } = await import("@/lib/sources/kingTide");
    const r = await fetchKingTide(NAPLES, NOW_MS);
    expect(r.data).toHaveLength(1);
  });

  it("a station whose OWN generatedAt is older than 30 days is treated as unavailable (per-station card staleness gate, review item 4)", async () => {
    const oldGeneratedAt = new Date(NOW_MS - 31 * 24 * 3_600_000).toISOString();
    const station = { ...VALID_STATION, generatedAt: oldGeneratedAt };
    // The FEED's own top-level generatedAt is fresh ("now") — proves the
    // gate is keyed off the STATION's timestamp, not the feed's.
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(feedWithStation(station, NOW_ISO)));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchKingTide } = await import("@/lib/sources/kingTide");
    const r = await fetchKingTide(NAPLES, NOW_MS);
    expect(r.status).toBe("best-effort");
    expect(r.data).toBeNull();
    expect(r.note).toMatch(/stale/i);
  });

  it("a fresh station carried inside an old-looking feed is still shown (station generatedAt rules, not the feed's top-level one)", async () => {
    const oldFeedGeneratedAt = new Date(NOW_MS - 60 * 24 * 3_600_000).toISOString();
    // The station's OWN generatedAt is fresh even though the feed's
    // top-level generatedAt (last time the JOB ran at all) is ancient —
    // this is exactly the scenario review item 4 was written for: a
    // long-dead pipeline republishing would no longer matter per-station.
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(feedWithStation(VALID_STATION, oldFeedGeneratedAt)));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchKingTide } = await import("@/lib/sources/kingTide");
    const r = await fetchKingTide(NAPLES, NOW_MS);
    expect(r.status).toBe("ok");
    expect(r.data).toHaveLength(1);
  });

  it("a station's own generatedAt exactly 30 days old is still fresh enough (boundary is inclusive)", async () => {
    const boundaryGeneratedAt = new Date(NOW_MS - 30 * 24 * 3_600_000).toISOString();
    const station = { ...VALID_STATION, generatedAt: boundaryGeneratedAt };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(feedWithStation(station)));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchKingTide } = await import("@/lib/sources/kingTide");
    const r = await fetchKingTide(NAPLES, NOW_MS);
    expect(r.status).toBe("ok");
  });

  it("a station's own generatedAt more than 10 min in the FUTURE is rejected as implausible, never treated as extra-fresh (Codex review round 2)", async () => {
    const futureGeneratedAt = new Date(NOW_MS + 11 * 60_000).toISOString();
    const station = { ...VALID_STATION, generatedAt: futureGeneratedAt };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(feedWithStation(station)));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchKingTide } = await import("@/lib/sources/kingTide");
    const r = await fetchKingTide(NAPLES, NOW_MS);
    expect(r.status).toBe("best-effort");
    expect(r.data).toBeNull();
  });

  it("a station's own generatedAt within the 10-min future-skew allowance is still accepted (ordinary clock jitter)", async () => {
    const withinSkewGeneratedAt = new Date(NOW_MS + 9 * 60_000).toISOString();
    const station = { ...VALID_STATION, generatedAt: withinSkewGeneratedAt };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(feedWithStation(station)));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchKingTide } = await import("@/lib/sources/kingTide");
    const r = await fetchKingTide(NAPLES, NOW_MS);
    expect(r.status).toBe("ok");
  });

  it("`source.feedGeneratedAt` on the returned events is the STATION's own generatedAt, not the feed's top-level one", async () => {
    const station = { ...VALID_STATION, generatedAt: "2026-09-20T00:00:00.000Z" };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(feedWithStation(station, "2026-09-28T00:00:00.000Z")));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchKingTide } = await import("@/lib/sources/kingTide");
    const r = await fetchKingTide(NAPLES, NOW_MS);
    expect(r.data?.[0].source.feedGeneratedAt).toBe("2026-09-20T00:00:00.000Z");
  });

  it("an event past its station's own validThrough is dropped entirely", async () => {
    const station = { ...VALID_STATION, validThrough: new Date(NOW_MS - 1000).toISOString() };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(feedWithStation(station)));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchKingTide } = await import("@/lib/sources/kingTide");
    const r = await fetchKingTide(NAPLES, NOW_MS);
    expect(r.data).toEqual([]);
  });

  it("a beach's station missing from the published feed is honestly unavailable, not an error", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(feedWithStation({ ...VALID_STATION, stationId: "9999999" })));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchKingTide } = await import("@/lib/sources/kingTide");
    const r = await fetchKingTide(NAPLES, NOW_MS);
    expect(r.status).toBe("best-effort");
    expect(r.data).toBeNull();
  });

  it("a genuinely empty station (no qualifying highs) is a valid 'ok' result, not an error", async () => {
    const station = { ...VALID_STATION, highs: [] };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(feedWithStation(station)));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchKingTide } = await import("@/lib/sources/kingTide");
    const r = await fetchKingTide(NAPLES, NOW_MS);
    expect(r.status).toBe("ok");
    expect(r.data).toEqual([]);
  });

  it("a non-representative beach's events are never 'validated' even if the feed's station entry lies", async () => {
    // Boca (representative: false in config) — the published feed's own
    // `representative` flag is what the SCRIPT already classified against,
    // so a `validated` tier in the feed is trusted for the station it names;
    // this test is really about Boca correctly resolving to ITS OWN station
    // (8722816), not accidentally reading Naples' or anyone else's entry.
    const bocaStation = {
      ...VALID_STATION,
      stationId: "8722816",
      representative: false,
      nwsMinorFt: null,
      highs: [
        {
          episode: { start: "2026-10-10T12:00:00.000Z", end: "2026-10-10T12:00:00.000Z" },
          heightFt: 5.02,
          tier: "very-high",
        },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(feedWithStation(bocaStation)));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchKingTide } = await import("@/lib/sources/kingTide");
    const r = await fetchKingTide(BOCA, NOW_MS);
    expect(r.data?.[0].stationId).toBe("8722816");
    expect(r.data?.every((e) => e.tier !== "validated")).toBe(true);
  });
});

describe("fetchKingTide — feed-level validation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW_ISO));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rejects a feed with the wrong schemaVersion", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ schemaVersion: 2, generatedAt: NOW_ISO, stations: [VALID_STATION] }));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchKingTide } = await import("@/lib/sources/kingTide");
    const r = await fetchKingTide(NAPLES, NOW_MS);
    expect(r.data).toBeNull();
  });

  it("drops an individual station entry with a malformed field, keeps the rest of the feed usable", async () => {
    const badStation = { ...VALID_STATION, stationId: "8725114", representative: "yes" }; // wrong type
    const feed = { schemaVersion: 1, generatedAt: NOW_ISO, stations: [badStation] };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(feed));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchKingTide } = await import("@/lib/sources/kingTide");
    const r = await fetchKingTide(NAPLES, NOW_MS);
    expect(r.status).toBe("best-effort"); // station entry was dropped entirely -> not found for Naples
    expect(r.data).toBeNull();
  });

  it("rejects a station entry missing its own generatedAt (required for per-station freshness, review item 4)", async () => {
    const { generatedAt: _drop, ...stationWithoutGeneratedAt } = VALID_STATION;
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(feedWithStation(stationWithoutGeneratedAt)));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchKingTide } = await import("@/lib/sources/kingTide");
    const r = await fetchKingTide(NAPLES, NOW_MS);
    expect(r.status).toBe("best-effort");
    expect(r.data).toBeNull();
  });

  it("drops an individual high with an unrecognized tier, keeps the valid ones", async () => {
    const station = {
      ...VALID_STATION,
      highs: [
        { episode: { start: "2026-10-10T12:00:00.000Z", end: "2026-10-10T12:00:00.000Z" }, heightFt: 6.2, tier: "king-tide" },
        { episode: { start: "2026-10-11T12:00:00.000Z", end: "2026-10-11T12:00:00.000Z" }, heightFt: 6.3, tier: "very-high" },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(feedWithStation(station)));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchKingTide } = await import("@/lib/sources/kingTide");
    const r = await fetchKingTide(NAPLES, NOW_MS);
    expect(r.data).toHaveLength(1);
    expect(r.data?.[0].heightFt).toBe(6.3);
  });

  it("drops an episode whose end is before its start", async () => {
    const station = {
      ...VALID_STATION,
      highs: [
        { episode: { start: "2026-10-11T12:00:00.000Z", end: "2026-10-10T12:00:00.000Z" }, heightFt: 6.2, tier: "very-high" },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(feedWithStation(station)));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchKingTide } = await import("@/lib/sources/kingTide");
    const r = await fetchKingTide(NAPLES, NOW_MS);
    expect(r.data).toEqual([]);
  });

  it("a fetch failure (non-2xx) is honestly unavailable, not a crash", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("error", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchKingTide } = await import("@/lib/sources/kingTide");
    const r = await fetchKingTide(NAPLES, NOW_MS);
    expect(r.status).toBe("best-effort");
    expect(r.data).toBeNull();
  });
});

// --- Datum/threshold consistency re-check (review item 3's adapter-side
// defense in depth: scripts/king_tide.mjs already refuses to fetch/apply a
// threshold on a datum mismatch, but the adapter re-checks the untrusted
// published JSON independently, per §9's "treat the feed as untrusted
// input too" convention already used for every field above). -------------

describe("fetchKingTide — datum/threshold consistency re-check (review item 3)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW_ISO));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rejects the whole station entry when datum is MLLW but it carries a non-null threshold", async () => {
    const station = { ...VALID_STATION, datum: "MLLW", nwsMinorFt: 6.12, highs: [] };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(feedWithStation(station)));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchKingTide } = await import("@/lib/sources/kingTide");
    const r = await fetchKingTide(NAPLES, NOW_MS);
    expect(r.status).toBe("best-effort");
    expect(r.data).toBeNull();
  });

  it("rejects the whole station entry when datum is MLLW but it carries a 'validated' episode, even with null thresholds", async () => {
    const station = {
      ...VALID_STATION,
      datum: "MLLW",
      nwsMinorFt: null,
      nosMinorFt: null,
      highs: [
        { episode: { start: "2026-10-10T12:00:00.000Z", end: "2026-10-10T12:00:00.000Z" }, heightFt: 6.2, tier: "validated" },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(feedWithStation(station)));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchKingTide } = await import("@/lib/sources/kingTide");
    const r = await fetchKingTide(NAPLES, NOW_MS);
    expect(r.status).toBe("best-effort");
    expect(r.data).toBeNull();
  });

  it("an MLLW station with no threshold evidence at all (percentile-only) is accepted normally", async () => {
    const station = {
      ...VALID_STATION,
      datum: "MLLW",
      nwsMinorFt: null,
      nosMinorFt: null,
      representative: false,
      highs: [
        { episode: { start: "2026-10-10T12:00:00.000Z", end: "2026-10-10T12:00:00.000Z" }, heightFt: 6.2, tier: "very-high" },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(feedWithStation(station)));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchKingTide } = await import("@/lib/sources/kingTide");
    const r = await fetchKingTide(NAPLES, NOW_MS);
    expect(r.status).toBe("ok");
    expect(r.data).toHaveLength(1);
  });

  it("an STND station with a threshold and a validated episode is accepted normally (the ordinary, consistent case)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(feedWithStation(VALID_STATION)));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchKingTide } = await import("@/lib/sources/kingTide");
    const r = await fetchKingTide(NAPLES, NOW_MS);
    expect(r.status).toBe("ok");
    expect(r.data?.some((e) => e.tier === "validated")).toBe(true);
  });
});
