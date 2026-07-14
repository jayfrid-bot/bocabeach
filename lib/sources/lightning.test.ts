import { describe, it, expect } from "vitest";
import { summarizeStrikes, type LightningFeed } from "@/lib/sources/lightning";
import { degToCardinal } from "@/lib/util";

const BOCA = { lat: 26.3587, lon: -80.0686 };
const NOW = Date.parse("2026-06-03T12:00:00.000Z");
const nowSec = NOW / 1000;

function feed(strikes: [number, number, number][]): LightningFeed {
  return {
    generatedAt: "2026-06-03T11:55:00.000Z", // 5 min before NOW
    windowMinutes: 30,
    strikes,
  };
}

describe("summarizeStrikes", () => {
  it("returns an all-clear shape when there are no strikes", () => {
    const d = summarizeStrikes(feed([]), BOCA.lat, BOCA.lon, NOW);
    expect(d.totalInArea).toBe(0);
    expect(d.within10mi).toBe(0);
    expect(d.within20mi).toBe(0);
    expect(d.stormEnergy).toBe(0);
    expect(d.nearestMi).toBeUndefined();
    expect(d.nearestMinutesAgo).toBeUndefined();
    expect(d.dataAgeMinutes).toBe(5);
  });

  it("finds the closest strike and the most-recent strike independently", () => {
    // A: right at Boca, 10 min ago.  B: ~34.5 mi north, 2 min ago.
    const d = summarizeStrikes(
      feed([
        [nowSec - 600, BOCA.lat, BOCA.lon],
        [nowSec - 120, BOCA.lat + 0.5, BOCA.lon],
      ]),
      BOCA.lat,
      BOCA.lon,
      NOW,
    );
    expect(d.nearestMi).toBeLessThan(1); // A is the closest
    expect(d.nearestMinutesAgo).toBe(10);
    expect(d.lastMinutesAgo).toBe(2); // B is the most recent
    expect(d.lastMi).toBeGreaterThan(30);
    expect(d.lastMi).toBeLessThan(40);
  });

  it("reports the compass bearing to the nearest strike", () => {
    const north = summarizeStrikes(
      feed([[nowSec - 60, BOCA.lat + 0.5, BOCA.lon]]),
      BOCA.lat,
      BOCA.lon,
      NOW,
    );
    expect(degToCardinal(north.nearestBearingDeg!)).toBe("N");

    const east = summarizeStrikes(
      feed([[nowSec - 60, BOCA.lat, BOCA.lon + 0.5]]),
      BOCA.lat,
      BOCA.lon,
      NOW,
    );
    expect(degToCardinal(east.nearestBearingDeg!)).toBe("E");

    const south = summarizeStrikes(
      feed([[nowSec - 60, BOCA.lat - 0.5, BOCA.lon]]),
      BOCA.lat,
      BOCA.lon,
      NOW,
    );
    expect(degToCardinal(south.nearestBearingDeg!)).toBe("S");
  });

  it("counts strikes by radius band", () => {
    const d = summarizeStrikes(
      feed([
        [nowSec - 60, BOCA.lat, BOCA.lon], // ~0 mi  -> 10/25/50
        [nowSec - 60, BOCA.lat + 0.3, BOCA.lon], // ~20.7 mi -> 25/50
        [nowSec - 60, BOCA.lat + 0.6, BOCA.lon], // ~41 mi  -> 50
        [nowSec - 60, BOCA.lat + 2.0, BOCA.lon], // ~138 mi -> none
      ]),
      BOCA.lat,
      BOCA.lon,
      NOW,
    );
    expect(d.within10mi).toBe(1);
    expect(d.within20mi).toBe(1); // the ~20.7 mi strike is just outside 20 mi
    expect(d.within25mi).toBe(2);
    expect(d.within50mi).toBe(3);
    expect(d.totalInArea).toBe(4);
  });

  it("computes stormEnergy as a recency-weighted sum within 20 mi", () => {
    // A: right at Boca, right now (age 0 -> weight 1). B: right at Boca, 12 min
    // ago (age 12 -> weight exp(-1) ~= 0.3679). C: ~34.5 mi away (outside 20 mi,
    // excluded regardless of age).
    const d = summarizeStrikes(
      feed([
        [nowSec, BOCA.lat, BOCA.lon],
        [nowSec - 720, BOCA.lat, BOCA.lon],
        [nowSec - 60, BOCA.lat + 0.5, BOCA.lon],
      ]),
      BOCA.lat,
      BOCA.lon,
      NOW,
    );
    expect(d.within20mi).toBe(2);
    expect(d.stormEnergy).toBeCloseTo(1 + Math.exp(-1), 2);
  });

  it("stormEnergy decays strikes older than the window toward zero", () => {
    const d = summarizeStrikes(
      feed([[nowSec - 3600, BOCA.lat, BOCA.lon]]), // 60 min ago
      BOCA.lat,
      BOCA.lon,
      NOW,
    );
    expect(d.stormEnergy).toBeLessThanOrEqual(0.01);
  });
});
