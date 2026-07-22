import { describe, expect, it } from "vitest";
import { sharkContext } from "@/lib/sharkContext";

// Boca Raton / Palm Beach latitude — inside BOTH the wide SE-US Atlantic band
// and the narrow blacktip-aggregation band.
const BOCA_LAT = 26.3587;

describe("sharkContext — mullet run", () => {
  it("October + cooling water reads mullet-run active", () => {
    const r = sharkContext({ month: 10, latDeg: BOCA_LAT, waterTempF: 78 });
    expect(r).not.toBeNull();
    expect(r!.active).toBe(true);
    expect(r!.season).toBe("mullet-run");
    expect(r!.note).toMatch(/mullet/i);
  });

  it("October (peak) is active even with no water-temp reading at all", () => {
    const r = sharkContext({ month: 10, latDeg: BOCA_LAT });
    expect(r).not.toBeNull();
    expect(r!.season).toBe("mullet-run");
  });

  it("September (peak) is active regardless of water temp", () => {
    const r = sharkContext({ month: 9, latDeg: BOCA_LAT, waterTempF: 85 });
    expect(r).not.toBeNull();
    expect(r!.season).toBe("mullet-run");
  });

  it("shoulder month (August) with warm water (no corroboration) is quiet", () => {
    const r = sharkContext({ month: 8, latDeg: BOCA_LAT, waterTempF: 86 });
    expect(r).toBeNull();
  });

  it("shoulder month (November) with cooling water corroborates and reads active", () => {
    const r = sharkContext({ month: 11, latDeg: BOCA_LAT, waterTempF: 79 });
    expect(r).not.toBeNull();
    expect(r!.season).toBe("mullet-run");
    expect(r!.note).toMatch(/shoulder|cooling/i);
  });
});

describe("sharkContext — blacktip aggregation", () => {
  it("February at 26.5°N (SE-FL) reads blacktip-aggregation active", () => {
    const r = sharkContext({ month: 2, latDeg: 26.5 });
    expect(r).not.toBeNull();
    expect(r!.active).toBe(true);
    expect(r!.season).toBe("blacktip-aggregation");
    expect(r!.note).toMatch(/blacktip/i);
  });

  it("March (peak) at Boca latitude reads blacktip-aggregation active", () => {
    const r = sharkContext({ month: 3, latDeg: BOCA_LAT });
    expect(r).not.toBeNull();
    expect(r!.season).toBe("blacktip-aggregation");
  });

  it("February at 40°N (NJ) reads null — out of region entirely", () => {
    const r = sharkContext({ month: 2, latDeg: 40 });
    expect(r).toBeNull();
  });

  it("February at 30°N (still SE-US Atlantic, but outside the narrow blacktip band) has no season", () => {
    const r = sharkContext({ month: 2, latDeg: 30 });
    // In the wide Atlantic band (so not geographically excluded outright), but
    // outside the blacktip-specific band and outside mullet-run months, and
    // with no micro-factors supplied -> nothing to say.
    expect(r).toBeNull();
  });

  it("blacktip season does not require any water-temp reading", () => {
    const r = sharkContext({ month: 1, latDeg: BOCA_LAT });
    expect(r).not.toBeNull();
    expect(r!.season).toBe("blacktip-aggregation");
  });
});

describe("sharkContext — geographic gate", () => {
  it("returns null outside the SE-US Atlantic band even in mullet-run peak month", () => {
    const r = sharkContext({ month: 9, latDeg: 41, waterTempF: 70 });
    expect(r).toBeNull();
  });

  it("returns null well south of the band (e.g. the Caribbean) regardless of month", () => {
    const r = sharkContext({ month: 10, latDeg: 18 });
    expect(r).toBeNull();
  });

  it("micro-factor-only combos are still geographically gated", () => {
    const r = sharkContext({
      month: 6, // no season either way
      latDeg: 41, // out of region
      localHour: 6,
      recentWeather: { highSurf: true },
    });
    expect(r).toBeNull();
  });
});

describe("sharkContext — quiet default (no season, no factors)", () => {
  it("July at SE-FL latitude with clear conditions reads null", () => {
    const r = sharkContext({ month: 7, latDeg: BOCA_LAT, waterTempF: 84, localHour: 12 });
    expect(r).toBeNull();
  });

  it("July with no optional inputs at all reads null", () => {
    const r = sharkContext({ month: 7, latDeg: BOCA_LAT });
    expect(r).toBeNull();
  });
});

describe("sharkContext — micro-factors", () => {
  it("murky water + dawn in shoulder season (no water-temp corroboration) still surfaces factors and is active", () => {
    const r = sharkContext({
      month: 8, // mullet-run shoulder, but no waterTempF given -> season alone wouldn't trigger
      latDeg: BOCA_LAT,
      localHour: 6, // dawn
      recentWeather: { highSurf: true },
    });
    expect(r).not.toBeNull();
    expect(r!.active).toBe(true);
    expect(r!.factors).toContain("murky water");
    expect(r!.factors).toContain("dawn/dusk");
  });

  it("murky water alone (no dawn/dusk, no season) is NOT enough to trigger active", () => {
    const r = sharkContext({
      month: 7,
      latDeg: BOCA_LAT,
      recentWeather: { highSurf: true },
    });
    expect(r).toBeNull();
  });

  it("dawn/dusk alone (no murk, no season) is NOT enough to trigger active", () => {
    const r = sharkContext({ month: 7, latDeg: BOCA_LAT, localHour: 19 });
    expect(r).toBeNull();
  });

  it("recentRainIn above threshold counts as murky water", () => {
    const r = sharkContext({
      month: 7,
      latDeg: BOCA_LAT,
      localHour: 6,
      recentWeather: { recentRainIn: 0.75 },
    });
    expect(r).not.toBeNull();
    expect(r!.factors).toContain("murky water");
  });

  it("strong onshore wind counts as murky water", () => {
    const r = sharkContext({
      month: 7,
      latDeg: BOCA_LAT,
      localHour: 20,
      recentWeather: { onshoreWindMph: 18 },
    });
    expect(r).not.toBeNull();
    expect(r!.factors).toContain("murky water");
  });

  it("stormRecent flag counts as murky water", () => {
    const r = sharkContext({
      month: 7,
      latDeg: BOCA_LAT,
      localHour: 7,
      recentWeather: { stormRecent: true },
    });
    expect(r).not.toBeNull();
    expect(r!.factors).toContain("murky water");
  });

  it("near-inlet factor appears when within range, and does not by itself trigger active", () => {
    const nearNoActive = sharkContext({ month: 7, latDeg: BOCA_LAT, nearInletKm: 0.5 });
    expect(nearNoActive).toBeNull(); // inlet alone, no season, no murky+dawn combo

    const inSeason = sharkContext({ month: 10, latDeg: BOCA_LAT, nearInletKm: 0.5 });
    expect(inSeason).not.toBeNull();
    expect(inSeason!.factors).toContain("near inlet");
  });

  it("an inlet far away does not register as the near-inlet factor", () => {
    const r = sharkContext({ month: 10, latDeg: BOCA_LAT, nearInletKm: 25 });
    expect(r).not.toBeNull();
    expect(r!.factors).not.toContain("near inlet");
  });

  it("midday (not dawn/dusk) does not set the dawn/dusk factor", () => {
    const r = sharkContext({ month: 10, latDeg: BOCA_LAT, localHour: 13 });
    expect(r).not.toBeNull();
    expect(r!.factors).not.toContain("dawn/dusk");
  });
});

describe("sharkContext — rarity denominator is mandatory", () => {
  it("is present whenever the read is active (season-driven)", () => {
    const r = sharkContext({ month: 10, latDeg: BOCA_LAT });
    expect(r).not.toBeNull();
    expect(r!.rarityNote).toBeTruthy();
    expect(r!.rarityNote).toMatch(/rare/i);
  });

  it("is present whenever the read is active (factor-combo-driven, no season)", () => {
    const r = sharkContext({
      month: 6,
      latDeg: BOCA_LAT,
      localHour: 19,
      recentWeather: { highSurf: true },
    });
    expect(r).not.toBeNull();
    expect(r!.season).toBeNull();
    expect(r!.rarityNote).toBeTruthy();
    expect(r!.rarityNote).toMatch(/rare/i);
  });

  it("names Volusia/Brevard as the true statewide driver, north of SE Florida", () => {
    const r = sharkContext({ month: 3, latDeg: BOCA_LAT });
    expect(r!.rarityNote).toMatch(/volusia/i);
    expect(r!.rarityNote).toMatch(/brevard/i);
  });
});

describe("sharkContext — never emits a numeric risk", () => {
  it("the returned object has no score/probability/count-style numeric risk field", () => {
    const r = sharkContext({ month: 10, latDeg: BOCA_LAT })!;
    const keys = Object.keys(r);
    expect(keys.sort()).toEqual(["active", "factors", "note", "rarityNote", "season"].sort());
    for (const [key, value] of Object.entries(r)) {
      if (key === "active") continue; // boolean literal `true`, not a risk figure
      expect(typeof value).not.toBe("number");
    }
  });

  it("note and rarityNote never contain a bare percentage-style risk claim", () => {
    const cases = [
      sharkContext({ month: 10, latDeg: BOCA_LAT }),
      sharkContext({ month: 2, latDeg: BOCA_LAT }),
      sharkContext({ month: 6, latDeg: BOCA_LAT, localHour: 19, recentWeather: { highSurf: true } }),
    ];
    for (const r of cases) {
      expect(r).not.toBeNull();
      expect(r!.note).not.toMatch(/\d+%/);
      expect(r!.rarityNote).not.toMatch(/\d+%/);
      expect(r!.note.toLowerCase()).not.toMatch(/\bscore\b|\bprobability\b/);
    }
  });
});
