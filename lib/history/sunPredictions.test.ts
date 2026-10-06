import { describe, it, expect } from "vitest";
import { getLocation } from "@/config/locations";
import { scorableResponse } from "@/lib/alerts/fixtures";
import { computeSunTimes } from "@/lib/sources/sun";
import { sunEventRowsFromConditions, nextSunEventsBoth } from "@/lib/history/sunPredictions";
import { SUN_QUALITY_VERSION, sunEventQuality, sunModelPath } from "@/lib/sunQuality";
import { resolveSunHorizonDetailed, resolveSunHorizon } from "@/lib/sunAlert";
import type { ConditionsResponse } from "@/lib/types";

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
    expect(SUN_QUALITY_VERSION).toBe("2026-10-06.1");
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
      horizon: { cloudPct: 40, fresh: true },
    });
    expect(sunrise.score).toBe(direct.score);
    expect(sunrise.band).toBe(direct.band);
    expect(sunrise.score).not.toBeNull();
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
