// predictNextSunEvent (the assembly components/SunQualityCard.tsx and the
// "sun-color" push alert both read off) against a fixture ConditionsResponse
// — never a network call, never a real snapshot.

import { describe, it, expect } from "vitest";
import { predictNextSunEvent, resolveSunHorizon, sunQualityHourlyPoints, BEAM_IMMINENT_MINUTES } from "@/lib/sunAlert";
import { FIXTURE_SUNRISE, FIXTURE_SUNSET, scorableResponse } from "@/lib/alerts/fixtures";
import type { ConditionsResponse } from "@/lib/types";

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
