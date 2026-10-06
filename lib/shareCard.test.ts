import { describe, expect, it } from "vitest";
import { SHARE_CARD_MAX_TILES, shareCacheControl, shareCardModel } from "@/lib/shareCard";
import type {
  BusynessData,
  ClarityData,
  ConditionsResponse,
  ConditionsSnapshot,
  ScoreResult,
  SubScore,
  Wrapped,
} from "@/lib/types";

function wrap<T>(data: T | null): Wrapped<T> {
  return { data, source: "test", status: data ? "ok" : "error", fetchedAt: "2026-09-14T00:00:00.000Z", attribution: "test" };
}

const NOW_MS = Date.parse("2026-09-14T20:08:00.000Z"); // 4:08 PM America/New_York

// Built as a plain object (not contextually typed against ConditionsSnapshot)
// and cast at the end — every field is null/absent here except what a test
// overrides, so there's no value in fighting each Wrapped<T>'s exact T.
function emptySnapshot(overrides: Partial<ConditionsSnapshot> = {}): ConditionsSnapshot {
  const base = {
    location: {
      slug: "boca-raton",
      name: "Boca Raton",
      region: "Palm Beach County, FL",
      lat: 26.35,
      lon: -80.07,
      timezone: "America/New_York",
    },
    generatedAt: "2026-09-14T20:00:00.000Z",
    tides: wrap(null),
    buoy: wrap(null),
    weather: wrap(null),
    marine: wrap(null),
    cityOfficial: wrap(null),
    waterQuality: wrap(null),
    nowcast: wrap(null),
    nws: wrap(null),
    airQuality: wrap(null),
    metno: wrap(null),
    gfs: wrap(null),
    lightning: wrap(null),
    goesCloud: wrap(null),
    precipRadar: wrap(null),
    sargassum: wrap(null),
    busyness: wrap(null),
    clarity: wrap(null),
    traffic: wrap(null),
    forecast: wrap(null),
    sun: wrap(null),
    hourly: wrap(null),
  };
  return { ...base, ...overrides } as unknown as ConditionsSnapshot;
}

function sub(key: string, label: string, display?: string): SubScore {
  return { key, label, score: 80, weight: 0.1, display };
}

function emptyScore(overrides: Partial<ScoreResult> = {}): ScoreResult {
  return {
    score: 82,
    rawScore: 82,
    rating: "Good",
    subScores: [],
    caps: [],
    dataAvailable: true,
    ...overrides,
  };
}

function response(
  snapshotOverrides: Partial<ConditionsSnapshot> = {},
  scoreOverrides: Partial<ScoreResult> = {},
): ConditionsResponse {
  return {
    snapshot: emptySnapshot(snapshotOverrides),
    score: emptyScore(scoreOverrides),
    hourlyScores: [],
    multiDayWindows: [],
    cams: [],
  };
}

describe("shareCardModel", () => {
  it("never throws on a totally empty snapshot (full outage)", () => {
    expect(() => shareCardModel(response(), NOW_MS)).not.toThrow();
    const m = shareCardModel(response(), NOW_MS);
    expect(m.tiles).toEqual([]);
    expect(m.capped).toBe(false);
  });

  it("never throws on a null/undefined response", () => {
    expect(() => shareCardModel(null, NOW_MS)).not.toThrow();
    expect(() => shareCardModel(undefined, NOW_MS)).not.toThrow();
    const m = shareCardModel(undefined, NOW_MS);
    expect(m.beachName).toBe("Is It Beach Day?");
    expect(m.tiles).toEqual([]);
  });

  it("has no flags field on the model", () => {
    const m = shareCardModel(response(), NOW_MS);
    expect((m as unknown as Record<string, unknown>).flags).toBeUndefined();
  });

  it("labels the card with when the conditions were measured, in the beach's timezone", () => {
    // generatedAt is 20:00Z; the request comes 8 minutes later.
    const m = shareCardModel(response(), NOW_MS);
    expect(m.dateLabel).toBe("Mon, Sep 14");
    expect(m.timeLabel).toBe("4:00 PM");
    expect(m.stale).toBe(false);
  });

  it("flags conditions older than the dashboard's freshness limit", () => {
    const m = shareCardModel(response(), Date.parse("2026-09-14T20:45:00.000Z"));
    expect(m.stale).toBe(true);
    expect(m.timeLabel).toBe("4:00 PM");
  });

  it("shows no number or verdict on a total data outage", () => {
    const m = shareCardModel(response({}, { score: 0, rawScore: 0, rating: "Unavailable", dataAvailable: false }), NOW_MS);
    expect(m.available).toBe(false);
    expect(m.verdict).toBe("Conditions unavailable");
    expect(m.verdict).not.toBe("Definitely not");
  });

  it("keeps the limited-data warning when the score rests on too few readings", () => {
    const m = shareCardModel(response({}, { score: 70, dataCoverage: "limited" }), NOW_MS);
    expect(m.limitedNote).toBe("Limited data — some readings unavailable");
    expect(shareCardModel(response(), NOW_MS).limitedNote).toBeUndefined();
  });

  it("carries the score, rating, band color, and verdict", () => {
    const m = shareCardModel(response({}, { score: 92, rating: "Excellent" }), NOW_MS);
    expect(m.score).toBe(92);
    expect(m.rating).toBe("Excellent");
    expect(m.color).toBe("#10b981"); // emerald — lib/scoreBands.ts
    expect(m.verdict).toBe("Absolutely!");
  });

  it("selects tiles in priority order (water temp, air temp, clarity, sand, waves, uv) and drops any with missing data", () => {
    const subScores: SubScore[] = [
      sub("waterTemp", "Water temperature", "82.4°F"),
      sub("waves", "Sea state (swim calmness)", "1.4 ft · gentle"),
      sub("wind", "Wind (sea breeze)", "10 mph SE"),
      sub("airTemp", "Air temperature", "88.3°F"),
      // sandTemp and uv deliberately missing (no display) — should be skipped
      sub("sandTemp", "Sand temperature (barefoot)", undefined),
      sub("uv", "UV index", undefined),
    ];
    const res = response(
      { busyness: wrap<BusynessData>({ level: "unknown" }) },
      { subScores },
    );
    const m = shareCardModel(res, NOW_MS);
    // No live clarity read, sand/uv missing — order stays waterTemp, airTemp, waves,
    // then wind falls in as a fallback (crowd stays out: busyness is "unknown" today).
    expect(m.tiles.map((t) => t.key)).toEqual(["waterTemp", "airTemp", "waves", "wind"]);
    expect(m.tiles[0]).toEqual({ key: "waterTemp", label: "Water temp", value: "82.4°F" });
    expect(m.tiles.find((t) => t.key === "airTemp")?.value).toBe("88°F");
  });

  it("rounds the air temp tile to a whole number", () => {
    const res = response({}, { subScores: [sub("airTemp", "Air temperature", "88.7°F")] });
    const m = shareCardModel(res, NOW_MS);
    expect(m.tiles[0]).toEqual({ key: "airTemp", label: "Air temp", value: "89°F" });
  });

  it("adds a water clarity tile from a live cam read", () => {
    const res = response({
      clarity: wrap<ClarityData>({ level: "clear", pct: 90 }),
    });
    const m = shareCardModel(res, NOW_MS);
    const clarityTile = m.tiles.find((t) => t.key === "clarity");
    expect(clarityTile).toEqual({ key: "clarity", label: "Water clarity", value: "Crystal clear" });
  });

  it("omits the water clarity tile when the read is night/stale-gated (no live level)", () => {
    const res = response({
      clarity: wrap<ClarityData>({
        level: null,
        pct: null,
        status: "unknown",
        note: "cams can't read the water in the dark",
        yesterday: {
          dateLocal: "2026-09-13",
          dayLabel: "yesterday",
          daysBack: 1,
          pct: 70,
          word: "Mostly clear",
          reads: 4,
        },
      }),
    });
    const m = shareCardModel(res, NOW_MS);
    expect(m.tiles.find((t) => t.key === "clarity")).toBeUndefined();
  });

  it("omits the water clarity tile when there's no clarity data at all", () => {
    const m = shareCardModel(response({ clarity: wrap<ClarityData>(null) }), NOW_MS);
    expect(m.tiles.find((t) => t.key === "clarity")).toBeUndefined();
  });

  it("strips the '~' and 'est.' hedge from the sand temp tile", () => {
    const res = response({}, { subScores: [sub("sandTemp", "Sand temperature (barefoot)", "~101°F est.")] });
    const m = shareCardModel(res, NOW_MS);
    expect(m.tiles[0]).toEqual({ key: "sandTemp", label: "Sand temp", value: "101°F" });
  });

  it("never shows 'est.', 'estimated', or '~' in any tile value", () => {
    const subScores: SubScore[] = [
      sub("waterTemp", "Water temperature", "82°F"),
      sub("airTemp", "Air temperature", "88°F"),
      sub("sandTemp", "Sand temperature (barefoot)", "~120°F est."),
      sub("waves", "Sea state (swim calmness)", "1.4 ft · gentle"),
      sub("uv", "UV index", "7"),
      sub("wind", "Wind (sea breeze)", "10 mph SE"),
      sub("crowds", "Crowds", "~40% full"),
    ];
    const res = response(
      {
        busyness: wrap<BusynessData>({ level: "moderate" }),
        clarity: wrap<ClarityData>({ level: "murky", pct: 30 }),
      },
      { subScores },
    );
    const m = shareCardModel(res, NOW_MS);
    for (const t of m.tiles) {
      expect(t.value.toLowerCase()).not.toContain("est");
      expect(t.value).not.toContain("~");
    }
  });

  it("orders every tile by priority and caps the list at SHARE_CARD_MAX_TILES", () => {
    const subScores: SubScore[] = [
      sub("waterTemp", "Water temperature", "82°F"),
      sub("airTemp", "Air temperature", "88°F"),
      sub("sandTemp", "Sand temperature (barefoot)", "120°F"),
      sub("waves", "Sea state (swim calmness)", "1.4 ft · gentle"),
      sub("uv", "UV index", "7"),
      sub("wind", "Wind (sea breeze)", "10 mph SE"),
      sub("crowds", "Crowds", "~40% full"),
    ];
    const res = response(
      {
        busyness: wrap<BusynessData>({ level: "moderate" }),
        clarity: wrap<ClarityData>({ level: "clear", pct: 92 }),
        sargassum: wrap({ level: "low", coveragePct: 8 }) as ConditionsSnapshot["sargassum"],
        forecast: wrap([{ date: "2026-09-14", dow: "Mon", hi: 90.4, lo: 78, rain: 20 }]) as ConditionsSnapshot["forecast"],
        sun: wrap({ sunset: "2026-09-14T23:30:00.000Z" }) as ConditionsSnapshot["sun"],
        tides: wrap({ next: [{ type: "low", time: "2026-09-14T22:00:00.000Z", heightFt: 0.4 }] }) as ConditionsSnapshot["tides"],
      },
      { subScores },
    );
    const m = shareCardModel(res, NOW_MS);
    expect(m.tiles.map((t) => t.key)).toEqual([
      "waterTemp",
      "airTemp",
      "waves",
      "wind",
      "uv",
      "sandTemp",
      "seaweed",
      "clarity",
      "crowds",
      "rain",
      "sun",
      "tide",
    ]);
    expect(m.tiles.length).toBeLessThanOrEqual(SHARE_CARD_MAX_TILES);
    expect(m.tiles.find((t) => t.key === "airTemp")).toMatchObject({ value: "88°F", note: "high 90°F" });
    expect(m.tiles.find((t) => t.key === "seaweed")).toMatchObject({ value: "Low", note: "8% covered" });
    expect(m.tiles.find((t) => t.key === "crowds")?.value).toBe("40% full");
    expect(m.tiles.find((t) => t.key === "rain")).toMatchObject({ value: "20%", note: "chance today" });
    expect(m.tiles.find((t) => t.key === "sun")).toMatchObject({ label: "Sunset", value: "7:30 PM" });
    expect(m.tiles.find((t) => t.key === "tide")).toMatchObject({ label: "Low tide", value: "6:00 PM" });
  });

  it("splits a long reading into a short value and a note, so no tile wraps", () => {
    const res = response(
      {},
      {
        subScores: [
          sub("waves", "Sea state (swim calmness)", "4.8 ft · big waves"),
          sub("wind", "Wind (sea breeze)", "18 mph ESE"),
        ],
      },
    );
    const m = shareCardModel(res, NOW_MS);
    expect(m.tiles.find((t) => t.key === "waves")).toMatchObject({ value: "4.8 ft", note: "big waves" });
    expect(m.tiles.find((t) => t.key === "wind")).toMatchObject({ value: "18 mph", note: "from ESE" });
  });

  it("shows sunrise tomorrow once today's sunset has passed", () => {
    const res = response({
      sun: wrap({ sunset: "2026-09-14T19:00:00.000Z", tomorrowSunrise: "2026-09-15T10:55:00.000Z" }) as ConditionsSnapshot["sun"],
    });
    expect(shareCardModel(res, NOW_MS).tiles.find((t) => t.key === "sun")).toMatchObject({
      label: "Sunrise",
      value: "6:55 AM",
      note: "tomorrow",
    });
  });

  it("puts the UV level word under the UV number", () => {
    const res = response({}, { subScores: [sub("uv", "UV index", "9")] });
    const m = shareCardModel(res, NOW_MS);
    expect(m.tiles.find((t) => t.key === "uv")).toMatchObject({ value: "9", note: "Very High" });
  });

  describe("best time", () => {
    const day = (startIso: string, endIso: string) => ({
      date: startIso.slice(0, 10),
      dow: "Today",
      best: { startIso, endIso, score: 80 },
      peakScore: 80,
    });
    const withDays = (days: unknown[]) => ({ ...response(), multiDayWindows: days } as unknown as ConditionsResponse);

    it("names today's window while it is still ahead", () => {
      const m = shareCardModel(withDays([day("2026-09-14T21:00:00.000Z", "2026-09-14T23:00:00.000Z")]), NOW_MS);
      expect(m.bestTime).toBe("Best time today: 5 PM–7 PM");
    });

    it("says 'now until' for a window already under way, never an odd start minute", () => {
      const m = shareCardModel(withDays([day("2026-09-14T19:00:00.000Z", "2026-09-14T22:00:00.000Z")]), NOW_MS);
      expect(m.bestTime).toBe("Best time today: now until 6 PM");
    });

    it("moves to tomorrow once today's window has passed", () => {
      const m = shareCardModel(
        withDays([
          day("2026-09-14T14:00:00.000Z", "2026-09-14T16:00:00.000Z"),
          day("2026-09-15T14:00:00.000Z", "2026-09-15T18:00:00.000Z"),
        ]),
        NOW_MS,
      );
      expect(m.bestTime).toBe("Best time tomorrow: 10 AM–2 PM");
    });

    it("says there is no good time when today's best window is poor", () => {
      const poor = { ...day("2026-09-14T21:00:00.000Z", "2026-09-14T23:00:00.000Z"), best: { startIso: "2026-09-14T21:00:00.000Z", endIso: "2026-09-14T23:00:00.000Z", score: 15 } };
      expect(shareCardModel(withDays([poor]), NOW_MS).bestTime).toBe("No good beach time today");
      expect(
        shareCardModel(withDays([poor, day("2026-09-15T14:00:00.000Z", "2026-09-15T18:00:00.000Z")]), NOW_MS).bestTime,
      ).toBe("No good time today · Best tomorrow: 10 AM–2 PM");
    });

    it("never names a poor window for tomorrow either", () => {
      const pastToday = day("2026-09-14T14:00:00.000Z", "2026-09-14T16:00:00.000Z");
      const poorTomorrow = { ...day("2026-09-15T14:00:00.000Z", "2026-09-15T18:00:00.000Z"), best: { startIso: "2026-09-15T14:00:00.000Z", endIso: "2026-09-15T18:00:00.000Z", score: 40 } };
      expect(shareCardModel(withDays([pastToday, poorTomorrow]), NOW_MS).bestTime).toBeUndefined();
    });

    it("is absent when there is no window", () => {
      expect(shareCardModel(response(), NOW_MS).bestTime).toBeUndefined();
    });
  });

  it("never claims 'safe to swim': no detected hazard means no safety strip", () => {
    const m = shareCardModel(response(), NOW_MS);
    expect(m.safety.label).toBe("");
    expect(m.safety.reasons).toEqual([]);
  });

  describe("live rip status", () => {
    const highRip = (end?: string) =>
      ({
        ripCurrentRisk: "high",
        srfPeriods: [{ label: "TODAY", level: "high", start: "2026-09-14T10:00:00.000Z", end }],
        alerts: [],
      }) as unknown as NonNullable<ConditionsSnapshot["nws"]["data"]>;

    it("caps the cached score by the rip risk in force now, as the dashboard does", () => {
      const res = response(
        { nws: wrap(highRip()) as ConditionsSnapshot["nws"] },
        { score: 95, rawScore: 95, scoreExceptRipCap: 95 },
      );
      const m = shareCardModel(res, NOW_MS);
      expect(m.score).toBe(85);
      expect(m.safety).toMatchObject({ level: "caution", label: "Swim with caution" });
      expect(m.safety.reasons).toContain("Rip current risk: High");
      expect(m.tiles.find((t) => t.key === "rip")).toMatchObject({ value: "High" });
    });

    it("reports when the rip picture next changes, so the image cache can expire then", () => {
      const end = "2026-09-14T20:13:00.000Z"; // 5 minutes after NOW_MS
      const m = shareCardModel(response({ nws: wrap(highRip(end)) as ConditionsSnapshot["nws"] }), NOW_MS);
      expect(m.changesAtMs).toBe(Date.parse(end));
    });
  });

  describe("shareCacheControl", () => {
    const fresh = (changesAtMs?: number) => ({ changesAtMs, stale: false });

    it("keeps 15 minutes with stale serving when nothing changes within 25 minutes", () => {
      expect(shareCacheControl(fresh(), NOW_MS)).toBe("public, max-age=900, s-maxage=900, stale-while-revalidate=600");
      expect(shareCacheControl(fresh(NOW_MS + 30 * 60_000), NOW_MS)).toContain("stale-while-revalidate=600");
    });

    it("drops stale serving when a known change falls inside the stale window", () => {
      // 1,000 s away: max-age 900 alone would end before it, but stale
      // serving would carry the old card past it.
      expect(shareCacheControl(fresh(NOW_MS + 1_000_000), NOW_MS)).toBe("public, max-age=900, s-maxage=900");
    });

    it("expires at the change, never under a minute", () => {
      expect(shareCacheControl(fresh(NOW_MS + 5 * 60_000), NOW_MS)).toBe("public, max-age=300, s-maxage=300");
      expect(shareCacheControl(fresh(NOW_MS + 10_000), NOW_MS)).toBe("public, max-age=60, s-maxage=60");
    });

    it("keeps a card drawn from stale conditions for only a minute", () => {
      expect(shareCacheControl({ stale: true }, NOW_MS)).toBe("public, max-age=60, s-maxage=60");
    });
  });


  describe("days are picked by local date, not array position", () => {
    const AFTER_MIDNIGHT = Date.parse("2026-09-15T04:30:00.000Z"); // 12:30 AM Sep 15, New York
    const built = (overrides: Partial<ConditionsSnapshot> = {}) =>
      ({
        ...response(overrides),
        // A response built the evening before: index 0 is Sep 14.
        multiDayWindows: [
          { date: "2026-09-14", dow: "Today", best: { startIso: "2026-09-14T21:00:00.000Z", endIso: "2026-09-14T23:00:00.000Z", score: 80 }, peakScore: 80 },
          { date: "2026-09-15", dow: "Tue", best: { startIso: "2026-09-15T14:00:00.000Z", endIso: "2026-09-15T17:00:00.000Z", score: 82 }, peakScore: 82 },
        ],
      }) as unknown as ConditionsResponse;

    it("calls the Sep 15 window 'today' after local midnight", () => {
      expect(shareCardModel(built(), AFTER_MIDNIGHT).bestTime).toBe("Best time today: 10 AM–1 PM");
    });

    it("uses the forecast entry for the local date, not entry 0", () => {
      const forecast = wrap([
        { date: "2026-09-14", dow: "Mon", hi: 91, lo: 79, rain: 80 },
        { date: "2026-09-15", dow: "Tue", hi: 87, lo: 77, rain: 10 },
      ]) as ConditionsSnapshot["forecast"];
      const m = shareCardModel(
        built({ forecast, sun: wrap({ sunset: "2026-09-15T23:20:00.000Z" }) as ConditionsSnapshot["sun"] }),
        AFTER_MIDNIGHT,
      );
      expect(m.tiles.find((t) => t.key === "airTemp")?.note).toBeUndefined(); // no air temp sub-score
      expect(m.tiles.find((t) => t.key === "rain")).toMatchObject({ value: "10%" });
    });

    it("labels the next sunrise 'today' when it falls on the local date", () => {
      const sun = wrap({
        sunset: "2026-09-14T23:25:00.000Z",
        tomorrowSunrise: "2026-09-15T10:55:00.000Z",
      }) as ConditionsSnapshot["sun"];
      const m = shareCardModel(built({ sun }), AFTER_MIDNIGHT);
      expect(m.tiles.find((t) => t.key === "sun")).toMatchObject({ label: "Sunrise", value: "6:55 AM", note: "today" });
    });

    it("drops today's rain chance once the sun has set", () => {
      const forecast = wrap([{ date: "2026-09-14", dow: "Mon", hi: 91, lo: 79, rain: 60 }]) as ConditionsSnapshot["forecast"];
      const sun = wrap({ sunset: "2026-09-14T23:25:00.000Z" }) as ConditionsSnapshot["sun"];
      const LATE = Date.parse("2026-09-15T01:00:00.000Z"); // 9 PM Sep 14, New York
      expect(shareCardModel(response({ forecast, sun }), LATE).tiles.find((t) => t.key === "rain")).toBeUndefined();
    });
  });

  it("uses crowd only when a camera read the beach today, and only as a fallback slot", () => {
    const subScores: SubScore[] = [
      sub("crowds", "Crowds", "60% full"),
    ];

    const withToday = response(
      { busyness: wrap<BusynessData>({ level: "busy" }) },
      { subScores },
    );
    expect(shareCardModel(withToday, NOW_MS).tiles.map((t) => t.key)).toEqual(["crowds"]);

    const withoutToday = response(
      { busyness: wrap<BusynessData>({ level: "unknown" }) },
      { subScores },
    );
    expect(shareCardModel(withoutToday, NOW_MS).tiles.map((t) => t.key)).toEqual([]);
  });

  it("notes a capped score with the first cap reason", () => {
    const m = shareCardModel(
      response({}, { caps: ["Lightning within 5 mi — get out of the water"] }),
      NOW_MS,
    );
    expect(m.capped).toBe(true);
    expect(m.capNote).toBe("Lightning within 5 mi — get out of the water");
  });

  it("leaves capNote undefined when the score isn't capped", () => {
    const m = shareCardModel(response(), NOW_MS);
    expect(m.capped).toBe(false);
    expect(m.capNote).toBeUndefined();
  });

  it("uses the clean apex link for the flagship beach, with no tracking param", () => {
    // Boca is the flagship (its own /<slug> 301s to "/"), so both the on-card
    // text and the shared link are the bare apex — and neither carries ?ref.
    const m = shareCardModel(response(), NOW_MS);
    expect(m.pageUrl).toBe("isitbeachday.com");
    expect(m.shareUrl).toBe("https://isitbeachday.com");
    expect(m.shareUrl).not.toContain("ref=share");
  });

  it("uses a plain /<slug> link for a non-flagship beach", () => {
    const m = shareCardModel(
      response({
        location: {
          slug: "deerfield-beach",
          name: "Deerfield Beach",
          region: "Broward County, FL",
          lat: 26.3165,
          lon: -80.0742,
          timezone: "America/New_York",
        },
      } as unknown as Partial<ConditionsSnapshot>),
      NOW_MS,
    );
    expect(m.pageUrl).toBe("isitbeachday.com/deerfield-beach");
    expect(m.shareUrl).toBe("https://isitbeachday.com/deerfield-beach");
    expect(m.shareUrl).not.toContain("ref=share");
  });
});
