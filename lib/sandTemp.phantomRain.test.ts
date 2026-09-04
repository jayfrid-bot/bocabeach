// 2026-09-04, Boca, ~3:10 PM: IR ground truth 130°F (140°F at 1 PM). The app said
// 94°F. Three stacked INPUT faults, none of them the sand physics — see the
// calibration ledger in lib/sandTemp.ts. This fixture is that afternoon's live
// snapshot, verbatim. Every test here pins one of the three faults.
import { describe, expect, it } from "vitest";
import { currentSandTempF } from "@/lib/sandTemp";
import { applyBeachCaps, deriveMetrics } from "@/lib/score";
import { overlaySatelliteRadiation } from "@/lib/sources/hourlyForecast";
import type { ConditionsSnapshot, HourlyMetrics } from "@/lib/types";
import fixture from "./__fixtures__/boca-2026-09-04-phantom-rain.json";

const snap = () => JSON.parse(JSON.stringify(fixture.snapshot)) as ConditionsSnapshot;
const NOW = Date.parse(fixture.snapshot.generatedAt); // 3:09 PM ET
const ONE_PM = NOW - 2 * 3600_000 - 10 * 60_000;
const LON = fixture.snapshot.location.lon;

/** The fixture predates the `solarObserved` flag; mark elapsed hours the way the
 *  overlay now does, so the sand model can tell observations from forecasts. */
function withObservedFlags(s: ConditionsSnapshot): ConditionsSnapshot {
  for (const b of s.hourly.data ?? []) {
    if (Date.parse(b.time) + 3600_000 <= NOW) b.solarObserved = true;
  }
  return s;
}

describe("phantom forecast rain must not soak the sand model", () => {
  it("regression anchor: the shipped inputs reproduce the 94°F miss", () => {
    const hours = fixture.snapshot.hourly.data as HourlyMetrics[]; // no flags, no radar
    expect(currentSandTempF(hours, NOW, { cloudCoverPct: 98, cloudIsBeamPath: true }, LON)).toBe(94);
  });

  it("with observed flags + a dry radar, the estimate lands in the measured band", () => {
    const s = withObservedFlags(snap());
    const t = currentSandTempF(
      s.hourly.data!,
      NOW,
      { cloudCoverPct: 98, cloudIsBeamPath: true, radarDryNow: true },
      LON,
    );
    // Measured 130 at 3:10 PM, 140 at 1 PM. Anything in the hot band is a win
    // over 94; the exact number is not pinned so a curve retune cannot break this.
    expect(t).toBeGreaterThanOrEqual(118);
    expect(t).toBeLessThanOrEqual(145);
  });

  it("an hour the satellite saw bright contributes no forecast rain, radar or not", () => {
    const s = withObservedFlags(snap());
    // Radar NOT dry: no carry-forward, mask damping still applies — but the 2 PM
    // phantom 1.72 in is still discarded, so the wet-sand x0.3 never fires.
    const t = currentSandTempF(
      s.hourly.data!,
      NOW,
      { cloudCoverPct: 98, cloudIsBeamPath: true, radarDryNow: false },
      LON,
    )!;
    expect(t).toBeGreaterThan(94); // the phantom shower alone was worth the gap
    expect(t).toBeLessThan(118); // and without the carry the forecast 257 W/m² still starves it
  });

  it("an observed hour is unchanged by the new path (1 PM: 133 vs measured 140)", () => {
    const s = withObservedFlags(snap());
    const t = currentSandTempF(s.hourly.data!, ONE_PM, { cloudCoverPct: 72, radarDryNow: true }, LON);
    expect(t).toBeGreaterThanOrEqual(131);
    expect(t).toBeLessThanOrEqual(136);
  });

  it("deriveMetrics reads the fixture's dry radar frame and lifts the sand estimate", () => {
    const s = withObservedFlags(snap());
    const d = deriveMetrics(s, NOW);
    expect(d.radarDryNow).toBe(true);
    expect(d.sandTempF).toBeGreaterThanOrEqual(118);
    expect(d.nowcastRaining).toBeFalsy();
  });

  it("a stale or wet radar frame does not veto", () => {
    const stale = withObservedFlags(snap());
    stale.precipRadar!.data!.frameAgeMinutes = 40;
    expect(deriveMetrics(stale, NOW).radarDryNow).toBe(false);
    const wet = withObservedFlags(snap());
    wet.precipRadar!.data!.rainNowMmHr = 2.5;
    expect(deriveMetrics(wet, NOW).radarDryNow).toBe(false);
    const near = withObservedFlags(snap());
    near.precipRadar!.data!.nearestRainKm = 3;
    expect(deriveMetrics(near, NOW).radarDryNow).toBe(false);
  });
});

describe("a dry radar frame vetoes the forecast rain cap, never the thunder cap", () => {
  const base = () => ({ ...deriveMetrics(withObservedFlags(snap()), NOW), weatherCode: 82, precipProbability: 33 });

  it("code 82 'rain showers' with radar dry: no rain cap", () => {
    const { caps } = applyBeachCaps(90, { ...base(), radarDryNow: true });
    expect(caps.some((c) => /rain/i.test(c))).toBe(false);
  });

  it("the same code with radar wet or absent still caps", () => {
    const { caps, score } = applyBeachCaps(90, { ...base(), radarDryNow: false });
    expect(caps).toContain("Rain in the forecast");
    expect(score).toBe(25);
  });

  it("thunder is the lightning feed's call, not the radar's", () => {
    const { caps } = applyBeachCaps(90, { ...base(), weatherCode: 95, radarDryNow: true });
    expect(caps).toContain("Thunderstorm in the forecast");
  });
});

describe("overlaySatelliteRadiation marks the hours it observed", () => {
  it("flags elapsed hours only", () => {
    const t0 = Date.parse("2026-09-04T16:00:00.000Z");
    const hours: HourlyMetrics[] = [0, 1, 2].map((i) => ({
      time: new Date(t0 + i * 3600_000).toISOString(),
      solarWm2: 300,
    }));
    const now = t0 + 2 * 3600_000 + 9 * 60_000; // inside the third hour
    overlaySatelliteRadiation(
      hours,
      { time: ["2026-09-04T16:00", "2026-09-04T17:00", "2026-09-04T18:00"], shortwave_radiation: [759, 849, 853] },
      now,
    );
    expect(hours[0]).toMatchObject({ solarWm2: 759, solarObserved: true });
    expect(hours[1]).toMatchObject({ solarWm2: 849, solarObserved: true });
    expect(hours[2].solarWm2).toBe(300); // current hour: forecast stands
    expect(hours[2].solarObserved).toBeUndefined();
  });
});
