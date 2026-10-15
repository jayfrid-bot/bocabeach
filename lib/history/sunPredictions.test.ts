import { describe, it, expect } from "vitest";
import { getLocation } from "@/config/locations";
import { scorableResponse } from "@/lib/alerts/fixtures";
import { computeSunTimes } from "@/lib/sources/sun";
import { sunEventRowsFromConditions, nextSunEventsBoth } from "@/lib/history/sunPredictions";
import { SUN_QUALITY_VERSION, sunEventQuality, sunModelPath } from "@/lib/sunQuality";
import { resolveSunHorizonDetailed, resolveSunHorizon, predictNextSunEvent } from "@/lib/sunAlert";
import { sunCardTiming } from "@/lib/sunCardEvent";
import type { ConditionsResponse, GoesIrData } from "@/lib/types";

const boca = getLocation("boca-raton")!;
const wrap = <T,>(data: T) => ({ source: "test", status: "ok" as const, fetchedAt: "", attribution: "test", data });

/**
 * 2026-10-06, Boca Raton. The app rated a ~90th-percentile sunrise only
 * "Good" and nothing about the shown score had been stored. Inputs as
 * reported: 7 AM hour low 0 / mid 67 / high 48 / total 67, RH 87, AOD 0.14,
 * PM2.5 13.6; sunrise 07:15 EDT = 11:15Z; satellite beamCloudPct is null below
 * 5 deg sun elevation, so resolveSunHorizon falls back to overhead cloudPct.
 */
function bocaOct6(generatedAt = "2026-10-06T11:05:00.000Z"): ConditionsResponse {
  const base = scorableResponse();
  const t = computeSunTimes(boca.lat, boca.lon, 2026, 10, 6);
  const tm = computeSunTimes(boca.lat, boca.lon, 2026, 10, 7);
  return {
    ...base,
    snapshot: {
      ...base.snapshot,
      generatedAt,
      sun: wrap({
        date: "2026-10-06",
        sunrise: "2026-10-06T11:15:00.000Z",
        sunset: t.sunset!.toISOString(),
        goldenEvePeakIso: t.goldenEvePeak!.toISOString(),
        goldenAmPeakIso: t.goldenAmPeak!.toISOString(),
        tomorrowSunrise: tm.sunrise!.toISOString(),
        tomorrowGoldenAmPeakIso: tm.goldenAmPeak!.toISOString(),
      }),
      hourly: wrap([
        {
          time: "2026-10-06T11:00:00.000Z",
          cloudCoverLowPct: 0,
          cloudCoverMidPct: 67,
          cloudCoverHighPct: 48,
          cloudCoverPct: 67,
          humidityPct: 87,
        },
      ]),
      airQuality: wrap({ aod: 0.14, pm2_5: 13.6 }),
      goesCloud: wrap({ cloudPct: 40, beamCloudPct: null, validPixels: 90, totalPixels: 100 }),
    },
  } as unknown as ConditionsResponse;
}

describe("sunEventRowsFromConditions — 2026-10-06 Boca sunrise fixture", () => {
  const res = bocaOct6();
  const rows = sunEventRowsFromConditions(res, boca, Date.parse("2026-10-06T11:20:00Z"), {
    hourUtc: "2026-10-06T11:00:00.000Z",
  });
  const sunrise = rows.find((r) => r.event_kind === "sunrise")!;
  const sunset = rows.find((r) => r.event_kind === "sunset")!;

  it("produces one row for the next sunrise and one for the next sunset", () => {
    expect(rows).toHaveLength(2);
    expect(sunrise.event_iso).toBe("2026-10-06T11:15:00.000Z");
    expect(sunset.event_iso).toBe(res.snapshot.sun.data!.sunset);
    expect(sunrise.slug).toBe("boca-raton");
    expect(sunrise.as_of_hour_utc).toBe("2026-10-06T11:00:00.000Z");
    expect(sunrise.lead_minutes).toBe(10);
  });

  it("records every input the model used, as handed to it", () => {
    expect(sunrise.low_cloud_pct).toBe(0);
    expect(sunrise.mid_cloud_pct).toBe(67);
    expect(sunrise.high_cloud_pct).toBe(48);
    expect(sunrise.total_cloud_pct).toBe(67);
    expect(sunrise.humidity_pct).toBe(87);
    expect(sunrise.aod).toBe(0.14);
    expect(sunrise.pm2_5).toBe(13.6);
    expect(sunrise.point_time).toBe("2026-10-06T11:00:00.000Z");
  });

  it("records the overhead-cloudPct fallback (beamCloudPct null) as a fresh horizon", () => {
    expect(sunrise.horizon_cloud_pct).toBe(40);
    expect(sunrise.horizon_source).toBe("overhead");
    expect(sunrise.horizon_fresh).toBe(1);
  });

  it("records the factor model path, seasonal prior, versions, and a breakdown", () => {
    expect(sunrise.model_path).toBe("factor");
    expect(sunrise.seasonal_prior).toBe(55);
    expect(sunrise.algo_version).toBe(SUN_QUALITY_VERSION);
    expect(SUN_QUALITY_VERSION).toBe("2026-10-15.1");
    expect(sunrise.engine_version).toBeTruthy();
    expect(JSON.parse(sunrise.breakdown_json!)).toHaveProperty("horizonPath");
    expect(sunrise.note).toBeTruthy();
  });

  it("stores exactly the score/band the shared model produces for those inputs", () => {
    const direct = sunEventQuality({
      cloud: { lowPct: 0, midPct: 67, highPct: 48, totalPct: 67 },
      humidityPct: 87,
      aod: 0.14,
      pm2_5: 13.6,
    });
    expect(sunrise.score).toBe(direct.score);
    expect(sunrise.band).toBe(direct.band);
    expect(sunrise.score).not.toBeNull();
  });

  it("rates the 2026-10-06 sunrise Amazing — the satellite's overhead cloud is recorded, not scored", () => {
    // Ground truth: Elbo Room cam frames, docs/benchmarks/2026-10-06-sun-model.
    expect(sunrise.band).toBe("epic");
    expect(sunrise.score!).toBeGreaterThanOrEqual(90);
    expect(sunrise.horizon_source).toBe("overhead");
  });

  it("leaves the truth columns empty and records the peak-color time", () => {
    expect(sunrise.observed_score).toBeNull();
    expect(sunrise.observed_source).toBeNull();
    expect(sunrise.observed_at).toBeNull();
    expect(sunrise.peak_color_iso).toBeTruthy();
    expect(typeof sunrise.peak_offset_minutes).toBe("number");
  });

  it("has no hourly point for a sunset hours out of range: null score, null path, no horizon freshness", () => {
    // Sunset is ~12 h away: the only hourly point is >90 min off.
    expect(sunset.point_time).toBeNull();
    expect(sunset.score).toBeNull();
    expect(sunset.model_path).toBeNull();
    expect(sunset.horizon_fresh).toBe(0); // GOES reading exists but isn't imminent
    expect(sunset.horizon_source).toBe("overhead");
  });
});

describe("nextSunEventsBoth", () => {
  it("rolls both events to tomorrow once today's sunset has passed", () => {
    const res = bocaOct6("2026-10-07T00:30:00.000Z");
    const ev = nextSunEventsBoth(res, boca, Date.parse("2026-10-07T00:30:00.000Z"));
    const tm = computeSunTimes(boca.lat, boca.lon, 2026, 10, 7);
    expect(ev.map((e) => e.event).sort()).toEqual(["sunrise", "sunset"]);
    expect(ev.find((e) => e.event === "sunrise")!.timeIso).toBe(tm.sunrise!.toISOString());
    expect(ev.find((e) => e.event === "sunset")!.timeIso).toBe(tm.sunset!.toISOString());
  });

  it("keeps tonight's sunset while its golden window is still open (post-sunset), not tomorrow's", () => {
    const t = computeSunTimes(boca.lat, boca.lon, 2026, 10, 6);
    const tm = computeSunTimes(boca.lat, boca.lon, 2026, 10, 7);
    const sunsetMs = t.sunset!.getTime();
    const windowEndMs = t.goldenEveEnd!.getTime();
    expect(windowEndMs).toBeGreaterThan(sunsetMs); // the window really straddles the event
    const nowMs = sunsetMs + 10 * 60_000; // 10 min after sunset, golden hour still on
    const res = bocaOct6(new Date(nowMs).toISOString());
    const ev = nextSunEventsBoth(res, boca, nowMs);
    expect(ev.find((e) => e.event === "sunset")!.timeIso).toBe(t.sunset!.toISOString());
    expect(ev.find((e) => e.event === "sunrise")!.timeIso).toBe(tm.sunrise!.toISOString());
    // ...and the plain "next event" (the push alert's) is tomorrow's sunrise: still in the pair.
    expect(predictNextSunEvent(res, nowMs)!.eventIso).toBe(tm.sunrise!.toISOString());

    // Once the window has closed, the sunset rolls to tomorrow's.
    const after = nextSunEventsBoth(bocaOct6(new Date(windowEndMs + 60_000).toISOString()), boca, windowEndMs + 60_000);
    expect(after.find((e) => e.event === "sunset")!.timeIso).toBe(tm.sunset!.toISOString());
  });

  it("keeps this morning's sunrise through its post-sunrise golden window", () => {
    const t = computeSunTimes(boca.lat, boca.lon, 2026, 10, 6);
    const nowMs = t.sunrise!.getTime() + 10 * 60_000;
    const res = bocaOct6(new Date(nowMs).toISOString());
    // fixture pins sunrise to 11:15Z; use the real window times around it
    res.snapshot.sun.data = {
      ...res.snapshot.sun.data!,
      sunrise: t.sunrise!.toISOString(),
      goldenAmStartIso: t.goldenAmStart!.toISOString(),
      goldenAmEndIso: t.goldenAmEnd!.toISOString(),
      goldenAmPeakIso: t.goldenAmPeak!.toISOString(),
    };
    const ev = nextSunEventsBoth(res, boca, nowMs);
    expect(ev.find((e) => e.event === "sunrise")!.timeIso).toBe(t.sunrise!.toISOString());
  });

  it("matches the event the card shows, for the card's side, at every minute-ish of two days; the alert's event is always in the pair", () => {
    const base = bocaOct6();
    const t = computeSunTimes(boca.lat, boca.lon, 2026, 10, 6);
    const sun = {
      ...base.snapshot.sun.data!,
      sunrise: t.sunrise!.toISOString(),
      goldenAmStartIso: t.goldenAmStart!.toISOString(),
      goldenAmEndIso: t.goldenAmEnd!.toISOString(),
      goldenAmPeakIso: t.goldenAmPeak!.toISOString(),
      goldenEveStartIso: t.goldenEveStart!.toISOString(),
      goldenEveEndIso: t.goldenEveEnd!.toISOString(),
      tomorrowGoldenAmStartIso: computeSunTimes(boca.lat, boca.lon, 2026, 10, 7).goldenAmStart!.toISOString(),
      tomorrowGoldenAmEndIso: computeSunTimes(boca.lat, boca.lon, 2026, 10, 7).goldenAmEnd!.toISOString(),
    };
    const res = { ...base, snapshot: { ...base.snapshot, sun: { ...base.snapshot.sun, data: sun } } } as ConditionsResponse;
    const today = {
      sunrise: sun.sunrise,
      sunset: sun.sunset,
      goldenAm: { goldenStartIso: sun.goldenAmStartIso, goldenEndIso: sun.goldenAmEndIso, peakAnchorIso: sun.goldenAmPeakIso },
      goldenEve: { goldenStartIso: sun.goldenEveStartIso, goldenEndIso: sun.goldenEveEndIso, peakAnchorIso: sun.goldenEvePeakIso },
    };
    const tomorrow = {
      sunriseIso: sun.tomorrowSunrise,
      goldenAm: { goldenStartIso: sun.tomorrowGoldenAmStartIso, goldenEndIso: sun.tomorrowGoldenAmEndIso, peakAnchorIso: sun.tomorrowGoldenAmPeakIso },
    };
    const start = Date.parse("2026-10-06T04:00:00Z");
    for (let ms = start; ms < start + 24 * 3_600_000; ms += 7 * 60_000) {
      const pair = nextSunEventsBoth(res, boca, ms);
      const card = sunCardTiming({ nowD: new Date(ms), today, tomorrow }).scored!;
      const mine = pair.find((e) => e.event === card.event)!;
      expect(mine.timeIso, new Date(ms).toISOString()).toBe(card.timeIso);
      const alert = predictNextSunEvent({ ...res, snapshot: { ...res.snapshot, generatedAt: new Date(ms).toISOString() } }, ms);
      if (alert) expect(pair.map((e) => e.timeIso), new Date(ms).toISOString()).toContain(alert.eventIso);
      expect(pair.map((e) => e.event).sort()).toEqual(["sunrise", "sunset"]);
    }
  });

  it("returns nothing when the snapshot has no sun data", () => {
    const base = scorableResponse();
    const res = { ...base, snapshot: { ...base.snapshot, sun: { ...base.snapshot.sun, data: null } } } as ConditionsResponse;
    expect(nextSunEventsBoth(res, boca, Date.now())).toEqual([]);
  });
});

describe("sunModelPath", () => {
  const cloud = { lowPct: 5, midPct: 40, highPct: 20, totalPct: 50 };
  it("agrees with which branch sunEventQuality actually took", () => {
    const cases = [
      { cloud, aod: 0.1 }, // factor
      { cloud }, // level curve
      { cloud: { totalPct: 50 } }, // total only
      { cloud: { lowPct: 5 } }, // partial split, no total -> null
      { cloud: undefined },
      { cloud: { totalPct: 50 }, aod: 0.1 }, // total only even with air data
      { cloud, horizon: { cloudPct: 10, fresh: false } }, // factor
    ];
    for (const c of cases) {
      const path = sunModelPath(c);
      const q = sunEventQuality(c);
      expect(path === null).toBe(q.score === null);
      expect(path === "factor").toBe(q.breakdown !== undefined);
    }
  });
});

describe("resolveSunHorizonDetailed", () => {
  const ev = "2026-10-06T11:15:00.000Z";
  const now = Date.parse("2026-10-06T11:05:00.000Z");
  it("names beam vs overhead without changing the horizon value", () => {
    const beam = { status: "ok", cloudPct: 40, beamCloudPct: 12 };
    const over = { status: "ok", cloudPct: 40, beamCloudPct: null };
    expect(resolveSunHorizonDetailed(beam, ev, now)).toEqual({ horizon: { cloudPct: 12, fresh: true }, source: "beam" });
    expect(resolveSunHorizonDetailed(over, ev, now)).toEqual({ horizon: { cloudPct: 40, fresh: true }, source: "overhead" });
    expect(resolveSunHorizonDetailed({ status: "stale", cloudPct: 1 }, ev, now)).toEqual({ horizon: undefined, source: null });
    for (const g of [beam, over, null]) {
      expect(resolveSunHorizon(g, ev, now)).toEqual(resolveSunHorizonDetailed(g, ev, now).horizon);
    }
  });
});

/** A cloud-top read for the Boca 2026-10-06 sunrise (11:15Z): a clear
 *  horizon and a half-covered mid deck, granule 8 min before the snapshot. */
function irRead(over: Partial<GoesIrData> = {}): GoesIrData {
  return {
    lowPct: 4,
    midPct: 55,
    highPct: 10,
    irCloudPct: 70,
    unclassifiedPct: 1,
    classifiedPct: 98,
    validPixels: 225,
    totalPixels: 225,
    granuleStartIso: "2026-10-06T10:57:00.000Z",
    events: {
      sunrise: {
        eventIso: "2026-10-06T11:15:00.000Z",
        azDeg: 94,
        beamLowPct: 6,
        beamMidHighPct: 48,
        antiMidHighPct: 20,
        beamSamples: 7,
      },
    },
    ...over,
  };
}

describe("sunEventRowsFromConditions — which source fed the model is archived", () => {
  const withIr = (ir: GoesIrData | null) => {
    const res = bocaOct6();
    res.snapshot.goesCloud = wrap({ cloudPct: 40, beamCloudPct: null, validPixels: 90, totalPixels: 100, granuleAgeMinutes: 8, granuleStartIso: "2026-10-06T10:57:00.000Z", ir });
    return sunEventRowsFromConditions(res, boca, Date.parse("2026-10-06T11:20:00Z"), { hourUtc: "2026-10-06T11:00:00.000Z" }).find(
      (r) => r.event_kind === "sunrise",
    )!;
  };

  it("a fresh cloud-top read feeds the model: source, inputs and horizon are the satellite's", () => {
    const row = withIr(irRead());
    expect(JSON.parse(row.breakdown_json!).source).toBe("satellite-ir");
    expect(JSON.parse(row.breakdown_json!).satellite).toMatchObject({ horizon: "ir-beam", granuleStartIso: "2026-10-06T10:57:00.000Z", granuleAgeMinutes: 8, sunwardMidHighPct: 48, antiMidHighPct: 20 });
    // The inputs columns hold what the model was handed (the IR mix), not the forecast's.
    expect([row.low_cloud_pct, row.mid_cloud_pct, row.high_cloud_pct, row.total_cloud_pct]).toEqual([4, 55, 10, 70]);
    expect(row.horizon_cloud_pct).toBe(6);
    expect(row.horizon_source).toBe("ir-beam");
    expect(row.horizon_fresh).toBe(1);
    expect(row.model_path).toBe("factor");
    expect(JSON.parse(row.breakdown_json!).horizonPath).toMatch(/satellite/);
    // The forecast point is still looked up (humidity, point_time).
    expect(row.humidity_pct).toBe(87);
    expect(row.point_time).toBe("2026-10-06T11:00:00.000Z");
  });

  it("stores exactly the score the shared model gives for the satellite inputs", () => {
    const row = withIr(irRead());
    const direct = sunEventQuality({
      cloud: { lowPct: 4, midPct: 55, highPct: 10, totalPct: 70 },
      humidityPct: 87,
      aod: 0.14,
      pm2_5: 13.6,
      horizon: { cloudPct: 6, fresh: true },
    });
    expect(row.score).toBe(direct.score);
    expect(row.band).toBe(direct.band);
  });

  it("without an IR read the forecast feeds it and the row says so", () => {
    for (const ir of [null, undefined as unknown as null]) {
      const row = withIr(ir);
      expect(JSON.parse(row.breakdown_json!).source).toBe("forecast");
      expect(JSON.parse(row.breakdown_json!)).not.toHaveProperty("satellite");
      expect([row.low_cloud_pct, row.mid_cloud_pct, row.high_cloud_pct]).toEqual([0, 67, 48]);
      expect(row.horizon_source).toBe("overhead"); // the mask horizon: recorded, not scored
    }
  });

  it("a granule more than 20 minutes old falls back to the forecast", () => {
    const row = withIr(irRead({ granuleStartIso: "2026-10-06T10:30:00.000Z" }));
    expect(JSON.parse(row.breakdown_json!).source).toBe("forecast");
    expect(row.mid_cloud_pct).toBe(67);
  });

  it("an event more than 60 minutes away falls back to the forecast (the sunset hours out)", () => {
    const res = bocaOct6();
    res.snapshot.goesCloud = wrap({ cloudPct: 40, beamCloudPct: null, validPixels: 90, totalPixels: 100, granuleAgeMinutes: 8, granuleStartIso: "2026-10-06T10:57:00.000Z", ir: irRead() });
    const rows = sunEventRowsFromConditions(res, boca, Date.parse("2026-10-06T11:20:00Z"), { hourUtc: "2026-10-06T11:00:00.000Z" });
    const sunset = rows.find((r) => r.event_kind === "sunset")!;
    expect(sunset.breakdown_json).toBeNull(); // no forecast point near the sunset either: nothing scored
    expect(sunset.score).toBeNull();
    expect(sunset.horizon_source).toBe("overhead");
  });
});
