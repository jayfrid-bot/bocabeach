import { describe, it, expect, vi } from "vitest";
import { getLocation } from "@/config/locations";
import { scorableResponse } from "@/lib/alerts/fixtures";
import { deriveMetrics } from "@/lib/score";
import { buildExtra, extraJsonFor, EXTRA_SCHEMA_VERSION } from "@/lib/history/extra";
import { rowFromConditions } from "@/lib/history/archive";
import * as storm from "@/lib/stormActivity";
import type { ConditionsResponse, DayWindow, NowcastData, PrecipRadarData, Wrapped } from "@/lib/types";
import fixture from "@/lib/__fixtures__/boca-2026-09-08-darkening.json";

const boca = getLocation("boca-raton")!;

describe("buildExtra", () => {
  const res = scorableResponse();
  const anchor = Date.parse(res.snapshot.generatedAt);
  const d = deriveMetrics(res.snapshot, anchor);
  const extra = buildExtra(res, d, anchor);

  it("carries the schema version and a version tag on every present block", () => {
    expect(extra.v).toBe(EXTRA_SCHEMA_VERSION);
    for (const [k, v] of Object.entries(extra)) {
      if (k === "v" || v == null) continue;
      expect((v as { av?: string }).av, k).toBeTruthy();
    }
  });

  it("always has safety levels, and sand model output that matches the score's sand column", () => {
    expect(["safe", "caution", "stay-out"]).toContain(extra.safety?.swim);
    expect(["go", "experienced", "closed"]).toContain(extra.safety?.surf);
    if (d.sandTempF != null) expect(extra.sand?.tempF).toBe(d.sandTempF);
  });

  it("mirrors the derived surf estimate", () => {
    if (d.waveHeightFt != null) {
      expect(extra.surf?.surfFt).toBe(Math.round(d.waveHeightFt * 10) / 10);
    }
  });

  it("stays well under the ~4 KB row budget", () => {
    expect(JSON.stringify(extra).length).toBeLessThan(4096);
  });

  it("a block that throws is skipped; the rest still land", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const spy = vi.spyOn(storm, "computeStormActivity").mockImplementation(() => {
      throw new Error("boom");
    });
    const e = buildExtra(res, d, anchor);
    expect(e.storm).toBeUndefined();
    expect(e.safety).toBeDefined();
    expect(err).toHaveBeenCalled();
    spy.mockRestore();
    err.mockRestore();
  });
});

describe("rowFromConditions extra_json", () => {
  it("is now a parseable v1 document", () => {
    const res = scorableResponse();
    const row = rowFromConditions(res, boca, Date.now());
    expect(row.extra_json).not.toBeNull();
    expect(JSON.parse(row.extra_json!).v).toBe(1);
  });

  it("extraJsonFor never throws", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => extraJsonFor({} as never, {} as never, 0)).not.toThrow();
    err.mockRestore();
  });
});

describe("buildExtra on a real captured snapshot (Boca 2026-09-08, carried sand reading)", () => {
  const real = JSON.parse(JSON.stringify(fixture)) as ConditionsResponse;
  const anchor = Date.parse("2026-09-08T15:41:00.000Z");
  const d = deriveMetrics(real.snapshot, anchor);
  const extra = buildExtra(real, d, anchor);

  it("re-runs the sand model on the SAME inputs the score used (same temp, inputs recorded)", () => {
    expect(d.sandTempF).toBeDefined();
    expect(extra.sand?.tempF).toBe(d.sandTempF);
    expect(extra.sand?.carried).toBe(1);
    expect(extra.sand?.cloudPct).toBe(0); // a carried observation already embodies its sky
    expect(extra.sand?.soilF).not.toBeNull();
    expect(extra.sand?.solarWm2).not.toBeNull();
  });

  it("fills the other readouts a live snapshot supports", () => {
    expect(extra.surf?.surfFt).not.toBeUndefined();
    expect(extra.feels?.tempF).toBeGreaterThan(0);
    expect(extra.storm).toBeDefined();
    expect(!extra.window || typeof extra.window.score === "number").toBe(true);
  });
});

// --- Scorecard blocks: rain, flags, outlook --------------------------------

function radarOf(over: Partial<PrecipRadarData>): Wrapped<PrecipRadarData> {
  return {
    source: "test",
    status: "ok",
    fetchedAt: "",
    attribution: "test",
    data: {
      rainNowMmHr: 0,
      nearestRainKm: null,
      nearestBearingDeg: null,
      coveragePct: 0,
      motion: null,
      etaMinutes: null,
      frameIso: "2026-09-02T10:40:00Z",
      framesUsed: 2,
      frameAgeMinutes: 6.4,
      wetMinutesAgo: null,
      ...over,
    },
  };
}

function nowcastOf(data: NowcastData | null): Wrapped<NowcastData> {
  return { source: "test", status: data ? "ok" : "error", fetchedAt: "", attribution: "test", data };
}

function withSnapshot(patch: Partial<ConditionsResponse["snapshot"]>): ConditionsResponse {
  const res = scorableResponse();
  return { ...res, snapshot: { ...res.snapshot, ...patch } };
}

function extraOf(res: ConditionsResponse) {
  const anchor = Date.parse(res.snapshot.generatedAt);
  return buildExtra(res, deriveMetrics(res.snapshot, anchor), anchor);
}

describe("buildExtra rain block (scorecard)", () => {
  it("records the model nowcast next to the radar truth", () => {
    const e = extraOf(
      withSnapshot({
        nowcast: nowcastOf({ state: "dry", changeInMin: 45, text: "Dry — rain likely in ~45 min" }),
        precipRadar: radarOf({ rainNowMmHr: 0 }),
      }),
    );
    expect(e.rain).toEqual({
      av: expect.any(String),
      nowcast: "dry",
      changeInMin: 45,
      radarMmHr: 0,
      radarDry: 1,
      radarAgeMin: 6,
    });
  });

  it("radarDry is 0 when a fresh frame sees rain at the beach", () => {
    const e = extraOf(
      withSnapshot({
        nowcast: nowcastOf({ state: "dry", text: "Dry for the next 2+ hrs" }),
        precipRadar: radarOf({ rainNowMmHr: 3.456 }),
      }),
    );
    expect(e.rain?.radarMmHr).toBe(3.46);
    expect(e.rain?.radarDry).toBe(0);
    expect(e.rain?.changeInMin).toBeNull();
  });

  it("radarDry is null for a stale frame or a beach the radar cannot see, but the reading is kept", () => {
    const stale = extraOf(withSnapshot({ precipRadar: radarOf({ rainNowMmHr: 0, frameAgeMinutes: 40 }) }));
    expect(stale.rain?.radarDry).toBeNull();
    expect(stale.rain?.radarMmHr).toBe(0);
    expect(stale.rain?.radarAgeMin).toBe(40);
    expect(stale.rain?.nowcast).toBeNull();

    const blind = extraOf(withSnapshot({ precipRadar: radarOf({ rainNowMmHr: null }) }));
    expect(blind.rain?.radarDry).toBeNull();
    expect(blind.rain?.radarMmHr).toBeNull();
  });

  it("is absent (never fabricated) when neither the nowcast nor the radar has data", () => {
    expect(extraOf(scorableResponse()).rain).toBeUndefined();
  });

  it("an erroring radar feed contributes nothing", () => {
    const radar = { ...radarOf({ rainNowMmHr: 5 }), status: "error" as const };
    const e = extraOf(
      withSnapshot({
        nowcast: nowcastOf({ state: "raining", text: "Rain likely for the next 2+ hrs" }),
        precipRadar: radar,
      }),
    );
    expect(e.rain?.nowcast).toBe("raining");
    expect(e.rain?.radarMmHr).toBeNull();
    expect(e.rain?.radarDry).toBeNull();
    expect(e.rain?.radarAgeMin).toBeNull();
  });
});

describe("buildExtra flags block (scorecard)", () => {
  it("copies the posted colors and the feed status", () => {
    const e = extraOf(scorableResponse());
    expect(e.flags).toEqual({ av: expect.any(String), colors: ["green"], status: "ok" });
  });

  it("records ['unknown'] when the City feed has nothing", () => {
    const res = scorableResponse();
    const e = extraOf({
      ...res,
      snapshot: { ...res.snapshot, cityOfficial: { ...res.snapshot.cityOfficial, status: "error", data: null } },
    });
    expect(e.flags).toEqual({ av: expect.any(String), colors: ["unknown"], status: "error" });
  });
});

describe("buildExtra outlook block (scorecard)", () => {
  const day = (i: number, peak: number | null, withBest = true): DayWindow => ({
    date: `2026-09-${String(2 + i).padStart(2, "0")}`,
    dow: i === 0 ? "Today" : "Mon",
    best: withBest
      ? {
          startIso: `2026-09-${String(2 + i).padStart(2, "0")}T14:00:00.000Z`,
          endIso: `2026-09-${String(2 + i).padStart(2, "0")}T21:00:00.000Z`,
          score: peak ?? 0,
        }
      : null,
    peakScore: peak,
    emoji: "☀️",
  });

  it("keeps days 1..6 (day 0 is the window block) and stays compact", () => {
    const res = scorableResponse();
    const full: ConditionsResponse = {
      ...res,
      multiDayWindows: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => day(i, 70 + i)),
    };
    const e = extraOf(full);
    expect(e.outlook?.days).toHaveLength(6);
    expect(e.outlook?.days[0]).toEqual({
      date: "2026-09-03",
      peak: 71,
      start: "2026-09-03T14:00:00.000Z",
      end: "2026-09-03T21:00:00.000Z",
      score: 71,
    });
    expect(e.outlook?.days[5].date).toBe("2026-09-08");
    // The whole document, every block, fits the ~4 KB row budget.
    expect(JSON.stringify(e).length).toBeLessThan(4096);
  });

  it("a day with no window keeps its peak and nulls the window fields", () => {
    const res = scorableResponse();
    const e = extraOf({ ...res, multiDayWindows: [day(0, 80), day(1, 55, false)] });
    expect(e.outlook?.days).toEqual([{ date: "2026-09-03", peak: 55, start: null, end: null, score: null }]);
  });

  it("is absent when there is no multi-day window beyond today", () => {
    expect(extraOf(scorableResponse()).outlook).toBeUndefined();
    const res = scorableResponse();
    expect(extraOf({ ...res, multiDayWindows: [day(0, 80)] }).outlook).toBeUndefined();
  });

  it("a block that throws is skipped; the others still land", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = scorableResponse();
    const bad = { ...res, multiDayWindows: [day(0, 80), null as unknown as DayWindow] };
    const e = extraOf(bad);
    expect(e.outlook).toBeUndefined();
    expect(e.flags).toBeDefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
