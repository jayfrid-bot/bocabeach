import { describe, it, expect } from "vitest";
import { summarizeStrikes, type LightningFeed } from "@/lib/sources/lightning";
import { assessLightning, type HazardAnchor } from "@/lib/hazards/assess";
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

  it("closeStrikeMinutesAgo is undefined when nothing is within 5 mi", () => {
    const d = summarizeStrikes(
      feed([[nowSec - 60, BOCA.lat + 0.5, BOCA.lon]]), // ~34.5 mi away
      BOCA.lat,
      BOCA.lon,
      NOW,
    );
    expect(d.closeStrikeMinutesAgo).toBeUndefined();
  });

  it("closeStrikeMinutesAgo is the age of the MOST RECENT strike within 5 mi, not the closest one", () => {
    // A: ~3 mi away, 20 min ago (older, but still the closest strike overall).
    // B: ~4 mi away, 2 min ago (farther than A, but more recent, and still <=5 mi).
    // C: ~34.5 mi away, 1 min ago (most recent strike overall, but outside 5 mi).
    const d = summarizeStrikes(
      feed([
        [nowSec - 1200, BOCA.lat + 0.043, BOCA.lon], // ~3 mi
        [nowSec - 120, BOCA.lat + 0.058, BOCA.lon], // ~4 mi
        [nowSec - 60, BOCA.lat + 0.5, BOCA.lon], // ~34.5 mi
      ]),
      BOCA.lat,
      BOCA.lon,
      NOW,
    );
    expect(d.nearestMi).toBeLessThan(4); // A is the closest strike
    expect(d.lastMinutesAgo).toBe(1); // C is the most recent strike overall
    expect(d.closeStrikeMinutesAgo).toBe(2); // B: the most recent strike within 5 mi
  });

  it("windowMinutes is exposed on the summary", () => {
    const d = summarizeStrikes(feed([]), BOCA.lat, BOCA.lon, NOW);
    expect(d.windowMinutes).toBe(30);
  });
});

describe("summarizeStrikes -> assessLightning (end-to-end hold, real per-flash feed)", () => {
  // Offsets (in miles of latitude, roughly 69 mi/deg) that place strikes at a
  // fixed distance from BOCA. These are DIFFERENT physical flashes, not one
  // strike being "reclassified" — each keeps its own immutable epoch + coords,
  // exactly as scripts/glm_lightning.py emits them (see lightning.ts comment).
  const miToLatOffset = (mi: number) => mi / 69;
  const anchor: HazardAnchor = { kind: "beach", slug: "boca-raton" };

  it("holds active for exactly 30 min off one real close strike, unmoved by a stream of farther (>5mi) strikes", () => {
    const T0 = NOW;
    const closeStrike: [number, number, number] = [
      T0 / 1000,
      BOCA.lat + miToLatOffset(4.8),
      BOCA.lon,
    ];
    // From T0+6min on, additional (separate) strikes land every 2 min at
    // 5.2 mi and 6.4 mi — both outside the 5 mi "close" radius, so they must
    // never feed closeStrikeMinutesAgo.
    const farStrikes: [number, number, number][] = [];
    for (let m = 6; m <= 40; m += 2) {
      const epoch = T0 / 1000 + m * 60;
      farStrikes.push([epoch, BOCA.lat + miToLatOffset(5.2), BOCA.lon]);
      farStrikes.push([epoch, BOCA.lat + miToLatOffset(6.4), BOCA.lon]);
    }
    const f = feed([closeStrike, ...farStrikes]);

    const results: boolean[] = [];
    for (let elapsed = 0; elapsed <= 40; elapsed += 2) {
      const nowMs = T0 + elapsed * 60_000;
      const summary = summarizeStrikes(f, BOCA.lat, BOCA.lon, nowMs);
      const r = assessLightning({
        status: "ok",
        closeStrikeMinutesAgo: summary.closeStrikeMinutesAgo,
        nearestMi: summary.nearestMi,
        nearestMinutesAgo: summary.nearestMinutesAgo,
        windowMinutes: summary.windowMinutes,
        nowMs,
        anchor,
      });
      results.push(r.active);
    }

    // Active for elapsed 0..30 (16 steps, ages 0..30 <= LIGHTNING_HOLD_MIN),
    // then false for 32..40 (5 steps).
    expect(results.slice(0, 16).every(Boolean)).toBe(true);
    expect(results.slice(16).every((v) => v === false)).toBe(true);

    let trueToFalse = 0;
    let falseToTrue = 0;
    for (let i = 1; i < results.length; i++) {
      if (results[i - 1] && !results[i]) trueToFalse++;
      if (!results[i - 1] && results[i]) falseToTrue++;
    }
    expect(trueToFalse).toBe(1);
    expect(falseToTrue).toBe(0);
  });

  it("a legitimate fix-point move (device relocates 1 mi) changes the answer — not flicker, a real distance change", () => {
    // One strike, fixed at 5.5 mi from BOCA's original fix — just outside the
    // 5 mi "close" radius, so it does not qualify. The strike's own lat/lon
    // never changes between the two reads below; only the PERSON'S fix moves
    // ~1 mi closer, legitimately bringing that same strike inside 5 mi.
    const f = feed([[nowSec - 60, BOCA.lat + miToLatOffset(5.5), BOCA.lon]]);

    const before = summarizeStrikes(f, BOCA.lat, BOCA.lon, NOW);
    expect(before.closeStrikeMinutesAgo).toBeUndefined(); // 5.5 mi -> not close

    const movedLat = BOCA.lat + miToLatOffset(1); // fix point moves 1 mi north
    const after = summarizeStrikes(f, movedLat, BOCA.lon, NOW);

    // The strike itself never moved; only the observer's fix did. That's a
    // legitimate change in measured distance (now ~4.5 mi, inside 5 mi),
    // not triangulation flicker on a stationary fix.
    expect(after.nearestMi).toBeLessThan(5);
    expect(after.closeStrikeMinutesAgo).toBeDefined();
  });
});
