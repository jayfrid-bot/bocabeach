// The Sky number, like the sand model, must trust a satellite-OBSERVED sunshine
// reading over a median of forecast models that can be unanimously wrong. Same
// 2026-09-04 Boca afternoon: thin cirrus, sun measurably out, models 3×100%,
// cloud mask 98% — the app used to read "Clear · 98% cloud" and score the sky
// as if it were overcast. See consensusCloudPct / observedSkyCloudPct in score.ts.
import { describe, expect, it } from "vitest";
import { computeScore, consensusCloudPct, observedSkyCloudPct } from "@/lib/score";
import type { ConditionsSnapshot } from "@/lib/types";
import fixture from "./__fixtures__/boca-2026-09-04-phantom-rain.json";

const NOW = Date.parse(fixture.snapshot.generatedAt);

/** The fixture predates solarObserved; flag elapsed hours as the overlay now does. */
function snap(): ConditionsSnapshot {
  const s = JSON.parse(JSON.stringify(fixture.snapshot)) as ConditionsSnapshot;
  for (const b of s.hourly.data ?? []) {
    if (Date.parse(b.time) + 3600_000 <= NOW) b.solarObserved = true;
  }
  return s;
}
const skySub = (s: ConditionsSnapshot) =>
  computeScore(s, undefined, NOW).subScores.find((x) => x.key === "sky")!;

describe("observed sunshine overrules the model+mask cloud consensus", () => {
  it("thin cirrus with the sun out reads mostly clear, not overcast", () => {
    const o = observedSkyCloudPct(snap(), NOW);
    expect(o).not.toBeUndefined();
    expect(o!).toBeLessThanOrEqual(20); // 94% of the sun reached the ground
    expect(consensusCloudPct(snap(), NOW)).toBe(o); // observation wins
  });

  it("the Sky sub-score and display reflect the sun that is actually out", () => {
    const sub = skySub(snap());
    expect(sub.score!).toBeGreaterThanOrEqual(80); // was ~poor at 98% cloud
    expect(sub.display).toMatch(/clear/i);
    expect(sub.display).not.toMatch(/\b(7[0-9]|[89][0-9]|100)% cloud/); // no "98% cloud"
  });

  it("a real anvil is preserved: sun blocked → reads heavy cloud", () => {
    // Same granule mask, but the observed radiation collapses under the anvil.
    const anvil = snap();
    for (const b of anvil.hourly.data ?? []) if (b.solarObserved) b.solarWm2 = 120;
    expect(observedSkyCloudPct(anvil, NOW)!).toBeGreaterThanOrEqual(75);
  });
});

describe("the observed read stands down and the consensus takes over", () => {
  it("low sun → model+mask consensus (the sin() clear-sky model is unreliable there)", () => {
    const s = snap();
    s.goesCloud.data!.sunElevDeg = 10;
    expect(observedSkyCloudPct(s, NOW)).toBeUndefined();
  });

  it("stale GOES feed → consensus", () => {
    const s = snap();
    s.goesCloud.status = "stale";
    expect(observedSkyCloudPct(s, NOW)).toBeUndefined();
  });

  it("degraded granule (few valid pixels) → consensus", () => {
    const s = snap();
    s.goesCloud.data!.validPixels = 5;
    s.goesCloud.data!.totalPixels = 49;
    expect(observedSkyCloudPct(s, NOW)).toBeUndefined();
  });

  it("no satellite-observed hour → mask double-vote consensus, exactly as before", () => {
    const s = snap();
    for (const b of s.hourly.data ?? []) b.solarObserved = false;
    expect(observedSkyCloudPct(s, NOW)).toBeUndefined();
    // 5 models [55,79,100,100,100] + mask 98 ×2 → median 98, unchanged behavior.
    expect(consensusCloudPct(s, NOW)).toBe(98);
  });
});

describe("skyDisplay never shows a self-contradicting word + number", () => {
  it("drops a high cloud number when the word says clear", () => {
    // Force the fallback path with a clear word but a mask-driven high number.
    const s = snap();
    for (const b of s.hourly.data ?? []) b.solarObserved = false; // → consensus 98
    const sub = skySub(s);
    // NWS textDescription in the fixture is "Clear"; 98% must not print beside it.
    if (/clear|sunny|fair/i.test(sub.display ?? "")) {
      expect(sub.display).not.toMatch(/% cloud/);
    }
  });
});
