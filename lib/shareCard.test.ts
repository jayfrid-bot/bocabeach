import { describe, expect, it } from "vitest";
import { shareCardModel } from "@/lib/shareCard";
import type {
  BusynessData,
  CityOfficialData,
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
    expect(m.flags).toEqual([]);
    expect(m.capped).toBe(false);
  });

  it("never throws on a null/undefined response", () => {
    expect(() => shareCardModel(null, NOW_MS)).not.toThrow();
    expect(() => shareCardModel(undefined, NOW_MS)).not.toThrow();
    const m = shareCardModel(undefined, NOW_MS);
    expect(m.beachName).toBe("Is It Beach Day?");
    expect(m.tiles).toEqual([]);
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

  it("selects tiles in priority order and drops any with missing data", () => {
    const subScores: SubScore[] = [
      sub("waterTemp", "Water temperature", "82.4°F"),
      sub("waves", "Sea state (swim calmness)", "1.4 ft · gentle"),
      sub("wind", "Wind (sea breeze)", "10 mph SE"),
      sub("airTemp", "Air temperature", "88°F"),
      // sandTemp and uv deliberately missing (no display) — should be skipped
      sub("sandTemp", "Sand temperature (barefoot)", undefined),
      sub("uv", "UV index", undefined),
    ];
    const res = response(
      { busyness: wrap<BusynessData>({ level: "unknown" }) },
      { subScores },
    );
    const m = shareCardModel(res, NOW_MS);
    // busyness is "unknown" today, so the 6th slot falls back to Air temp.
    expect(m.tiles.map((t) => t.key)).toEqual(["waterTemp", "waves", "wind", "airTemp"]);
    expect(m.tiles[0]).toEqual({ key: "waterTemp", label: "Water temp", value: "82.4°F" });
    expect(m.tiles.find((t) => t.key === "airTemp")?.value).toBe("88°F");
  });

  it("caps at six tiles even when every slot has data", () => {
    const subScores: SubScore[] = [
      sub("waterTemp", "Water temperature", "82°F"),
      sub("sandTemp", "Sand temperature (barefoot)", "~120°F est."),
      sub("waves", "Sea state (swim calmness)", "1.4 ft · gentle"),
      sub("uv", "UV index", "7"),
      sub("wind", "Wind (sea breeze)", "10 mph SE"),
      sub("crowds", "Crowds", "~40% full"),
      sub("airTemp", "Air temperature", "88°F"),
    ];
    const res = response(
      { busyness: wrap<BusynessData>({ level: "moderate" }) },
      { subScores },
    );
    const m = shareCardModel(res, NOW_MS);
    expect(m.tiles).toHaveLength(6);
    expect(m.tiles.map((t) => t.key)).toEqual([
      "waterTemp",
      "sandTemp",
      "waves",
      "uv",
      "wind",
      "crowds",
    ]);
  });

  it("appends the UV level word to the UV tile", () => {
    const res = response({}, { subScores: [sub("uv", "UV index", "9")] });
    const m = shareCardModel(res, NOW_MS);
    expect(m.tiles[0].value).toBe("9 · Very High");
  });

  it("uses crowd only when a camera read the beach today, else air temp", () => {
    const subScores: SubScore[] = [
      sub("crowds", "Crowds", "~60% full"),
      sub("airTemp", "Air temperature", "90°F"),
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
    expect(shareCardModel(withoutToday, NOW_MS).tiles.map((t) => t.key)).toEqual(["airTemp"]);

    const noCamsAtAll = response({ busyness: wrap<BusynessData>(null) }, { subScores });
    expect(shareCardModel(noCamsAtAll, NOW_MS).tiles.map((t) => t.key)).toEqual(["airTemp"]);
  });

  it("carries posted lifeguard flags as plain-English labels, dropping unknown", () => {
    const res = response({
      cityOfficial: wrap<CityOfficialData>({ flags: ["yellow", "purple", "unknown"] }),
    });
    const m = shareCardModel(res, NOW_MS);
    expect(m.flags).toEqual([
      { color: "yellow", label: "Yellow flag" },
      { color: "purple", label: "Purple flag — marine pests" },
    ]);
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

  it("builds the plain and tracked share URLs from the slug", () => {
    const m = shareCardModel(response(), NOW_MS);
    expect(m.pageUrl).toBe("isitbeachday.com/boca-raton");
    expect(m.shareUrl).toBe("https://isitbeachday.com/boca-raton?ref=share");
  });
});
