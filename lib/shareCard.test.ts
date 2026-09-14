import { describe, expect, it } from "vitest";
import { shareCardModel } from "@/lib/shareCard";
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

  it("formats the local date and time from the beach's timezone", () => {
    const m = shareCardModel(response(), NOW_MS);
    expect(m.dateLabel).toBe("Mon, Sep 14");
    expect(m.timeLabel).toBe("4:08 PM");
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

  it("caps at six tiles even when every slot has data", () => {
    const subScores: SubScore[] = [
      sub("waterTemp", "Water temperature", "82°F"),
      sub("airTemp", "Air temperature", "88°F"),
      sub("sandTemp", "Sand temperature (barefoot)", "120°F"),
      sub("waves", "Sea state (swim calmness)", "1.4 ft · gentle"),
      sub("uv", "UV index", "7"),
      sub("wind", "Wind (sea breeze)", "10 mph SE"),
      sub("crowds", "Crowds", "40% full"),
    ];
    const res = response(
      {
        busyness: wrap<BusynessData>({ level: "moderate" }),
        clarity: wrap<ClarityData>({ level: "clear", pct: 92 }),
      },
      { subScores },
    );
    const m = shareCardModel(res, NOW_MS);
    expect(m.tiles).toHaveLength(6);
    expect(m.tiles.map((t) => t.key)).toEqual([
      "waterTemp",
      "airTemp",
      "clarity",
      "sandTemp",
      "waves",
      "uv",
    ]);
  });

  it("appends the UV level word to the UV tile", () => {
    const res = response({}, { subScores: [sub("uv", "UV index", "9")] });
    const m = shareCardModel(res, NOW_MS);
    expect(m.tiles.find((t) => t.key === "uv")?.value).toBe("9 · Very High");
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
