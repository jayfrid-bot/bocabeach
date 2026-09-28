// Validated against docs/benchmarks/2026-09-28-surf-height-validation.md —
// see that doc for how the two anchor cases below were chosen and why DPD
// (not APD) is the right period to feed this.
import { describe, expect, it } from "vitest";
import {
  breakerHeightM,
  estimateSurfFromSources,
  estimateSurfHeightFt,
  MAX_TRUSTED_PERIOD_S,
  MIN_TRUSTED_PERIOD_S,
} from "@/lib/surfHeight";

describe("breakerHeightM — Komar & Gaughan (1972), meters", () => {
  it("amplifies a known Hs + period by the textbook formula", () => {
    // Hb = 0.39 * g^(1/5) * (T * H0^2)^(2/5); hs=1m, T=10s.
    expect(breakerHeightM(1, 10)).toBeCloseTo(1.5465670106659553, 10);
  });

  it("amplifies less for a shorter (but still trusted) period", () => {
    expect(breakerHeightM(0.5, 15)).toBeCloseTo(1.0446751141519945, 10);
  });

  it("falls back to Hs (no amplification) when the period is missing", () => {
    expect(breakerHeightM(2, undefined)).toBe(2);
  });

  it(`falls back to Hs at/under the ${MIN_TRUSTED_PERIOD_S}s guard (short-period chop, not swell)`, () => {
    expect(breakerHeightM(1, MIN_TRUSTED_PERIOD_S)).toBe(1);
    expect(breakerHeightM(1, 2)).toBe(1);
  });

  it(`still amplifies right at the ${MAX_TRUSTED_PERIOD_S}s upper guard`, () => {
    expect(breakerHeightM(1, MAX_TRUSTED_PERIOD_S)).toBeCloseTo(2.2312320807669743, 10);
  });

  it(`falls back to Hs over the ${MAX_TRUSTED_PERIOD_S}s guard (implausible/garbled period)`, () => {
    expect(breakerHeightM(1, MAX_TRUSTED_PERIOD_S + 0.1)).toBe(1);
  });

  it("clamps the estimate to at most 2.5x Hs — a small Hs with a long period can't blow up", () => {
    const raw = 0.39 * Math.pow(9.80665, 1 / 5) * Math.pow(20 * 0.1 * 0.1, 2 / 5);
    expect(raw).toBeGreaterThan(2.5 * 0.1); // confirms this case actually exercises the clamp
    expect(breakerHeightM(0.1, 20)).toBeCloseTo(0.25, 10);
  });

  it("never returns less than Hs itself", () => {
    // A period right at the edge of trust still can't estimate BELOW Hs.
    expect(breakerHeightM(3, 3.01)).toBeGreaterThanOrEqual(3);
  });

  it("is undefined only when Hs itself is missing/invalid", () => {
    expect(breakerHeightM(undefined, 10)).toBeUndefined();
    expect(breakerHeightM(-1, 10)).toBeUndefined();
    expect(breakerHeightM(NaN, 10)).toBeUndefined();
  });

  it("handles Hs = 0 without dividing by zero or amplifying", () => {
    expect(breakerHeightM(0, 15)).toBe(0);
  });
});

describe("estimateSurfHeightFt — feet wrapper", () => {
  it("matches the validated 'tonight' reading (Hs 1.3 ft, DPD 14s)", () => {
    expect(estimateSurfHeightFt(1.3, 14)).toBe(2.8);
  });

  it("matches the validated 9/27 swell reading (Hs 2.6 ft, DPD 15s) against the NWS 4-6 ft SRF range", () => {
    const surf = estimateSurfHeightFt(2.6, 15)!;
    expect(surf).toBe(5);
    expect(surf).toBeGreaterThanOrEqual(4);
    expect(surf).toBeLessThanOrEqual(6);
  });

  it("matches anchor (a): 2026-09-18 daytime short-period chop (Hs 1.3 ft, DPD 4s) close to the owner's ~1-1.5 ft read", () => {
    const surf = estimateSurfHeightFt(1.3, 4)!;
    expect(surf).toBe(1.7);
    expect(Math.abs(surf - 1.3)).toBeLessThanOrEqual(1); // within the ~1 ft validation tolerance
  });

  it("falls back to Hs with no period and rounds to 0.1 ft", () => {
    expect(estimateSurfHeightFt(1.3, undefined)).toBe(1.3);
    expect(estimateSurfHeightFt(1.3, 3)).toBe(1.3); // guard boundary
  });

  it("is undefined when Hs itself is missing", () => {
    expect(estimateSurfHeightFt(undefined, 14)).toBeUndefined();
  });

  it("treats 0 ft Hs as 0 ft surf, not undefined", () => {
    expect(estimateSurfHeightFt(0, 15)).toBe(0);
  });
});

// Codex review 2026-09-28 #2: a TOTAL wave height (which includes short-period
// local wind chop) must never be paired with a SWELL-only period — that
// fabricates an amplification the physics doesn't support. These cover the
// mixed wind-sea/swell case: a choppy total reading riding on top of a real
// groundswell, exactly the situation Open-Meteo's marine model reports when
// it splits `wave_*` (total) from `swell_wave_*` (swell only).
describe("estimateSurfFromSources — total vs swell pairing (mixed wind-sea/swell)", () => {
  it("prefers the total height + its OWN total period when both are present, even alongside a swell reading", () => {
    // Total: 3 ft @ 6s (choppy). Swell buried in it: 1 ft @ 15s. The total
    // period is present, so it must win — never substitute the swell period.
    const r = estimateSurfFromSources({
      totalHeightFt: 3,
      totalPeriodS: 6,
      swellHeightFt: 1,
      swellPeriodS: 15,
    });
    expect(r.surfFt).toBe(estimateSurfHeightFt(3, 6));
    expect(r.rawHeightFt).toBe(3);
    expect(r.rawPeriodS).toBe(6);
  });

  it("falls back to the matched swell height+period when the total period is missing, never total height + swell period", () => {
    // Total: 3 ft, no period reported. Swell: 1 ft @ 15s (long, would amplify
    // a lot if wrongly paired with the 3 ft total).
    const r = estimateSurfFromSources({
      totalHeightFt: 3,
      totalPeriodS: undefined,
      swellHeightFt: 1,
      swellPeriodS: 15,
    });
    // Swell-only estimate (1 ft @ 15s) must NOT reach 3 ft, so the raw total
    // Hs wins — proving the swell period was never spliced onto the total
    // height (which would have produced a much larger, wrong number).
    const swellOnlySurf = estimateSurfHeightFt(1, 15)!;
    expect(swellOnlySurf).toBeLessThan(3);
    expect(r.surfFt).toBe(3); // total Hs, unamplified
    expect(r.rawHeightFt).toBe(3);
    expect(r.rawPeriodS).toBeUndefined();
  });

  it("uses the swell-component surf estimate when it exceeds the raw total Hs", () => {
    // Total: 1.3 ft, no period. Swell: 1.3 ft @ 15s — a real long-period
    // groundswell riding under light chop; the swell component's own
    // amplification legitimately beats the raw total.
    const r = estimateSurfFromSources({
      totalHeightFt: 1.3,
      totalPeriodS: undefined,
      swellHeightFt: 1.3,
      swellPeriodS: 15,
    });
    const expected = estimateSurfHeightFt(1.3, 15)!;
    expect(expected).toBeGreaterThan(1.3);
    expect(r.surfFt).toBe(expected);
    expect(r.rawHeightFt).toBe(1.3);
    expect(r.rawPeriodS).toBe(15);
  });

  it("leaves the total Hs unamplified when neither a total nor a swell period is available", () => {
    const r = estimateSurfFromSources({ totalHeightFt: 2.1, swellHeightFt: 1.8 });
    expect(r.surfFt).toBe(2.1);
    expect(r.rawHeightFt).toBe(2.1);
    expect(r.rawPeriodS).toBeUndefined();
  });

  // Codex review round-2 #2: a source with no total reading at all (only a
  // swell height+period) must still produce a surf estimate from the swell
  // pair — dropping it entirely would silently zero out the waves factor for
  // a source shape the app already handles elsewhere.
  it("estimates surf from a complete swell pair when the total height is missing entirely", () => {
    const r = estimateSurfFromSources({ swellHeightFt: 1.2, swellPeriodS: 15 });
    expect(r.surfFt).toBe(estimateSurfHeightFt(1.2, 15));
    expect(r.rawHeightFt).toBe(1.2);
    expect(r.rawPeriodS).toBe(15);
  });

  it("returns nothing when the total height is missing AND the swell pair is incomplete", () => {
    expect(estimateSurfFromSources({ swellHeightFt: 1 })).toEqual({}); // no swell period
    expect(estimateSurfFromSources({ swellPeriodS: 15 })).toEqual({}); // no swell height
    expect(estimateSurfFromSources({})).toEqual({});
  });
});
