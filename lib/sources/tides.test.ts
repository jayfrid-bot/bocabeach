import { describe, it, expect } from "vitest";
import {
  buildObservedTide,
  deriveTideData,
  parseNoaaPredictions,
  parseWaterLevel,
} from "@/lib/sources/tides";

const JSON_OK = {
  predictions: [
    { t: "2026-05-29 06:00", v: "0.3", type: "L" as const },
    { t: "2026-05-29 12:29", v: "2.5", type: "H" as const },
    { t: "2026-05-29 18:55", v: "0.2", type: "L" as const },
  ],
};

describe("parseNoaaPredictions", () => {
  it("keeps only upcoming events and infers trend", () => {
    const now = Date.parse("2026-05-29T09:00:00Z");
    const d = parseNoaaPredictions(JSON_OK, now);
    expect(d).not.toBeNull();
    expect(d!.next).toHaveLength(2);
    expect(d!.next[0].type).toBe("high");
    expect(d!.next[0].heightFt).toBe(2.5);
    expect(d!.trend).toBe("rising"); // next event is a high tide
  });

  it("reports falling when the next event is a low tide", () => {
    const now = Date.parse("2026-05-29T13:00:00Z");
    const d = parseNoaaPredictions(JSON_OK, now);
    expect(d!.next[0].type).toBe("low");
    expect(d!.trend).toBe("falling");
  });

  it("returns null on an API error payload", () => {
    expect(parseNoaaPredictions({ error: { message: "bad station" } })).toBeNull();
  });
});

describe("deriveTideData", () => {
  const TZ = "America/New_York";
  const NOW = Date.parse("2026-07-15T17:00:00Z"); // 2026-07-15 13:00 NY
  const DAY = 86_400_000;
  const pad = (n: number) => String(n).padStart(2, "0");
  const noaaT = (ms: number, hour: number) =>
    `${new Date(ms).toISOString().slice(0, 10)} ${pad(hour)}:00`;

  /** ±20-day NOAA hilo payload; today's high is overridden to a king spike. */
  function wideJson(todayHigh: number) {
    const predictions = [];
    for (let d = -20; d <= 20; d++) {
      const ms = NOW + d * DAY;
      const phase = (2 * Math.PI * d) / 14;
      const hi = d === 0 ? todayHigh : 2.5 + 0.8 * Math.cos(phase);
      const lo = 0.3 - 0.8 * Math.cos(phase);
      predictions.push({ t: noaaT(ms, 12), v: hi.toFixed(3), type: "H" as const });
      predictions.push({ t: noaaT(ms, 20), v: lo.toFixed(3), type: "L" as const });
    }
    return { predictions };
  }

  it("attaches a king-tide aberration from a wide window", () => {
    const data = deriveTideData(wideJson(4.0), TZ, NOW);
    expect(data).not.toBeNull();
    expect(data!.next.length).toBeGreaterThan(0); // upcoming events still parsed
    expect(data!.aberration).toBeDefined();
    expect(data!.aberration!.highStatus).toBe("king");
    expect(data!.aberration!.windowDays).toBe(41);
  });

  it("omits the aberration (honest-null) on a short window", () => {
    // The existing 3-event JSON is far too thin to judge a normal band.
    const data = deriveTideData(JSON_OK, TZ, Date.parse("2026-05-29T09:00:00Z"));
    expect(data).not.toBeNull();
    expect(data!.next.length).toBeGreaterThan(0);
    expect(data!.aberration).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Observed water level vs. prediction (a REAL gauge, not a subordinate station)
// Fixtures are the live payloads captured from CO-OPS on 2026-07-28.
// ---------------------------------------------------------------------------
describe("parseWaterLevel", () => {
  const LIVE = {
    metadata: { id: "8722670", name: "Lake Worth Pier, Atlantic Ocean", lat: "26.6128", lon: "-80.0342" },
    data: [{ t: "2026-07-28 19:18", v: "0.83", s: "0.049", f: "1,0,0,0", q: "p" }],
  };

  it("parses the latest observation, in GMT, with the station's own metadata", () => {
    const obs = parseWaterLevel(LIVE, "8722670");
    expect(obs).not.toBeNull();
    expect(obs!.heightFt).toBe(0.83);
    expect(obs!.tIso).toBe("2026-07-28T19:18:00.000Z");
    expect(obs!.stationId).toBe("8722670");
    expect(obs!.stationName).toBe("Lake Worth Pier, Atlantic Ocean");
  });

  it("falls back to the requested station id when CO-OPS returns no metadata", () => {
    const obs = parseWaterLevel({ data: [{ t: "2026-07-28 19:18", v: "0.83" }] }, "8722670");
    expect(obs!.stationId).toBe("8722670");
    expect(obs!.stationName).toBeUndefined();
  });

  it("returns null on the subordinate-station error payload (8722816 has no observations)", () => {
    expect(
      parseWaterLevel(
        { error: { message: "No data was found. This product may not be offered at this station at the requested time." } },
        "8722816",
      ),
    ).toBeNull();
  });

  it("returns null on an empty/garbled payload rather than guessing", () => {
    expect(parseWaterLevel({ data: [] }, "X")).toBeNull();
    expect(parseWaterLevel({}, "X")).toBeNull();
    expect(parseWaterLevel({ data: [{ t: "2026-07-28 19:18", v: "MM" }] }, "X")).toBeNull();
    expect(parseWaterLevel({ data: [{ t: "not-a-date", v: "0.83" }] }, "X")).toBeNull();
  });
});

describe("buildObservedTide", () => {
  // Gauge 8722670's OWN hi/lo predictions bracketing the observation above.
  const GAUGE_PREDICTIONS = {
    predictions: [
      { t: "2026-07-28 06:00", v: "0.454", type: "L" as const },
      { t: "2026-07-28 11:47", v: "2.339", type: "H" as const },
      { t: "2026-07-28 17:57", v: "0.003", type: "L" as const },
      { t: "2026-07-29 00:28", v: "2.883", type: "H" as const },
      { t: "2026-07-29 06:38", v: "0.363", type: "L" as const },
    ],
  };
  const events = GAUGE_PREDICTIONS.predictions.map((p) => ({
    type: p.type === "H" ? ("high" as const) : ("low" as const),
    time: new Date(`${p.t.replace(" ", "T")}:00Z`).toISOString(),
    heightFt: Number(p.v),
  }));
  const obs = {
    heightFt: 0.83,
    tIso: "2026-07-28T19:18:00.000Z",
    stationId: "8722670",
    stationName: "Lake Worth Pier, Atlantic Ocean",
  };

  it("LIVE 2026-07-28: 0.83 ft observed vs ~0.30 ft predicted -> +0.53 ft residual", () => {
    const o = buildObservedTide(events, obs)!;
    expect(o).not.toBeNull();
    // The 19:18 observation sits 81 min into the 391-min low(17:57, 0.003 ft)
    // -> high(00:28, 2.883 ft) leg: f = 0.2072, raised-cosine ease = 0.1021,
    // predicted = 0.297 ft. Observed 0.83 -> the water was running half a foot
    // above the tables (amber territory in the UI).
    expect(o.deltaFt).toBeCloseTo(0.53, 2);
    expect(o.heightFt).toBe(0.83);
    expect(o.stationId).toBe("8722670");
    expect(o.stationName).toBe("Lake Worth Pier, Atlantic Ocean");
  });

  it("reports a NEGATIVE residual when the water is running below prediction", () => {
    const low = buildObservedTide(events, { ...obs, heightFt: -0.4 })!;
    expect(low.deltaFt).toBeCloseTo(-0.7, 2);
  });

  it("is ~0 when the gauge matches its own harmonic prediction exactly", () => {
    // Right at a published turning point, prediction == the event height.
    const atLow = buildObservedTide(events, {
      ...obs,
      tIso: "2026-07-28T17:57:00.000Z",
      heightFt: 0.003,
    })!;
    expect(atLow.deltaFt).toBeCloseTo(0, 2);
  });

  it("honest-nulls when the observation is missing or falls outside the prediction window", () => {
    expect(buildObservedTide(events, null)).toBeNull();
    expect(buildObservedTide(events, { ...obs, tIso: "2026-08-05T12:00:00.000Z" })).toBeNull();
    expect(buildObservedTide([], obs)).toBeNull();
  });
});
