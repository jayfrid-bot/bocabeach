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
  IR_EVENT_WINDOW_MINUTES,
  IR_MAX_GRANULE_AGE_MINUTES,
  IR_MIN_CLASSIFIED_PCT,
} from "@/lib/sunAlert";
import type { HourlyCloudPoint } from "@/lib/sunQuality";
import { FIXTURE_SUNRISE, FIXTURE_SUNSET, scorableResponse } from "@/lib/alerts/fixtures";
import type { ConditionsResponse, GoesIrData } from "@/lib/types";

// 2 PM ET on the fixture's own day — after FIXTURE_SUNRISE (6:45 AM ET),
// before FIXTURE_SUNSET (7:35 PM ET), so the next event is today's sunset.
const NOW_MS = Date.parse("2026-09-02T18:00:00Z");

/** A vivid-but-not-epic cloud mix at the exact sunset hour: low 10% (under
 *  the 20% "costs nothing" bar), mid 35% + high 10% — a deck a little under
 *  the canvas plateau, landing in the factor model's 70-89 ("vivid"/"Great")
 *  range, short of 90 ("epic"). */
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

  it("a heavier mid/high deck (still under the low-cloud bar) scores into the epic/Amazing range", () => {
    const res = withVividHourly();
    res.snapshot.hourly.data = [
      { time: FIXTURE_SUNSET, cloudCoverLowPct: 10, cloudCoverMidPct: 50, cloudCoverHighPct: 40 },
    ];
    const pred = predictNextSunEvent(res, NOW_MS);
    expect(pred?.score).toBeGreaterThanOrEqual(90);
    expect(pred?.band).toBe("epic");
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
    expect(o.horizon).toEqual({ cloudPct: 5, fresh: true });
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

  it("refuses a read whose cloud mostly has no height, but accepts a clear box", () => {
    expect(resolveIrObservation({ ir: ir({ classifiedPct: IR_MIN_CLASSIFIED_PCT - 1 }) }, EVENT, NOW)).toBeUndefined();
    expect(resolveIrObservation({ ir: ir({ classifiedPct: IR_MIN_CLASSIFIED_PCT }) }, EVENT, NOW)).toBeDefined();
    expect(resolveIrObservation({ ir: ir({ classifiedPct: null, irCloudPct: 0, lowPct: 0, midPct: 0, highPct: 0 }) }, EVENT, NOW)).toBeDefined();
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
    expect(without.result.band).toBe("plain");
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
    expect(shut.result.score!).toBeLessThan(open.result.score! / 2);
  });

  it("falls back to the forecast when the IR read is stale, far from the event, or low quality", () => {
    const forecast: HourlyCloudPoint[] = [{ time: "2026-10-15T23:00:00.000Z", cloud: { lowPct: 10, midPct: 40, highPct: 20, totalPct: 55 }, humidityPct: 60 }];
    const stale = ir({ granuleStartIso: minutesBefore(EVENT_ISO, 90) });
    const lowQ = ir({ classifiedPct: 10 });
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
    expect(predictNextSunEvent(noIr, NOW)!.band).toBe("plain");
  });
});
