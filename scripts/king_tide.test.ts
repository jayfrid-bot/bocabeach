import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildStationEntry,
  buildStationRoster,
  canUseThresholdForRun,
  classifyHigh,
  fetchFloodThreshold,
  fetchStationPredictions,
  loadBeachTimezones,
  localYearAt,
  main,
  mergeEpisodes,
  parseFloodLevelFt,
  parseTideStationsTs,
  percentileThresholdFt,
  sanitizePredictions,
  stationLocalYearBounds,
  zonedTimeToUtcMs,
} from "@/scripts/king_tide.mjs";
import { LOCATIONS } from "@/config/locations";
import { TIDE_STATIONS } from "@/config/tideStations";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const ROOT = path.resolve(__dirname, "..");

// --- Timezone-aware year boundaries ----------------------------------------

describe("zonedTimeToUtcMs", () => {
  it("converts a winter (standard-time) local wall clock to the right UTC instant", () => {
    // Jan 1 2026 00:00 EST = Jan 1 2026 05:00 UTC (no DST in January).
    const ms = zonedTimeToUtcMs(2026, 1, 1, 0, 0, 0, "America/New_York");
    expect(new Date(ms).toISOString()).toBe("2026-01-01T05:00:00.000Z");
  });

  it("converts a summer (daylight-time) local wall clock correctly (DST offset, not standard)", () => {
    // Jul 4 2026 12:00 EDT = Jul 4 2026 16:00 UTC (DST, UTC-4 not UTC-5).
    const ms = zonedTimeToUtcMs(2026, 7, 4, 12, 0, 0, "America/New_York");
    expect(new Date(ms).toISOString()).toBe("2026-07-04T16:00:00.000Z");
  });

  it("handles a west-of-UTC, non-DST zone (Hawaii)", () => {
    const ms = zonedTimeToUtcMs(2026, 1, 1, 0, 0, 0, "Pacific/Honolulu");
    expect(new Date(ms).toISOString()).toBe("2026-01-01T10:00:00.000Z");
  });
});

describe("localYearAt", () => {
  it("reads the correct calendar year even when UTC has already rolled over (late December)", () => {
    // 2026-12-31 23:30 PST is still 2026-12-31 local, but already 2027-01-01 07:30 UTC.
    const nowMs = Date.parse("2027-01-01T07:30:00Z");
    expect(localYearAt(nowMs, "America/Los_Angeles")).toBe(2026);
  });

  it("reads the correct calendar year when local has already rolled over ahead of UTC", () => {
    // Honolulu is behind UTC, so this case is the mirror: still same day for both here,
    // but a zone AHEAD of UTC (e.g. Pacific/Auckland) would roll over first. Use New York
    // for a same-day sanity check plus an explicit ahead-of-UTC zone below.
    const nowMs = Date.parse("2026-12-31T23:00:00Z"); // 2026-12-31 18:00 EST
    expect(localYearAt(nowMs, "America/New_York")).toBe(2026);
  });
});

describe("stationLocalYearBounds (year rollover, §3's current+next-year rule)", () => {
  it("covers [Jan1 currentYear, Jan1 nextYear+1) exactly, in the station's own local time", () => {
    const nowMs = Date.parse("2026-12-28T12:00:00Z"); // late December — the exact edge case §3 calls out
    const bounds = stationLocalYearBounds(nowMs, "America/New_York");
    expect(bounds.currentYear).toBe(2026);
    expect(bounds.nextYear).toBe(2027);
    expect(new Date(bounds.startMs).toISOString()).toBe("2026-01-01T05:00:00.000Z");
    expect(new Date(bounds.midMs).toISOString()).toBe("2027-01-01T05:00:00.000Z");
    expect(new Date(bounds.endMs).toISOString()).toBe("2028-01-01T05:00:00.000Z");
  });

  it("a January event still falls inside the window computed in the prior December (no year-boundary gap)", () => {
    const decNowMs = Date.parse("2026-12-30T12:00:00Z");
    const bounds = stationLocalYearBounds(decNowMs, "America/New_York");
    const nextJan15Ms = zonedTimeToUtcMs(2027, 1, 15, 12, 0, 0, "America/New_York");
    expect(nextJan15Ms).toBeGreaterThanOrEqual(bounds.startMs);
    expect(nextJan15Ms).toBeLessThan(bounds.endMs);
  });
});

// --- Percentile / classification / merge ------------------------------------

describe("percentileThresholdFt", () => {
  it("the top 1% of 100 highs is just the single highest value", () => {
    const heights = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect(percentileThresholdFt(heights, 0.01)).toBe(100);
  });

  it("a small year (a handful of highs) still yields a well-defined threshold (at least 1 qualifies)", () => {
    expect(percentileThresholdFt([1, 2, 3, 4], 0.01)).toBe(4);
  });

  it("null for an empty year", () => {
    expect(percentileThresholdFt([], 0.01)).toBeNull();
  });
});

describe("classifyHigh", () => {
  it("validated beats very-high when both would qualify", () => {
    const tier = classifyHigh(10, { thresholdFt: 9, percentileFt: 5, representative: true });
    expect(tier).toBe("validated");
  });

  it("very-high tier only when below threshold but at/above the percentile", () => {
    const tier = classifyHigh(6, { thresholdFt: 9, percentileFt: 5, representative: true });
    expect(tier).toBe("very-high");
  });

  it("never validated when representative is false, even above the threshold value", () => {
    const tier = classifyHigh(10, { thresholdFt: 9, percentileFt: 5, representative: false });
    expect(tier).toBe("very-high");
  });

  it("never validated when the threshold is absent (non-representative station has none)", () => {
    const tier = classifyHigh(10, { thresholdFt: null, percentileFt: 5, representative: true });
    expect(tier).toBe("very-high");
  });

  it("null (doesn't qualify) when below both the threshold and the percentile", () => {
    expect(classifyHigh(1, { thresholdFt: 9, percentileFt: 5, representative: true })).toBeNull();
  });
});

describe("mergeEpisodes", () => {
  const H = (iso: string, heightFt: number, tier: "validated" | "very-high") => ({
    tMs: Date.parse(iso),
    heightFt,
    tier,
  });

  it("merges consecutive highs <=30h apart into one episode", () => {
    const episodes = mergeEpisodes([
      H("2026-10-01T12:00:00Z", 5, "very-high"),
      H("2026-10-02T13:00:00Z", 5.2, "very-high"), // 25h later
    ]);
    expect(episodes).toHaveLength(1);
    expect(episodes[0].episode).toEqual({ start: "2026-10-01T12:00:00.000Z", end: "2026-10-02T13:00:00.000Z" });
    expect(episodes[0].heightFt).toBe(5.2); // tallest of the merged highs
  });

  it("starts a new episode once the gap exceeds 30h", () => {
    const episodes = mergeEpisodes([
      H("2026-10-01T12:00:00Z", 5, "very-high"),
      H("2026-10-02T19:00:00Z", 5.2, "very-high"), // 31h later
    ]);
    expect(episodes).toHaveLength(2);
  });

  it("splits a long run once the running span from the episode's first high would exceed 72h", () => {
    // Three highs, each <=30h from the last, but the 1st->3rd span is 80h > 72h cap.
    const episodes = mergeEpisodes([
      H("2026-10-01T00:00:00Z", 5, "very-high"),
      H("2026-10-02T06:00:00Z", 5.1, "very-high"), // +30h
      H("2026-10-04T08:00:00Z", 5.3, "very-high"), // +26h from prev, but +80h from the 1st
    ]);
    expect(episodes).toHaveLength(2);
    expect(episodes[0].episode.start).toBe("2026-10-01T00:00:00.000Z");
    expect(episodes[0].episode.end).toBe("2026-10-02T06:00:00.000Z");
    expect(episodes[1].episode.start).toBe("2026-10-04T08:00:00.000Z");
  });

  it("an episode is 'validated' if ANY merged high crossed the threshold, never downgraded by a lower-tier neighbor", () => {
    const episodes = mergeEpisodes([
      H("2026-10-01T12:00:00Z", 5, "very-high"),
      H("2026-10-02T13:00:00Z", 9.5, "validated"),
    ]);
    expect(episodes).toHaveLength(1);
    expect(episodes[0].tier).toBe("validated");
  });

  it("empty input yields no episodes", () => {
    expect(mergeEpisodes([])).toEqual([]);
  });
});

// --- Sanitization ------------------------------------------------------

describe("sanitizePredictions", () => {
  const startMs = Date.parse("2026-01-01T00:00:00Z");
  const endMs = Date.parse("2027-01-01T00:00:00Z");

  it("parses well-formed hi/lo rows and filters to the exact window", () => {
    const raw = [
      { t: "2026-06-01 12:00", v: "5.25", type: "H" },
      { t: "2025-12-31 23:00", v: "9.9", type: "H" }, // before the window
      { t: "2027-01-01 00:00", v: "9.9", type: "H" }, // at/after the exclusive end
    ];
    const rows = sanitizePredictions(raw, startMs, endMs);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ tMs: Date.parse("2026-06-01T12:00:00Z"), heightFt: 5.25, type: "H" });
  });

  it("drops rows with a malformed timestamp, height, or type", () => {
    const raw = [
      { t: "not-a-date", v: "5.25", type: "H" },
      { t: "2026-06-01 12:00", v: "not-a-number", type: "H" },
      { t: "2026-06-01 12:00", v: "5.25", type: "X" },
      { t: "2026-06-01 12:00", v: "5.25", type: "H" },
    ];
    expect(sanitizePredictions(raw, startMs, endMs)).toHaveLength(1);
  });

  it("handles a missing/empty predictions array", () => {
    expect(sanitizePredictions(undefined, startMs, endMs)).toEqual([]);
  });
});

// --- buildStationEntry (integration of classify + percentile + merge) ------

describe("buildStationEntry", () => {
  const bounds = stationLocalYearBounds(Date.parse("2026-06-01T00:00:00Z"), "America/New_York");
  const GENERATED_AT = "2026-06-01T00:00:00.000Z";

  it("thresholds absent (non-representative) -> no flood tier ever, only very-high", () => {
    const sanitizedHighs = [
      { tMs: Date.parse("2026-07-01T12:00:00Z"), heightFt: 100 }, // absurdly high, would cross any real threshold
    ];
    const entry = buildStationEntry("TEST1", {
      datum: "STND",
      sanitizedHighs,
      bounds,
      representative: false,
      threshold: null,
      generatedAt: GENERATED_AT,
    });
    expect(entry.highs.every((h) => h.tier === "very-high")).toBe(true);
    expect(entry.nwsMinorFt).toBeNull();
    expect(entry.nosMinorFt).toBeNull();
  });

  it("thresholds present but representative:false -> still no flood tier (representative gates it, not just the number)", () => {
    const sanitizedHighs = [{ tMs: Date.parse("2026-07-01T12:00:00Z"), heightFt: 10 }];
    const entry = buildStationEntry("TEST2", {
      datum: "STND",
      sanitizedHighs,
      bounds,
      representative: false,
      threshold: { nwsMinorFt: 5, nosMinorFt: null },
      generatedAt: GENERATED_AT,
    });
    expect(entry.highs.every((h) => h.tier === "very-high")).toBe(true);
  });

  it("representative:true with a crossed threshold produces a validated episode", () => {
    const sanitizedHighs = [
      { tMs: Date.parse("2026-07-01T12:00:00Z"), heightFt: 3 },
      { tMs: Date.parse("2026-07-02T12:00:00Z"), heightFt: 10 }, // crosses nwsMinorFt: 5
    ];
    const entry = buildStationEntry("TEST3", {
      datum: "STND",
      sanitizedHighs,
      bounds,
      representative: true,
      threshold: { nwsMinorFt: 5, nosMinorFt: null },
      generatedAt: GENERATED_AT,
    });
    expect(entry.highs.some((h) => h.tier === "validated")).toBe(true);
    expect(entry.nwsMinorFt).toBe(5);
  });

  it("falls back to nos_minor when nws_minor is null", () => {
    const sanitizedHighs = [{ tMs: Date.parse("2026-07-01T12:00:00Z"), heightFt: 8 }];
    const entry = buildStationEntry("TEST4", {
      datum: "STND",
      sanitizedHighs,
      bounds,
      representative: true,
      threshold: { nwsMinorFt: null, nosMinorFt: 7 },
      generatedAt: GENERATED_AT,
    });
    expect(entry.highs.some((h) => h.tier === "validated")).toBe(true);
  });

  it("splits percentile computation by station-local year (a high near the year boundary uses its OWN year's percentile)", () => {
    const sanitizedHighs = [
      // current year: many modest highs, one clearly the tallest
      ...Array.from({ length: 20 }, (_, i) => ({
        tMs: Date.parse(`2026-0${(i % 6) + 1}-15T12:00:00Z`),
        heightFt: 4 + i * 0.01,
      })),
      // next year: one modest high — should be judged against NEXT year's own (tiny) distribution,
      // not the current year's, so it still qualifies as that year's own top 1%.
      { tMs: bounds.midMs + 3_600_000, heightFt: 4.0 },
    ];
    const entry = buildStationEntry("TEST5", {
      datum: "STND",
      sanitizedHighs,
      bounds,
      representative: false,
      threshold: null,
      generatedAt: GENERATED_AT,
    });
    expect(Object.keys(entry.percentileByYear)).toEqual(
      expect.arrayContaining([String(bounds.currentYear), String(bounds.nextYear)]),
    );
    // the lone next-year high is that year's only sample, so it IS that year's top 1%.
    const nextYearHigh = entry.highs.find((h) => h.episode.start > new Date(bounds.midMs).toISOString());
    expect(nextYearHigh?.tier).toBe("very-high");
  });

  it("validThrough is the exact end of the fetched 2-year coverage window", () => {
    const entry = buildStationEntry("TEST6", {
      datum: "STND",
      sanitizedHighs: [],
      bounds,
      representative: false,
      threshold: null,
      generatedAt: GENERATED_AT,
    });
    expect(entry.validThrough).toBe(new Date(bounds.endMs).toISOString());
    expect(entry.highs).toEqual([]); // a genuinely empty, honest result — not an error
  });

  it("carries the passed-in generatedAt through verbatim (the per-station freshness timestamp, review item 4)", () => {
    const entry = buildStationEntry("TEST7", {
      datum: "STND",
      sanitizedHighs: [],
      bounds,
      representative: false,
      threshold: null,
      generatedAt: GENERATED_AT,
    });
    expect(entry.generatedAt).toBe(GENERATED_AT);
  });
});

// --- Datum-matching enforcement (review item 3) -----------------------------

describe("canUseThresholdForRun", () => {
  it("true only when representative, a thresholdDatum is configured, AND this run's datum matches it", () => {
    expect(
      canUseThresholdForRun({ representative: true, thresholdDatum: "STND", predictionDatum: "STND" }),
    ).toBe(true);
  });

  it("false when representative but thresholdDatum is null (no verified threshold datum to compare)", () => {
    expect(
      canUseThresholdForRun({ representative: true, thresholdDatum: null, predictionDatum: "STND" }),
    ).toBe(false);
  });

  it("false when representative and thresholdDatum is STND, but THIS RUN fell back to MLLW (transient STND failure)", () => {
    expect(
      canUseThresholdForRun({ representative: true, thresholdDatum: "STND", predictionDatum: "MLLW" }),
    ).toBe(false);
  });

  it("false when not representative at all, regardless of datum", () => {
    expect(
      canUseThresholdForRun({ representative: false, thresholdDatum: "STND", predictionDatum: "STND" }),
    ).toBe(false);
  });
});

// --- Config loaders (against the REAL project config, so a future edit that
// breaks the dependency-free parse is caught here, not silently in prod) ----

describe("parseTideStationsTs / loadBeachTimezones (against real config)", () => {
  it("parses every one of config/tideStations.ts's 39 entries", () => {
    const parsed = parseTideStationsTs(path.join(ROOT, "config/tideStations.ts"));
    expect(Object.keys(parsed)).toHaveLength(Object.keys(TIDE_STATIONS).length);
    expect(parsed).toEqual(TIDE_STATIONS);
  });

  it("finds a timezone for every beach the real TIDE_STATIONS config names", () => {
    const tzMap = loadBeachTimezones(ROOT) as Record<string, string>;
    for (const slug of Object.keys(TIDE_STATIONS)) {
      expect(tzMap[slug], `missing timezone for ${slug}`).toBeTruthy();
    }
  });

  it("the 3 hand-curated beaches all resolve via the locations.ts scrape (not just the generated JSON)", () => {
    const tzMap = loadBeachTimezones(ROOT) as Record<string, string>;
    for (const loc of LOCATIONS) {
      expect(tzMap[loc.slug]).toBe(loc.timezone);
    }
  });
});

describe("buildStationRoster", () => {
  it("dedupes beaches that share one station into a single roster entry", () => {
    const roster = buildStationRoster(
      {
        a: { stationId: "S1", representative: true, thresholdDatum: "STND" },
        b: { stationId: "S1", representative: true, thresholdDatum: "STND" },
      },
      { a: "America/New_York", b: "America/New_York" },
    );
    expect(roster.size).toBe(1);
    expect(roster.get("S1")?.beaches).toEqual(["a", "b"]);
    expect(roster.get("S1")?.thresholdDatum).toBe("STND");
  });

  it("carries thresholdDatum through for a non-representative station (null)", () => {
    const roster = buildStationRoster(
      { a: { stationId: "S1", representative: false, thresholdDatum: null } },
      { a: "America/New_York" },
    );
    expect(roster.get("S1")?.thresholdDatum).toBeNull();
  });

  it("resolves a representative disagreement to the conservative false, and logs it", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const roster = buildStationRoster(
      {
        a: { stationId: "S1", representative: true },
        b: { stationId: "S1", representative: false },
      },
      { a: "America/New_York", b: "America/New_York" },
    );
    expect(roster.get("S1")?.representative).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("skips a beach with no known timezone rather than crashing", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const roster = buildStationRoster({ a: { stationId: "S1", representative: false } }, {});
    expect(roster.size).toBe(0);
    errorSpy.mockRestore();
  });
});

// --- Network layer (mocked fetch, no live calls in the test suite) --------

describe("fetchStationPredictions", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses STND when the station supports it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ predictions: [{ t: "2026-06-01 12:00", v: "5.0", type: "H" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchStationPredictions("8722670", Date.parse("2026-01-01T00:00:00Z"), Date.parse("2027-01-01T00:00:00Z"));
    expect(result?.datum).toBe("STND");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("datum=STND");
  });

  it("falls back to MLLW when STND errors (a type-S subordinate station, e.g. TEC3399/TEC4455)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: "No Predictions data was found." } }))
      .mockResolvedValueOnce(jsonResponse({ error: { message: "No Predictions data was found." } })) // 1 retry on STND
      .mockResolvedValueOnce(jsonResponse({ predictions: [{ t: "2026-06-01 12:00", v: "7.7", type: "H" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchStationPredictions("TEC3399", Date.parse("2026-01-01T00:00:00Z"), Date.parse("2027-01-01T00:00:00Z"));
    expect(result?.datum).toBe("MLLW");
    expect(String(fetchMock.mock.calls[2][0])).toContain("datum=MLLW");
  });

  it("returns null when both datums fail entirely (station total failure -> caller carries forward)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: { message: "nope" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchStationPredictions("BAD", Date.parse("2026-01-01T00:00:00Z"), Date.parse("2027-01-01T00:00:00Z"));
    expect(result).toBeNull();
  });
});

describe("fetchFloodThreshold", () => {
  afterEach(() => vi.restoreAllMocks());

  it("parses nws_minor/nos_minor from a real-shaped payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ nws_minor: 13.66, nos_minor: 14.07 })),
    );
    const t = await fetchFloodThreshold("8723214");
    expect(t).toEqual({ nwsMinorFt: 13.66, nosMinorFt: 14.07 });
  });

  it("a confirmed 404 means 'no threshold', not a failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not found", { status: 404 })));
    const t = await fetchFloodThreshold("8722816");
    expect(t).toEqual({ nwsMinorFt: null, nosMinorFt: null });
  });

  it("a network error is a transient failure (null), distinct from a confirmed 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );
    const t = await fetchFloodThreshold("8723214");
    expect(t).toBeNull();
  });

  it("REAL fetch-shaped payload (seaside/9413450): nws_minor JSON null, nos_minor a real number — nws_minor stays null, never becomes 0 (Codex review round 2)", async () => {
    // This is the actual live shape (§3: "nws_minor (fallback nos_minor if
    // NWS is null)") — a naive `Number(json.nws_minor)` turns JSON `null`
    // into `0`, which `Number.isFinite` happily accepts, silently making
    // EVERY predicted high read as crossing a "0 ft" threshold. Exercising
    // this through the real fetch/parse path (not a pre-built object
    // literal) is what actually catches that regression.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          nos_minor: 10.57,
          nos_moderate: 11.5,
          nos_major: 12.77,
          nws_minor: null,
          nws_moderate: null,
          nws_major: null,
          action: null,
        }),
      ),
    );
    const t = await fetchFloodThreshold("9413450");
    expect(t).toEqual({ nwsMinorFt: null, nosMinorFt: 10.57 });
    expect(t?.nwsMinorFt).not.toBe(0); // the exact regression this test guards against
  });

  it("REAL fetch-shaped payload with BOTH minors null (e.g. action-stage-only station) — both stay null, not 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ nws_minor: null, nos_minor: null, action: 13.12 })),
    );
    const t = await fetchFloodThreshold("8725114");
    expect(t).toEqual({ nwsMinorFt: null, nosMinorFt: null });
  });

  it("a blank-string minor value is also treated as null, never coerced to 0", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ nws_minor: "", nos_minor: "8.39" })));
    const t = await fetchFloodThreshold("TEST");
    expect(t).toEqual({ nwsMinorFt: null, nosMinorFt: 8.39 });
  });
});

describe("parseFloodLevelFt", () => {
  it("null, undefined, and a blank string all parse as null", () => {
    expect(parseFloodLevelFt(null)).toBeNull();
    expect(parseFloodLevelFt(undefined)).toBeNull();
    expect(parseFloodLevelFt("")).toBeNull();
    expect(parseFloodLevelFt("   ")).toBeNull();
  });

  it("never coerces null to the numeric value 0", () => {
    expect(parseFloodLevelFt(null)).not.toBe(0);
  });

  it("parses a real number or numeric string", () => {
    expect(parseFloodLevelFt(6.12)).toBe(6.12);
    expect(parseFloodLevelFt("6.12")).toBe(6.12);
  });

  it("a genuine 0 is preserved as 0, not confused with 'missing'", () => {
    expect(parseFloodLevelFt(0)).toBe(0);
  });

  it("a non-numeric string is null, not NaN", () => {
    expect(parseFloodLevelFt("not-a-number")).toBeNull();
  });

  // Codex review round 3: a blind `Number(raw)` also silently coerces
  // booleans, arrays, and objects (`Number(false) === 0`,
  // `Number([]) === 0`, etc.) — only a genuine number or strictly-numeric
  // string may ever become a threshold; everything else is null by TYPE,
  // never handed to `Number()` at all.
  it("rejects booleans outright (never Number(false)===0 / Number(true)===1)", () => {
    expect(parseFloodLevelFt(false)).toBeNull();
    expect(parseFloodLevelFt(true)).toBeNull();
  });

  it("rejects an empty array outright (never Number([])===0)", () => {
    expect(parseFloodLevelFt([])).toBeNull();
  });

  it("rejects a plain object outright", () => {
    expect(parseFloodLevelFt({})).toBeNull();
  });

  it("rejects a non-numeric string ('abc')", () => {
    expect(parseFloodLevelFt("abc")).toBeNull();
  });

  it("rejects a whitespace-only string ('  ')", () => {
    expect(parseFloodLevelFt("  ")).toBeNull();
  });

  it("accepts a numeric string ('8.39')", () => {
    expect(parseFloodLevelFt("8.39")).toBe(8.39);
  });

  it("accepts a real number (8.39)", () => {
    expect(parseFloodLevelFt(8.39)).toBe(8.39);
  });
});

// --- main() integration: datum enforcement, per-station carry-forward,
// all-stations-failed abort (review items 3 & 4) — mocked fetch, no live
// network, but exercises the REAL main()/fs pipeline end to end. -----------

describe("main() — datum enforcement, carry-forward generatedAt, all-fail abort", () => {
  let tmpDir: string;
  let originalArgv: string[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "king-tide-test-"));
    originalArgv = process.argv;
  });
  afterEach(() => {
    process.argv = originalArgv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function writeJson(name: string, data: unknown): string {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, JSON.stringify(data));
    return p;
  }

  function runMain(argsObj: Record<string, string>) {
    const args = ["node", "king_tide.mjs"];
    for (const [k, v] of Object.entries(argsObj)) args.push(`--${k}`, v);
    process.argv = args;
    return main();
  }

  it("a representative station whose STND predictions fail this run (MLLW fallback) publishes as NOT usable — never fetches floodlevels, never validated", async () => {
    const mapPath = writeJson("map.json", {
      "test-beach": { stationId: "REP1", representative: true, thresholdDatum: "STND" },
    });
    const tzPath = writeJson("tz.json", { "test-beach": "America/New_York" });
    const outPath = path.join(tmpDir, "out.json");

    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("floodlevels")) throw new Error("floodlevels must never be fetched this run — datum mismatch");
      if (u.includes("datum=STND")) return jsonResponse({ error: { message: "No Predictions data was found." } });
      if (u.includes("datum=MLLW")) {
        return jsonResponse({ predictions: [{ t: "2026-06-15 12:00", v: "9.9", type: "H" }] });
      }
      throw new Error(`unexpected url ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await runMain({ out: outPath, map: mapPath, tzmap: tzPath, now: "2026-06-01T00:00:00Z" });

    const out = JSON.parse(fs.readFileSync(outPath, "utf8"));
    expect(out.stations).toHaveLength(1);
    const station = out.stations[0];
    expect(station.datum).toBe("MLLW");
    expect(station.representative).toBe(false); // this run's datum != thresholdDatum -> not usable
    expect(station.nwsMinorFt).toBeNull();
    expect(station.nosMinorFt).toBeNull();
    expect(fetchMock.mock.calls.some(([u]: [string]) => String(u).includes("floodlevels"))).toBe(false);
  });

  it("a mixed run (one station fetches fresh, another fails) carries forward the failed one's ORIGINAL generatedAt per station, while the run overall succeeds", async () => {
    const mapPath = writeJson("map.json", {
      "ok-beach": { stationId: "OK1", representative: false, thresholdDatum: null },
      "fail-beach": { stationId: "FAIL1", representative: false, thresholdDatum: null },
    });
    const tzPath = writeJson("tz.json", { "ok-beach": "America/New_York", "fail-beach": "America/New_York" });
    const outPath = path.join(tmpDir, "out.json");
    const OLD_GENERATED_AT = "2026-01-01T00:00:00.000Z";
    const prevPath = writeJson("prev.json", {
      schemaVersion: 1,
      generatedAt: OLD_GENERATED_AT,
      stations: [
        {
          stationId: "FAIL1",
          datum: "STND",
          representative: false,
          nwsMinorFt: null,
          nosMinorFt: null,
          percentileByYear: {},
          highs: [],
          validThrough: "2028-01-01T00:00:00.000Z",
          generatedAt: OLD_GENERATED_AT,
        },
      ],
    });

    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("station=OK1")) {
        return jsonResponse({ predictions: [{ t: "2026-06-15 12:00", v: "5.0", type: "H" }] });
      }
      return jsonResponse({ error: { message: "down" } }); // FAIL1 always fails, every datum
    });
    vi.stubGlobal("fetch", fetchMock);

    await runMain({ out: outPath, map: mapPath, tzmap: tzPath, prev: prevPath, now: "2026-06-01T00:00:00Z" });

    const out = JSON.parse(fs.readFileSync(outPath, "utf8"));
    expect(out.stations).toHaveLength(2);
    const ok1 = out.stations.find((s: { stationId: string }) => s.stationId === "OK1");
    const fail1 = out.stations.find((s: { stationId: string }) => s.stationId === "FAIL1");
    expect(fail1.generatedAt).toBe(OLD_GENERATED_AT); // carried forward, never bumped
    expect(ok1.generatedAt).not.toBe(OLD_GENERATED_AT); // freshly fetched this run
    expect(out.generatedAt).not.toBe(OLD_GENERATED_AT); // the JOB still ran today
  });

  it("every station failing with no previous data to carry forward throws and writes nothing", async () => {
    const mapPath = writeJson("map.json", {
      "test-beach": { stationId: "FAIL2", representative: false, thresholdDatum: null },
    });
    const tzPath = writeJson("tz.json", { "test-beach": "America/New_York" });
    const outPath = path.join(tmpDir, "out.json");

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: { message: "down" } })));

    await expect(
      runMain({ out: outPath, map: mapPath, tzmap: tzPath, now: "2026-06-01T00:00:00Z" }),
    ).rejects.toThrow(/live NOAA fetch failed/i);
    expect(fs.existsSync(outPath)).toBe(false);
  });

  it("every station's live fetch failing STILL aborts even when every station has previous rows to carry forward (never silently re-publish an all-stale feed forever, Codex review round 2)", async () => {
    const mapPath = writeJson("map.json", {
      "test-beach": { stationId: "FAIL3", representative: false, thresholdDatum: null },
    });
    const tzPath = writeJson("tz.json", { "test-beach": "America/New_York" });
    const outPath = path.join(tmpDir, "out.json");
    const prevPath = writeJson("prev.json", {
      schemaVersion: 1,
      generatedAt: "2026-01-01T00:00:00.000Z",
      stations: [
        {
          stationId: "FAIL3",
          datum: "STND",
          representative: false,
          nwsMinorFt: null,
          nosMinorFt: null,
          percentileByYear: {},
          highs: [],
          validThrough: "2028-01-01T00:00:00.000Z",
          generatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: { message: "down" } })));

    await expect(
      runMain({ out: outPath, map: mapPath, tzmap: tzPath, prev: prevPath, now: "2026-06-01T00:00:00Z" }),
    ).rejects.toThrow(/live NOAA fetch failed/i);
    expect(fs.existsSync(outPath)).toBe(false);
  });
});
