// 2026-09-08, Boca, ~11:40 AM: IR ground truth 117 / 120 / 122°F under "a little
// overcast, the sun just peeked out from patchy cloud". The app said 126°F. The
// carry rule brought the 10 AM satellite observation (421 W/m² at 59% cloud)
// into the 11 AM forecast bucket, boosted it for the higher sun, and switched
// mask damping off — while the fresher satellite pass showed the sky had since
// thickened to 80% beam cloud. See the calibration ledger in lib/sandTemp.ts.
// This fixture is that morning's live snapshot, verbatim.
import { describe, expect, it } from "vitest";
import { currentSandTempF } from "@/lib/sandTemp";
import { deriveMetrics } from "@/lib/score";
import type { ConditionsSnapshot, HourlyMetrics } from "@/lib/types";
import fixture from "./__fixtures__/boca-2026-09-08-darkening.json";

const snap = () => JSON.parse(JSON.stringify(fixture.snapshot)) as ConditionsSnapshot;
// The reading was taken ~11 minutes after this snapshot's satellite pass.
const NOW = Date.parse("2026-09-08T15:41:00.000Z");
const LON = fixture.snapshot.location.lon;
const BEAM = fixture.snapshot.goesCloud!.data!.beamCloudPct!; // 79.9

describe("a carried observation must respect a sky that has since darkened", () => {
  it("regression anchor: without the darkening term the carry over-reads (126)", () => {
    const hours = snap().hourly.data as HourlyMetrics[];
    // Overhead (non-beam) cloud never triggers the darkening rule, which
    // isolates the old behaviour: sun-angle boost, no damping.
    expect(currentSandTempF(hours, NOW, { cloudCoverPct: BEAM, radarDryNow: true }, LON)).toBe(126);
  });

  it("with the fresh beam cloud above the observed hour's, the estimate lands in the measured band", () => {
    const hours = snap().hourly.data as HourlyMetrics[];
    const t = currentSandTempF(hours, NOW, { cloudCoverPct: BEAM, cloudIsBeamPath: true, radarDryNow: true }, LON)!;
    expect(t).toBeGreaterThanOrEqual(117);
    expect(t).toBeLessThanOrEqual(123);
  });

  it("a sky that has NOT darkened since the observed hour is carried at full strength", () => {
    const hours = snap().hourly.data as HourlyMetrics[];
    const same = currentSandTempF(hours, NOW, { cloudCoverPct: 59, cloudIsBeamPath: true, radarDryNow: true }, LON)!;
    const clearer = currentSandTempF(hours, NOW, { cloudCoverPct: 30, cloudIsBeamPath: true, radarDryNow: true }, LON)!;
    expect(same).toBe(126);
    expect(clearer).toBe(126);
  });

  it("darkening only ever lowers the estimate, in proportion to the cloud that closed in", () => {
    const hours = snap().hourly.data as HourlyMetrics[];
    const at = (c: number) =>
      currentSandTempF(hours, NOW, { cloudCoverPct: c, cloudIsBeamPath: true, radarDryNow: true }, LON)!;
    expect(at(70)).toBeLessThan(at(59));
    expect(at(80)).toBeLessThan(at(70));
    expect(at(95)).toBeLessThan(at(80));
    expect(at(95)).toBeGreaterThan(105); // half weight: never a full overcast collapse
  });

  it("deriveMetrics on the live snapshot reads the beam cloud and lands in the band", () => {
    const d = deriveMetrics(snap(), NOW);
    expect(d.radarDryNow).toBe(true);
    expect(d.sandTempF).toBeGreaterThanOrEqual(117);
    expect(d.sandTempF).toBeLessThanOrEqual(123);
  });
});
