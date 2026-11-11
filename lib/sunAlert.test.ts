// predictNextSunEvent (the assembly components/SunQualityCard.tsx and the
// "sun-color" push alert both read off) against a fixture ConditionsResponse
// — never a network call, never a real snapshot.

import { describe, it, expect } from "vitest";
import {
  assembleSunEventQuality,
  predictNextSunEvent,
  resolveIrObservation,
  resolveSunHorizon,
  sunQualityHourlyPoints,
  BEAM_IMMINENT_MINUTES,
  EARLY_LOOK_DISAGREE_PTS,
  IR_EARLY_WINDOW_MINUTES,
  IR_EVENT_WINDOW_MINUTES,
  IR_MAX_GRANULE_AGE_MINUTES,
  IR_MAX_UNCLASSIFIED_PCT,
  sunColorLiveGuard,
} from "@/lib/sunAlert";
import { sunEventQuality, type HourlyCloudPoint } from "@/lib/sunQuality";
import { FIXTURE_SUNRISE, FIXTURE_SUNSET, scorableResponse } from "@/lib/alerts/fixtures";
import type { ConditionsResponse, GoesIrData } from "@/lib/types";

// 2 PM ET on the fixture's own day — after FIXTURE_SUNRISE (6:45 AM ET),
// before FIXTURE_SUNSET (7:35 PM ET), so the next event is today's sunset.
const NOW_MS = Date.parse("2026-09-02T18:00:00Z");

/** A vivid-but-not-epic cloud mix at the exact sunset hour: low 10% (under
 *  the 20% "costs nothing" bar), mid 35% + high 10% — a partial deck in the
 *  canvas sweet spot, landing in the factor model's 70-89 ("vivid"/"Great")
 *  range; with no clean-air reading it stays short of 90 ("epic"). */
function withVividHourly(over: Partial<ConditionsResponse["snapshot"]> = {}): ConditionsResponse {
  const base = scorableResponse();
  return {
    ...base,
    snapshot: {
      ...base.snapshot,
      hourly: {
        ...base.snapshot.hourly,
        status: "ok",
        data: [
          {
            time: FIXTURE_SUNSET,
            cloudCoverLowPct: 10,
            cloudCoverMidPct: 35,
            cloudCoverHighPct: 10,
          },
        ],
      },
      ...over,
    },
  } as ConditionsResponse;
}

describe("predictNextSunEvent", () => {
  it("returns null when there's no sun-times reading at all", () => {
    const base = scorableResponse();
    const res = {
      ...base,
      snapshot: { ...base.snapshot, sun: { ...base.snapshot.sun, status: "error", data: null } },
    } as ConditionsResponse;
    expect(predictNextSunEvent(res, NOW_MS)).toBeNull();
  });

  it("picks today's sunset (the next event) and scores it off the nearest hourly cloud reading", () => {
    const res = withVividHourly();
    const pred = predictNextSunEvent(res, NOW_MS);
    expect(pred).not.toBeNull();
    expect(pred?.kind).toBe("sunset");
    expect(pred?.eventIso).toBe(FIXTURE_SUNSET);
    expect(pred?.band).toBe("vivid");
    expect(pred?.score!).toBeGreaterThanOrEqual(70);
    // High cloud under 15% → no lag: peak color is the event itself (see
    // peakColorTime, which normalizes to a full ISO instant with milliseconds).
    expect(pred?.peakIso).toBe(new Date(FIXTURE_SUNSET).toISOString());
  });

  it("picks tomorrow's sunrise once today's sunset has passed", () => {
    const base = scorableResponse();
    const res = {
      ...base,
      snapshot: {
        ...base.snapshot,
        sun: {
          ...base.snapshot.sun,
          data: {
            date: "2026-09-02",
            sunrise: FIXTURE_SUNRISE,
            sunset: FIXTURE_SUNSET,
            tomorrowSunrise: "2026-09-03T10:45:00Z",
          },
        },
      },
    } as ConditionsResponse;
    const afterSunset = Date.parse(FIXTURE_SUNSET) + 60_000;
    const pred = predictNextSunEvent(res, afterSunset);
    expect(pred?.kind).toBe("sunrise");
    expect(pred?.eventIso).toBe("2026-09-03T10:45:00Z");
  });

  it("honest-null score when there's no hourly cloud reading near the event hour", () => {
    const base = scorableResponse(); // hourly.data is null by default
    const pred = predictNextSunEvent(base, NOW_MS);
    expect(pred).not.toBeNull();
    expect(pred?.kind).toBe("sunset");
    expect(pred?.score).toBeNull();
    expect(pred?.band).toBeNull();
  });

  it("a partial deck in clean air scores Amazing; a solid deck over the same clear path does not", () => {
    const res = withVividHourly({
      airQuality: { status: "ok", data: { aod: 0.08 } } as unknown as ConditionsResponse["snapshot"]["airQuality"],
    });
    res.snapshot.hourly.data = [
      { time: FIXTURE_SUNSET, cloudCoverLowPct: 5, cloudCoverMidPct: 30, cloudCoverHighPct: 20, cloudCoverPct: 45 },
    ];
    const pred = predictNextSunEvent(res, NOW_MS);
    expect(pred?.score).toBeGreaterThanOrEqual(90);
    expect(pred?.band).toBe("epic");
    res.snapshot.hourly.data = [
      { time: FIXTURE_SUNSET, cloudCoverLowPct: 0, cloudCoverMidPct: 10, cloudCoverHighPct: 100, cloudCoverPct: 100 },
    ];
    const solid = predictNextSunEvent(res, NOW_MS);
    expect(solid?.score!).toBeLessThan(45);
  });
});

describe("resolveSunHorizon", () => {
  const eventIso = "2026-09-02T23:35:00Z";

  it("undefined when the GOES wrapper isn't ok", () => {
    expect(resolveSunHorizon({ cloudPct: 10, status: "error" }, eventIso, Date.parse(eventIso))).toBeUndefined();
  });

  it("undefined with no reading at all", () => {
    expect(resolveSunHorizon(null, eventIso, Date.parse(eventIso))).toBeUndefined();
  });

  it("fresh when the event is within BEAM_IMMINENT_MINUTES", () => {
    const nowMs = Date.parse(eventIso) - (BEAM_IMMINENT_MINUTES - 5) * 60_000;
    const h = resolveSunHorizon({ beamCloudPct: 15, status: "ok" }, eventIso, nowMs);
    expect(h).toEqual({ cloudPct: 15, fresh: true });
  });

  it("not fresh once the event is farther out than BEAM_IMMINENT_MINUTES", () => {
    const nowMs = Date.parse(eventIso) - (BEAM_IMMINENT_MINUTES + 5) * 60_000;
    const h = resolveSunHorizon({ beamCloudPct: 15, status: "ok" }, eventIso, nowMs);
    expect(h).toEqual({ cloudPct: 15, fresh: false });
  });

  it("prefers beamCloudPct over the overhead cloudPct fallback", () => {
    const h = resolveSunHorizon({ beamCloudPct: 5, cloudPct: 40, status: "ok" }, eventIso, Date.parse(eventIso));
    expect(h?.cloudPct).toBe(5);
  });
});

describe("sunQualityHourlyPoints", () => {
  it("maps the raw hourly fields into sunEventQuality's cloud/humidity shape", () => {
    const points = sunQualityHourlyPoints([
      { time: "2026-09-02T23:00:00Z", cloudCoverLowPct: 5, cloudCoverMidPct: 20, cloudCoverHighPct: 10, cloudCoverPct: 30, humidityPct: 55 },
    ]);
    expect(points).toEqual([
      {
        time: "2026-09-02T23:00:00Z",
        cloud: { lowPct: 5, midPct: 20, highPct: 10, totalPct: 30 },
        humidityPct: 55,
      },
    ]);
  });

  it("empty/undefined input maps to an empty array", () => {
    expect(sunQualityHourlyPoints(undefined)).toEqual([]);
    expect(sunQualityHourlyPoints(null)).toEqual([]);
  });
});

// --- the satellite cloud-top read as the model's primary input -----------------

const EVENT_ISO = "2026-10-15T22:52:20.000Z"; // Boca sunset
const EVENT = { event: "sunset" as const, timeIso: EVENT_ISO };
const ms = (iso: string) => Date.parse(iso);
const minutesBefore = (iso: string, min: number) => new Date(ms(iso) - min * 60_000).toISOString();

/** A sunset canvas: clear horizon (6% low along the sun's path), 45% mid + 10% high. */
function ir(over: Partial<GoesIrData> = {}): GoesIrData {
  return {
    lowPct: 5,
    midPct: 45,
    highPct: 10,
    irCloudPct: 60,
    unclassifiedPct: 0,
    classifiedPct: 100,
    validPixels: 225,
    totalPixels: 225,
    granuleStartIso: minutesBefore(EVENT_ISO, 40),
    events: {
      sunset: { eventIso: EVENT_ISO, azDeg: 260.3, beamLowPct: 6, beamMidHighPct: 52, antiMidHighPct: 30, beamSamples: 7 },
    },
    ...over,
  };
}

/** The forecast says nothing is up there at all (the 2026-10-14 miss). */
const EMPTY_FORECAST: HourlyCloudPoint[] = [
  { time: "2026-10-15T23:00:00.000Z", cloud: { lowPct: 0, midPct: 0, highPct: 0, totalPct: 0 }, humidityPct: 70 },
];

describe("resolveIrObservation", () => {
  const NOW = ms(minutesBefore(EVENT_ISO, 30)); // 30 min before the event, granule 10 min old

  it("turns a fresh read into a cloud mix and a verified horizon from the sunward low cloud", () => {
    const o = resolveIrObservation({ status: "ok", ir: ir() }, EVENT, NOW)!;
    expect(o.cloud).toEqual({ lowPct: 5, midPct: 45, highPct: 10, totalPct: 60 });
    expect(o.horizon).toEqual({ cloudPct: 6, fresh: true });
    expect(o.horizonSource).toBe("ir-beam");
    expect(o.granuleAgeMinutes).toBe(10);
    expect(o.sunwardMidHighPct).toBe(52);
    expect(o.antiMidHighPct).toBe(30);
  });

  it("does not need the older mask wrapper to be 'ok' (the IR granule has its own clock)", () => {
    expect(resolveIrObservation({ status: "stale", ir: ir() }, EVENT, NOW)).toBeDefined();
  });

  it("uses the overhead low share as the horizon when the path read is missing or for another event", () => {
    const noBeam = ir({ events: { sunset: { eventIso: EVENT_ISO, azDeg: 260, beamLowPct: null, beamMidHighPct: null, antiMidHighPct: null, beamSamples: 1 } } });
    const o = resolveIrObservation({ ir: noBeam }, EVENT, NOW)!;
    // Overhead only: the path was not read, so the horizon is NOT verified.
    expect(o.horizon).toEqual({ cloudPct: 5, fresh: false });
    expect(o.horizonSource).toBe("ir-overhead");
    const wrongEvent = ir({ events: { sunset: { eventIso: "2026-10-16T22:51:00.000Z", azDeg: 260, beamLowPct: 90, beamMidHighPct: 0, antiMidHighPct: 0, beamSamples: 7 } } });
    expect(resolveIrObservation({ ir: wrongEvent }, EVENT, NOW)!.horizonSource).toBe("ir-overhead");
    expect(resolveIrObservation({ ir: ir({ events: {} }) }, EVENT, NOW)!.horizon.cloudPct).toBe(5);
  });

  it("refuses a granule older than the age limit, and one from the future", () => {
    const old = ir({ granuleStartIso: new Date(NOW - (IR_MAX_GRANULE_AGE_MINUTES + 1) * 60_000).toISOString() });
    expect(resolveIrObservation({ ir: old }, EVENT, NOW)).toBeUndefined();
    const edge = ir({ granuleStartIso: new Date(NOW - IR_MAX_GRANULE_AGE_MINUTES * 60_000).toISOString() });
    expect(resolveIrObservation({ ir: edge }, EVENT, NOW)).toBeDefined();
    const future = ir({ granuleStartIso: new Date(NOW + 10 * 60_000).toISOString() });
    expect(resolveIrObservation({ ir: future }, EVENT, NOW)).toBeUndefined();
  });

  it("speaks only for an event within the window, before or just after it", () => {
    const g = (nowMs: number) => ({ ir: ir({ granuleStartIso: new Date(nowMs - 5 * 60_000).toISOString() }) });
    const inside = ms(EVENT_ISO) - IR_EVENT_WINDOW_MINUTES * 60_000;
    expect(resolveIrObservation(g(inside), EVENT, inside)).toBeDefined();
    const outside = inside - 60_000;
    expect(resolveIrObservation(g(outside), EVENT, outside)).toBeUndefined();
    const after = ms(EVENT_ISO) + 20 * 60_000; // still golden hour after sunset
    expect(resolveIrObservation(g(after), EVENT, after)).toBeDefined();
  });

  it("gates on the share of ALL pixels that are cloud without a height, not on the share of the cloud", () => {
    expect(resolveIrObservation({ ir: ir({ unclassifiedPct: IR_MAX_UNCLASSIFIED_PCT + 1, classifiedPct: 70 }) }, EVENT, NOW)).toBeUndefined();
    expect(resolveIrObservation({ ir: ir({ unclassifiedPct: IR_MAX_UNCLASSIFIED_PCT }) }, EVENT, NOW)).toBeDefined();
    // A 2% cloud box whose few cloudy pixels have no height (0% classified) still counts: Miami at sunrise.
    const miami = ir({ lowPct: 0, midPct: 0, highPct: 0, irCloudPct: 2, unclassifiedPct: 2, classifiedPct: 0 });
    expect(resolveIrObservation({ ir: miami }, EVENT, NOW)).toBeDefined();
    expect(resolveIrObservation({ ir: ir({ classifiedPct: null, unclassifiedPct: 0, irCloudPct: 0, lowPct: 0, midPct: 0, highPct: 0 }) }, EVENT, NOW)).toBeDefined();
  });

  it("keeps a read that is up to 35 minutes old: the age the app really sees near the end of a cycle", () => {
    expect(IR_MAX_GRANULE_AGE_MINUTES).toBe(35);
    for (const age of [5, 15, 30, 35]) {
      const g = ir({ granuleStartIso: new Date(NOW - age * 60_000).toISOString() });
      expect(resolveIrObservation({ ir: g }, EVENT, NOW), `${age} min`).toBeDefined();
    }
  });

  it("is undefined with no IR read at all (old feed, no pixels, no goes)", () => {
    expect(resolveIrObservation({ status: "ok", cloudPct: 20 }, EVENT, NOW)).toBeUndefined();
    expect(resolveIrObservation({ ir: null }, EVENT, NOW)).toBeUndefined();
    expect(resolveIrObservation(null, EVENT, NOW)).toBeUndefined();
    expect(resolveIrObservation(undefined, EVENT, NOW)).toBeUndefined();
  });
});

describe("assembleSunEventQuality — source selection", () => {
  const NOW = ms(minutesBefore(EVENT_ISO, 30));
  const sunset = { event: "sunset" as const, timeIso: EVENT_ISO };

  it("a fresh IR read beats a forecast that sees nothing: the sky the satellite sees is scored", () => {
    const withIr = assembleSunEventQuality(sunset, { hourly: EMPTY_FORECAST, goesCloud: { status: "ok", ir: ir() }, nowMs: NOW });
    const without = assembleSunEventQuality(sunset, { hourly: EMPTY_FORECAST, goesCloud: { status: "ok" }, nowMs: NOW });
    expect(withIr.source).toBe("satellite-ir");
    expect(without.source).toBe("forecast");
    expect(withIr.cloud).toEqual({ lowPct: 5, midPct: 45, highPct: 10, totalPct: 60 });
    expect(without.cloud).toEqual({ lowPct: 0, midPct: 0, highPct: 0, totalPct: 0 });
    expect(withIr.result.score!).toBeGreaterThan(without.result.score! + 20);
    expect(withIr.result.band).toBe("vivid");
    expect(without.result.band).toBe("good"); // a clear sky is a clean Good since 2026-11-05.1
    // verified horizon, and the source is in the breakdown the archive stores
    expect(withIr.result.breakdown!.horizonPath).toMatch(/satellite/);
    expect(withIr.result.breakdown!.source).toBe("satellite-ir");
    expect(without.result.breakdown!.source).toBe("forecast");
    expect(without.result.breakdown!.horizonPath).toMatch(/unverified/);
    expect(withIr.horizon).toEqual({ cloudPct: 6, fresh: true });
    expect(withIr.horizonSource).toBe("ir-beam");
  });

  it("a low deck on the sun's path lowers the score even though the forecast is clear", () => {
    const blocked = ir({ events: { sunset: { eventIso: EVENT_ISO, azDeg: 260, beamLowPct: 90, beamMidHighPct: 5, antiMidHighPct: 5, beamSamples: 7 } } });
    const open = assembleSunEventQuality(sunset, { hourly: EMPTY_FORECAST, goesCloud: { ir: ir() }, nowMs: NOW });
    const shut = assembleSunEventQuality(sunset, { hourly: EMPTY_FORECAST, goesCloud: { ir: blocked }, nowMs: NOW });
    // Low cloud in the path costs at most a quarter since 2026-11-05.1: lit low cloud can glow.
    expect(shut.result.score!).toBeLessThan(open.result.score!);
    expect(shut.result.score!).toBeGreaterThanOrEqual(Math.round(open.result.score! * 0.75) - 1);
  });

  it("falls back to the forecast when the IR read is stale, far from the event, or low quality", () => {
    const forecast: HourlyCloudPoint[] = [{ time: "2026-10-15T23:00:00.000Z", cloud: { lowPct: 10, midPct: 40, highPct: 20, totalPct: 55 }, humidityPct: 60 }];
    const stale = ir({ granuleStartIso: minutesBefore(EVENT_ISO, 120) });
    const lowQ = ir({ unclassifiedPct: 40, classifiedPct: 10 });
    for (const [goes, nowMs] of [
      [{ ir: stale }, NOW],
      [{ ir: ir() }, ms(minutesBefore(EVENT_ISO, 180))],
      [{ ir: lowQ }, NOW],
    ] as const) {
      const a = assembleSunEventQuality(sunset, { hourly: forecast, goesCloud: goes, nowMs });
      expect(a.source).toBe("forecast");
      expect(a.ir).toBeUndefined();
      expect(a.cloud).toEqual(forecast[0].cloud);
    }
  });

  it("the old mask horizon stays recorded but unscored when there is no IR", () => {
    const forecast: HourlyCloudPoint[] = [{ time: "2026-10-15T23:00:00.000Z", cloud: { lowPct: 0, midPct: 45, highPct: 10, totalPct: 50 } }];
    const a = assembleSunEventQuality(sunset, { hourly: forecast, goesCloud: { status: "ok", cloudPct: 95, beamCloudPct: null }, nowMs: NOW });
    const plain = assembleSunEventQuality(sunset, { hourly: forecast, nowMs: NOW });
    expect(a.horizon).toEqual({ cloudPct: 95, fresh: true });
    expect(a.horizonSource).toBe("overhead");
    expect(a.result.score).toBe(plain.result.score);
  });

  it("has no source when there is neither a satellite read nor a forecast", () => {
    const a = assembleSunEventQuality(sunset, { hourly: [], nowMs: NOW });
    expect(a.source).toBeNull();
    expect(a.result.score).toBeNull();
  });

  it("predictNextSunEvent (the push alert) scores off the same satellite read", () => {
    const base = scorableResponse();
    const res = {
      ...base,
      snapshot: {
        ...base.snapshot,
        generatedAt: new Date(NOW).toISOString(),
        sun: { ...base.snapshot.sun, data: { date: "2026-10-15", sunrise: "2026-10-15T11:19:37Z", sunset: EVENT_ISO, tomorrowSunrise: "2026-10-16T11:20:00Z" } },
        hourly: { ...base.snapshot.hourly, status: "ok", data: [{ time: "2026-10-15T23:00:00.000Z", cloudCoverLowPct: 0, cloudCoverMidPct: 0, cloudCoverHighPct: 0, cloudCoverPct: 0 }] },
        goesCloud: { ...base.snapshot.goesCloud, status: "ok", data: { cloudPct: 60, validPixels: 49, totalPixels: 49, granuleAgeMinutes: 10, granuleStartIso: minutesBefore(EVENT_ISO, 40), ir: ir() } },
      },
    } as unknown as ConditionsResponse;
    const pred = predictNextSunEvent(res, NOW)!;
    expect(pred.kind).toBe("sunset");
    expect(pred.band).toBe("vivid");
    const noIr = { ...res, snapshot: { ...res.snapshot, goesCloud: { ...res.snapshot.goesCloud, data: { ...res.snapshot.goesCloud.data!, ir: null } } } } as ConditionsResponse;
    expect(predictNextSunEvent(noIr, NOW)!.band).toBe("good"); // the forecast's clear sky
  });
});

describe("assembleSunEventQuality — the early look (120 to 60 min before the event)", () => {
  const sunset = { event: "sunset" as const, timeIso: EVENT_ISO };
  const at = (min: number) => ms(minutesBefore(EVENT_ISO, min));
  /** A scan 15 min old at `min` minutes before the event. */
  const irAt = (min: number, over: Partial<GoesIrData> = {}) => ir({ granuleStartIso: minutesBefore(EVENT_ISO, min + 15), ...over });
  const OVERCAST_FORECAST: HourlyCloudPoint[] = [
    { time: "2026-10-15T23:00:00.000Z", cloud: { lowPct: 20, midPct: 90, highPct: 90, totalPct: 100 }, humidityPct: 70 },
  ];
  const satAlone = sunEventQuality({ cloud: { lowPct: 5, midPct: 45, highPct: 10, totalPct: 60 }, humidityPct: 70, horizon: { cloudPct: 6, fresh: true } });

  it("is the mean of the satellite's score and the forecast's score, from the same model", () => {
    const a = assembleSunEventQuality(sunset, { hourly: EMPTY_FORECAST, goesCloud: { ir: irAt(90) }, nowMs: at(90) });
    const fc = sunEventQuality({ cloud: EMPTY_FORECAST[0].cloud, humidityPct: 70 });
    expect(a.source).toBe("satellite+forecast");
    expect(a.result.score).toBe(Math.round((satAlone.score! + fc.score!) / 2));
    expect(a.result.score!).toBeLessThan(satAlone.score!);
    expect(a.result.score!).toBeGreaterThan(fc.score!);
    // The band follows the mean, and both halves are recorded for the archive.
    expect(a.result.band).toBe("vivid");
    expect(a.result.breakdown!.source).toBe("satellite+forecast");
    expect(a.result.breakdown!.early).toEqual({
      satelliteScore: satAlone.score,
      forecastScore: fc.score,
      forecastCloud: { lowPct: 0, midPct: 0, highPct: 0, totalPct: 0 },
    });
    expect(a.result.breakdown!.satellite!.granuleAgeMinutes).toBe(15);
    // The cloud columns hold the satellite's mix; the horizon is its path read.
    expect(a.cloud).toEqual({ lowPct: 5, midPct: 45, highPct: 10, totalPct: 60 });
    expect(a.horizon).toEqual({ cloudPct: 6, fresh: true });
  });

  it("covers the whole 120-60 min span, and hands over to the satellite alone at 60", () => {
    for (const min of [IR_EARLY_WINDOW_MINUTES, 100, 61]) {
      const a = assembleSunEventQuality(sunset, { hourly: EMPTY_FORECAST, goesCloud: { ir: irAt(min) }, nowMs: at(min) });
      expect(a.source, `${min} min`).toBe("satellite+forecast");
    }
    const firm = assembleSunEventQuality(sunset, { hourly: EMPTY_FORECAST, goesCloud: { ir: irAt(60) }, nowMs: at(IR_EVENT_WINDOW_MINUTES) });
    expect(firm.source).toBe("satellite-ir");
    expect(firm.result.score).toBe(satAlone.score);
    expect(firm.result.breakdown!.early).toBeUndefined();
  });

  it("before 120 min the satellite does not speak: the forecast stands alone, as before", () => {
    const a = assembleSunEventQuality(sunset, { hourly: EMPTY_FORECAST, goesCloud: { ir: irAt(121) }, nowMs: at(121) });
    expect(a.source).toBe("forecast");
    expect(a.ir).toBeUndefined();
    expect(a.result.breakdown!.early).toBeUndefined();
  });

  it("needs a fresh scan: a stale or low-quality read leaves the forecast alone", () => {
    const stale = ir({ granuleStartIso: minutesBefore(EVENT_ISO, 90 + IR_MAX_GRANULE_AGE_MINUTES + 1) });
    const lowQ = irAt(90, { unclassifiedPct: 40, classifiedPct: 10 });
    for (const goes of [{ ir: stale }, { ir: lowQ }, { status: "ok" }]) {
      const a = assembleSunEventQuality(sunset, { hourly: OVERCAST_FORECAST, goesCloud: goes, nowMs: at(90) });
      expect(a.source).toBe("forecast");
      expect(a.cloud).toEqual(OVERCAST_FORECAST[0].cloud);
    }
  });

  it("with no forecast to average with, there is no early satellite score either", () => {
    const a = assembleSunEventQuality(sunset, { hourly: [], goesCloud: { ir: irAt(90) }, nowMs: at(90) });
    expect(a.source).toBeNull();
    expect(a.result.score).toBeNull();
  });

  it("never applies after the event: the satellite alone speaks for the minutes after it", () => {
    const after = ms(EVENT_ISO) + 20 * 60_000;
    const a = assembleSunEventQuality(sunset, { hourly: EMPTY_FORECAST, goesCloud: { ir: ir({ granuleStartIso: minutesBefore(EVENT_ISO, 0) }) }, nowMs: after });
    expect(a.source).toBe("satellite-ir");
  });

  it("when the two halves are far apart the note says it is a middle guess, in plain words", () => {
    const a = assembleSunEventQuality(sunset, { hourly: OVERCAST_FORECAST, goesCloud: { ir: irAt(90) }, nowMs: at(90) });
    const { satelliteScore, forecastScore } = a.result.breakdown!.early!;
    expect(satelliteScore - forecastScore).toBeGreaterThanOrEqual(EARLY_LOOK_DISAGREE_PTS);
    expect(a.result.note).toMatch(/middle guess/);
    expect(a.result.note).toMatch(/better now than the hourly forecast expects/);
    expect(a.result.note).not.toMatch(/color forecast|\bAI\b/);
    // Close halves keep the satellite's own note.
    const close = assembleSunEventQuality(sunset, { hourly: [{ time: "2026-10-15T23:00:00.000Z", cloud: { lowPct: 5, midPct: 40, highPct: 10, totalPct: 55 }, humidityPct: 70 }], goesCloud: { ir: irAt(90) }, nowMs: at(90) });
    expect(close.result.note).toBe(satAlone.note);
  });
});

describe("overhead-only IR read: not a verified horizon", () => {
  const NOW = ms(minutesBefore(EVENT_ISO, 30));
  const sunset = { event: "sunset" as const, timeIso: EVENT_ISO };
  const noPath = ir({ lowPct: 40, events: {} });

  it("feeds the overhead low share as the CloudMix and leaves the horizon unverified", () => {
    const a = assembleSunEventQuality(sunset, { hourly: EMPTY_FORECAST, goesCloud: { ir: noPath }, nowMs: NOW });
    expect(a.source).toBe("satellite-ir");
    expect(a.cloud!.lowPct).toBe(40);
    expect(a.horizon).toEqual({ cloudPct: 40, fresh: false });
    expect(a.horizonSource).toBe("ir-overhead");
    expect(a.result.breakdown!.horizonPath).toMatch(/satellite overhead; path not read/);
    expect(a.result.breakdown!.horizonPath).not.toMatch(/\(satellite\)$/);
    expect(a.result.breakdown!.satellite!.horizon).toBe("ir-overhead");
    // The clear path is the forecast-style estimate from that low share, not 100 - 40.
    const withPath = assembleSunEventQuality(sunset, { hourly: EMPTY_FORECAST, goesCloud: { ir: ir({ lowPct: 40 }) }, nowMs: NOW });
    expect(withPath.result.breakdown!.horizonPath).toMatch(/\(satellite\)$/);
  });
});

describe("sunColorLiveGuard — the alert reads the live clock", () => {
  const pred = (over: Record<string, unknown> = {}) => ({ eventIso: EVENT_ISO, score: 80, source: "forecast" as const, irGranuleStartIso: null, ...over });
  const live = ms(minutesBefore(EVENT_ISO, 30));
  const builtHoursEarlier = ms(minutesBefore(EVENT_ISO, 240));

  it("skips a forecast score from a snapshot built before the satellite window, once the window is open", () => {
    expect(sunColorLiveGuard(pred(), live, builtHoursEarlier)).toMatch(/stale forecast/);
    expect(sunColorLiveGuard(pred(), ms(minutesBefore(EVENT_ISO, IR_EVENT_WINDOW_MINUTES)), builtHoursEarlier)).toMatch(/stale forecast/);
  });
  it("skips an early look the same way: built before the satellite window, read inside it", () => {
    const early = pred({ source: "satellite+forecast", irGranuleStartIso: minutesBefore(EVENT_ISO, 100) });
    expect(sunColorLiveGuard(early, live, ms(minutesBefore(EVENT_ISO, 90)))).toMatch(/stale forecast/);
  });
  it("lets a forecast score through while the event is still far out on the live clock", () => {
    expect(sunColorLiveGuard(pred(), ms(minutesBefore(EVENT_ISO, IR_EVENT_WINDOW_MINUTES + 30)), builtHoursEarlier)).toBeNull();
  });
  it("lets a forecast score through when the snapshot was built INSIDE the window (feed down: degrade, not skip)", () => {
    expect(sunColorLiveGuard(pred(), live, ms(minutesBefore(EVENT_ISO, 35)))).toBeNull();
  });
  it("lets a fresh satellite score through, skips one whose read aged out on the live clock", () => {
    expect(sunColorLiveGuard(pred({ source: "satellite-ir", irGranuleStartIso: minutesBefore(EVENT_ISO, 40) }), live, live)).toBeNull();
    expect(sunColorLiveGuard(pred({ source: "satellite-ir", irGranuleStartIso: minutesBefore(EVENT_ISO, 90) }), live, live)).toMatch(/too old/);
  });
  it("has nothing to guard without a score, or with an unreadable snapshot clock", () => {
    expect(sunColorLiveGuard(null, live, live)).toBeNull();
    expect(sunColorLiveGuard(pred({ score: null }), live, builtHoursEarlier)).toBeNull();
    expect(sunColorLiveGuard(pred(), live, Number.NaN)).toBeNull();
  });
});
