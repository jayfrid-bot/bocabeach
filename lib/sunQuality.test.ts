import { describe, it, expect } from "vitest";
import {
  goldenHourProgress,
  nearestHourlyPoint,
  nextSunEvent,
  peakColorTime,
  sunEventQuality,
  sunQualityBandMeta,
  type HourlyCloudPoint,
  type SunEventTime,
} from "@/lib/sunQuality";

describe("sunEventQuality", () => {
  // --- canonical cases (from the task spec) ---------------------------------

  it("45% mid/high cloud + low low cloud scores high (vivid/epic sky)", () => {
    // Complete split (high explicitly 0) — the level-based curve only engages
    // once all of low/mid/high are known.
    const r = sunEventQuality({ cloud: { midPct: 45, highPct: 0, lowPct: 5 } });
    expect(r.score).not.toBeNull();
    expect(r.score!).toBeGreaterThanOrEqual(85);
    expect(["vivid", "epic"]).toContain(r.band);
  });

  it("0% cloud (clear sky) scores ~40 — clean but plain", () => {
    const r = sunEventQuality({ cloud: { totalPct: 0 } });
    expect(r.score).toBe(40);
    expect(r.band).toBe("plain");
  });

  it("0% cloud via a full level split (all zero) also lands ~40", () => {
    const r = sunEventQuality({ cloud: { lowPct: 0, midPct: 0, highPct: 0 } });
    expect(r.score).toBe(40);
    expect(r.band).toBe("plain");
  });

  it("90% low cloud is a dud, even with a great mid/high reading underneath it", () => {
    const r = sunEventQuality({ cloud: { lowPct: 90, midPct: 45, highPct: 0 } });
    expect(r.score).not.toBeNull();
    expect(r.score!).toBeGreaterThanOrEqual(5);
    expect(r.score!).toBeLessThanOrEqual(15);
    expect(r.band).toBe("dud");
  });

  it("a PARTIAL level split (e.g. only low cloud, no mid/high, no total) is honest-null — never a fabricated clear-sky read", () => {
    // Before the fix, a lone lowPct selected the level path and defaulted the
    // missing mid/high canvas to 0 — reading a possibly-vivid sky as plain.
    for (const cloud of [{ lowPct: 10 }, { lowPct: 90 }, { midPct: 40 }, { highPct: 40 }]) {
      const r = sunEventQuality({ cloud });
      expect(r.score).toBeNull();
      expect(r.band).toBeNull();
    }
  });

  it("an incomplete level split falls back to the flatter total-cloud curve when total cover is available", () => {
    const r = sunEventQuality({ cloud: { lowPct: 90, totalPct: 90 } });
    expect(r.score).not.toBeNull();
    expect(r.note.toLowerCase()).toContain("cloud mix unknown");
    // Same flatter total-only curve a bare totalPct would use.
    const totalOnly = sunEventQuality({ cloud: { totalPct: 90 } });
    expect(r.score).toBe(totalOnly.score);
  });

  it("total-cloud-only fallback uses a flatter curve and says so", () => {
    const levelBased = sunEventQuality({ cloud: { midPct: 45, highPct: 0, lowPct: 5 } });
    const totalOnly = sunEventQuality({ cloud: { totalPct: 45 } });
    expect(totalOnly.score).not.toBeNull();
    // Flatter/lower-ceiling than the level-based reading of the "same" 45%.
    expect(totalOnly.score!).toBeLessThan(levelBased.score!);
    expect(totalOnly.score!).toBeLessThan(80);
    expect(totalOnly.note.toLowerCase()).toContain("cloud mix unknown");
  });

  it("honest-null: no cloud object at all", () => {
    const r = sunEventQuality({ cloud: undefined });
    expect(r.score).toBeNull();
    expect(r.band).toBeNull();
    expect(r.note.length).toBeGreaterThan(0);
  });

  it("honest-null: cloud object present but every field unset", () => {
    const r = sunEventQuality({ cloud: {} });
    expect(r.score).toBeNull();
    expect(r.band).toBeNull();
  });

  // --- shape of the curve ----------------------------------------------------

  it("peaks somewhere inside the 30-60% mid/high band (30% and 60% both score highly)", () => {
    const at30 = sunEventQuality({ cloud: { midPct: 30, highPct: 0, lowPct: 0 } });
    const at60 = sunEventQuality({ cloud: { midPct: 60, highPct: 0, lowPct: 0 } });
    const at5 = sunEventQuality({ cloud: { midPct: 5, highPct: 0, lowPct: 0 } });
    const at95 = sunEventQuality({ cloud: { midPct: 95, highPct: 0, lowPct: 0 } });
    expect(at30.score!).toBeGreaterThanOrEqual(85);
    expect(at60.score!).toBeGreaterThanOrEqual(85);
    expect(at30.score!).toBeGreaterThan(at5.score!);
    expect(at60.score!).toBeGreaterThan(at95.score!);
  });

  it("combines mid + high cloud via a screen blend, not a naive sum", () => {
    // 30% mid + 30% high should read as noticeably more canvas than 30% mid
    // alone, but less than a naive 60% sum would suggest.
    const midOnly = sunEventQuality({ cloud: { midPct: 30, highPct: 0, lowPct: 0 } });
    const midAndHigh = sunEventQuality({ cloud: { midPct: 30, highPct: 30, lowPct: 0 } });
    expect(midAndHigh.score!).toBeGreaterThanOrEqual(midOnly.score!);
  });

  it("low cloud under 30% costs nothing at the peak", () => {
    const clean = sunEventQuality({ cloud: { midPct: 45, highPct: 0, lowPct: 0 } });
    const stillClean = sunEventQuality({ cloud: { midPct: 45, highPct: 0, lowPct: 25 } });
    expect(stillClean.score).toBe(clean.score);
  });

  it("humidity under 60% gives a small bonus; 60%+ gives none", () => {
    const dry = sunEventQuality({ cloud: { midPct: 45, highPct: 0, lowPct: 5 }, humidityPct: 35 });
    const humid = sunEventQuality({ cloud: { midPct: 45, highPct: 0, lowPct: 5 }, humidityPct: 80 });
    const noReading = sunEventQuality({ cloud: { midPct: 45, highPct: 0, lowPct: 5 } });
    expect(dry.score!).toBeGreaterThanOrEqual(noReading.score!);
    expect(humid.score).toBe(noReading.score);
  });

  it("scores never leave the 0-100 range", () => {
    const cases = [
      { midPct: 100, highPct: 100, lowPct: 100 },
      { midPct: 0, highPct: 0, lowPct: 0 },
      { totalPct: 100 },
      { totalPct: 0 },
    ];
    for (const cloud of cases) {
      const r = sunEventQuality({ cloud, humidityPct: 10 });
      expect(r.score!).toBeGreaterThanOrEqual(0);
      expect(r.score!).toBeLessThanOrEqual(100);
    }
  });
});

describe("sunQualityBandMeta", () => {
  it("returns metadata for every band the scorer can produce", () => {
    for (const band of ["dud", "plain", "good", "vivid", "epic"] as const) {
      const meta = sunQualityBandMeta(band);
      expect(meta.band).toBe(band);
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.color).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe("nextSunEvent", () => {
  const today = { sunrise: "2026-07-21T10:30:00.000Z", sunset: "2026-07-21T23:45:00.000Z" };
  const tomorrowSunrise = "2026-07-22T10:31:00.000Z";

  it("picks today's sunrise when now is before it, with a 60-min golden window starting at sunrise", () => {
    const r = nextSunEvent(new Date("2026-07-21T08:00:00.000Z"), today, tomorrowSunrise);
    expect(r?.event).toBe("sunrise");
    expect(r?.timeIso).toBe(today.sunrise);
    expect(r?.goldenStartIso).toBe(today.sunrise);
    expect(r?.goldenEndIso).toBe("2026-07-21T11:30:00.000Z");
  });

  it("picks today's sunset when sunrise has passed but sunset hasn't, with a 60-min golden window ending at sunset", () => {
    const r = nextSunEvent(new Date("2026-07-21T15:00:00.000Z"), today, tomorrowSunrise);
    expect(r?.event).toBe("sunset");
    expect(r?.timeIso).toBe(today.sunset);
    expect(r?.goldenStartIso).toBe("2026-07-21T22:45:00.000Z");
    expect(r?.goldenEndIso).toBe(today.sunset);
  });

  it("picks tomorrow's sunrise once today's sunset has passed", () => {
    const r = nextSunEvent(new Date("2026-07-22T01:00:00.000Z"), today, tomorrowSunrise);
    expect(r?.event).toBe("sunrise");
    expect(r?.timeIso).toBe(tomorrowSunrise);
    expect(r?.goldenStartIso).toBe(tomorrowSunrise);
  });

  it("returns null after sunset when no tomorrow sunrise was supplied", () => {
    const r = nextSunEvent(new Date("2026-07-22T01:00:00.000Z"), today);
    expect(r).toBeNull();
  });

  it("returns null when there are no sun times at all", () => {
    const r = nextSunEvent(new Date("2026-07-21T08:00:00.000Z"), {});
    expect(r).toBeNull();
  });

  it("falls back to sunset when sunrise is missing (e.g. polar day/night edge case)", () => {
    const r = nextSunEvent(
      new Date("2026-07-21T08:00:00.000Z"),
      { sunset: today.sunset },
      tomorrowSunrise,
    );
    expect(r?.event).toBe("sunset");
    expect(r?.timeIso).toBe(today.sunset);
  });
});

describe("goldenHourProgress", () => {
  const sunriseEvent: SunEventTime = {
    event: "sunrise",
    timeIso: "2026-07-21T10:30:00.000Z",
    goldenStartIso: "2026-07-21T10:30:00.000Z",
    goldenEndIso: "2026-07-21T11:30:00.000Z",
    goldenFromElevation: false,
  };
  const sunsetEvent: SunEventTime = {
    event: "sunset",
    timeIso: "2026-07-21T23:45:00.000Z",
    goldenStartIso: "2026-07-21T22:45:00.000Z",
    goldenEndIso: "2026-07-21T23:45:00.000Z",
    goldenFromElevation: false,
  };

  it("is null before the morning golden-hour window starts", () => {
    const p = goldenHourProgress(new Date("2026-07-21T10:00:00.000Z"), sunriseEvent);
    expect(p).toBeNull();
  });

  it("is 0 at the very start of the morning window and ~50 at its midpoint", () => {
    expect(goldenHourProgress(new Date("2026-07-21T10:30:00.000Z"), sunriseEvent)).toBe(0);
    expect(goldenHourProgress(new Date("2026-07-21T11:00:00.000Z"), sunriseEvent)).toBe(50);
  });

  it("is null after the morning golden-hour window ends", () => {
    const p = goldenHourProgress(new Date("2026-07-21T11:31:00.000Z"), sunriseEvent);
    expect(p).toBeNull();
  });

  it("is null before the evening golden-hour window starts", () => {
    const p = goldenHourProgress(new Date("2026-07-21T22:00:00.000Z"), sunsetEvent);
    expect(p).toBeNull();
  });

  it("tracks progression through the evening window and hits 100 at sunset", () => {
    expect(goldenHourProgress(new Date("2026-07-21T22:45:00.000Z"), sunsetEvent)).toBe(0);
    expect(goldenHourProgress(new Date("2026-07-21T23:15:00.000Z"), sunsetEvent)).toBe(50);
    expect(goldenHourProgress(new Date("2026-07-21T23:45:00.000Z"), sunsetEvent)).toBe(100);
  });

  it("is null once we're past sunset and into the after-sunset → tomorrow-sunrise case", () => {
    // nextSunEvent would have rolled over to tomorrow's sunrise by this point;
    // this just confirms a stale sunset event's window doesn't read as "live".
    const p = goldenHourProgress(new Date("2026-07-22T01:00:00.000Z"), sunsetEvent);
    expect(p).toBeNull();
  });
});

describe("nearestHourlyPoint", () => {
  const points: HourlyCloudPoint[] = [
    { time: "2026-07-21T09:00:00.000Z", cloud: { totalPct: 10 }, humidityPct: 70 },
    { time: "2026-07-21T10:00:00.000Z", cloud: { totalPct: 45 }, humidityPct: 65 },
    { time: "2026-07-21T11:00:00.000Z", cloud: { totalPct: 80 }, humidityPct: 60 },
  ];

  it("finds the closest hour to the event time", () => {
    const p = nearestHourlyPoint("2026-07-21T10:20:00.000Z", points);
    expect(p?.time).toBe("2026-07-21T10:00:00.000Z");
  });

  it("returns undefined when nothing is within tolerance", () => {
    const p = nearestHourlyPoint("2026-07-22T10:00:00.000Z", points);
    expect(p).toBeUndefined();
  });

  it("returns undefined for an empty forecast", () => {
    const p = nearestHourlyPoint("2026-07-21T10:00:00.000Z", []);
    expect(p).toBeUndefined();
  });
});

// --- richer FACTOR model (engaged when a level split is joined by an
// atmospheric/satellite signal) -------------------------------------------
describe("sunEventQuality — factor model", () => {
  const split = { lowPct: 10, midPct: 40, highPct: 30 };

  it("engages (populates a factor breakdown) once an atmospheric signal is present, but not on the bare level split", () => {
    const bare = sunEventQuality({ cloud: split });
    expect(bare.breakdown).toBeUndefined(); // fallback curve path

    const rich = sunEventQuality({ cloud: split, aod: 0.09 });
    expect(rich.breakdown).toBeDefined();
    expect(rich.breakdown!.cloudCanvas).toContain("mid-high");
    expect(rich.score).not.toBeNull();
  });

  it("also engages on a fresh satellite horizon reading alone", () => {
    const r = sunEventQuality({ cloud: split, horizon: { cloudPct: 5, fresh: true } });
    expect(r.breakdown).toBeDefined();
    expect(r.breakdown!.horizonPath.toLowerCase()).toContain("satellite");
  });

  it("a fresh CLEAR satellite horizon beats a socked-in one, all else equal", () => {
    const clear = sunEventQuality({ cloud: split, aod: 0.1, horizon: { cloudPct: 0, fresh: true } });
    const socked = sunEventQuality({ cloud: split, aod: 0.1, horizon: { cloudPct: 95, fresh: true } });
    expect(clear.score!).toBeGreaterThan(socked.score!);
    expect(clear.breakdown!.horizonPath).toMatch(/clear/i);
  });

  it("a stale/non-fresh horizon is ignored for clear-path and flagged unverified (falls back to low-cloud est.)", () => {
    const stale = sunEventQuality({ cloud: split, aod: 0.1, horizon: { cloudPct: 0, fresh: false } });
    const noBeam = sunEventQuality({ cloud: split, aod: 0.1 });
    expect(stale.score).toBe(noBeam.score); // beam not used
    expect(stale.breakdown!.horizonPath).toMatch(/unverified/i);
  });

  it("CANVAS: peaks near the high-weighted ~50% amount and HIGH cloud counts more than mid", () => {
    // high-weighted amount 0.5*mid+0.7*high: tune each to sit at ~50.
    const balanced = sunEventQuality({ cloud: { lowPct: 0, midPct: 40, highPct: 43 }, aod: 0.1 });
    const tooClear = sunEventQuality({ cloud: { lowPct: 0, midPct: 10, highPct: 5 }, aod: 0.1 });
    expect(balanced.score!).toBeGreaterThan(tooClear.score!);
    // 50% as all-high scores higher than 50% as all-mid (high weighted above mid).
    const allHigh = sunEventQuality({ cloud: { lowPct: 0, midPct: 0, highPct: 71 }, aod: 0.1 });
    const allMid = sunEventQuality({ cloud: { lowPct: 0, midPct: 71, highPct: 0 }, aod: 0.1 });
    expect(allHigh.score!).toBeGreaterThan(allMid.score!);
  });

  it("LOW cloud imposes a near-linear canvas + clear-path penalty", () => {
    const lowClean = sunEventQuality({ cloud: { lowPct: 0, midPct: 40, highPct: 30 }, aod: 0.1 });
    const lowSome = sunEventQuality({ cloud: { lowPct: 40, midPct: 40, highPct: 30 }, aod: 0.1 });
    const lowHeavy = sunEventQuality({ cloud: { lowPct: 90, midPct: 40, highPct: 30 }, aod: 0.1 });
    expect(lowClean.score!).toBeGreaterThan(lowSome.score!);
    expect(lowSome.score!).toBeGreaterThan(lowHeavy.score!);
    expect(lowHeavy.band).toBe("dud");
  });

  it("AEROSOL modifier: very clean air (AOD<0.15) beats hazy air; penalty is capped at −25%", () => {
    const clean = sunEventQuality({ cloud: split, aod: 0.05 });
    const hazy = sunEventQuality({ cloud: split, aod: 0.4 });
    const veryHazy = sunEventQuality({ cloud: split, aod: 5 });
    expect(clean.score!).toBeGreaterThan(hazy.score!);
    // Cap: even absurd AOD can't push the modifier below 0.75, so veryHazy
    // stays at the −25% floor (not lower than a moderately hazy reading's ramp).
    const neutral = sunEventQuality({ cloud: split, aod: 0.15 });
    expect(veryHazy.score!).toBeGreaterThanOrEqual(Math.round(neutral.score! * 0.75) - 1);
    expect(clean.breakdown!.airClarity).toMatch(/AOD/);
  });

  it("PM2.5 boundary-smoke penalty applies above ~35 µg/m³ and is capped at −35%", () => {
    const cleanPm = sunEventQuality({ cloud: split, pm2_5: 8 });
    const smoky = sunEventQuality({ cloud: split, pm2_5: 200 });
    expect(smoky.score!).toBeLessThan(cleanPm.score!);
    // Floor: modifier can't drop below 0.65.
    const base = sunEventQuality({ cloud: split, pm2_5: 35 });
    expect(smoky.score!).toBeGreaterThanOrEqual(Math.round(base.score! * 0.65) - 1);
  });

  it("HUMIDITY modifier: mild penalty above 60% RH, capped at −15%; ≤60% costs nothing", () => {
    const dry = sunEventQuality({ cloud: split, aod: 0.1, humidityPct: 40 });
    const at60 = sunEventQuality({ cloud: split, aod: 0.1, humidityPct: 60 });
    const muggy = sunEventQuality({ cloud: split, aod: 0.1, humidityPct: 100 });
    expect(dry.score).toBe(at60.score); // no penalty at/below 60
    expect(muggy.score!).toBeLessThan(dry.score!);
    // Floor: −15% at saturation.
    expect(muggy.score!).toBeGreaterThanOrEqual(Math.round(dry.score! * 0.85) - 1);
    expect(muggy.breakdown!.humidity).toMatch(/muggy/i);
  });

  it("still honest-null with no cloud reading, even when air/satellite inputs are present", () => {
    const r = sunEventQuality({ cloud: undefined, aod: 0.1, horizon: { cloudPct: 0, fresh: true } });
    expect(r.score).toBeNull();
    expect(r.band).toBeNull();
    expect(r.breakdown).toBeUndefined();
  });

  it("an incomplete split + air signal does NOT engage the factor model (no fabricated canvas)", () => {
    // Only total cover known → stays on the flatter total-only fallback curve.
    const r = sunEventQuality({ cloud: { totalPct: 45 }, aod: 0.1 });
    expect(r.breakdown).toBeUndefined();
    expect(r.note.toLowerCase()).toContain("cloud mix unknown");
  });

  it("factor-model scores never leave 0-100", () => {
    for (const cloud of [
      { lowPct: 0, midPct: 71, highPct: 71 },
      { lowPct: 100, midPct: 100, highPct: 100 },
      { lowPct: 0, midPct: 0, highPct: 0 },
    ]) {
      const r = sunEventQuality({ cloud, aod: 0.01, pm2_5: 5, humidityPct: 20, horizon: { cloudPct: 0, fresh: true } });
      expect(r.score!).toBeGreaterThanOrEqual(0);
      expect(r.score!).toBeLessThanOrEqual(100);
    }
  });
});

// --- real elevation golden windows on nextSunEvent ------------------------
describe("nextSunEvent — true elevation golden windows", () => {
  const today = {
    sunrise: "2026-07-21T10:41:00.000Z",
    sunset: "2026-07-22T00:11:00.000Z",
    goldenAm: {
      goldenStartIso: "2026-07-21T10:26:00.000Z",
      goldenEndIso: "2026-07-21T11:14:00.000Z",
      peakAnchorIso: "2026-07-21T10:31:00.000Z",
    },
    goldenEve: {
      goldenStartIso: "2026-07-21T23:39:00.000Z",
      goldenEndIso: "2026-07-22T00:27:00.000Z", // runs PAST sunset (sun at −4°)
      peakAnchorIso: "2026-07-22T00:22:00.000Z",
    },
  };

  it("uses the real morning window (spanning before sunrise) and marks it elevation-derived", () => {
    const r = nextSunEvent(new Date("2026-07-21T08:00:00.000Z"), today);
    expect(r?.event).toBe("sunrise");
    expect(r?.goldenStartIso).toBe(today.goldenAm.goldenStartIso);
    expect(r?.goldenEndIso).toBe(today.goldenAm.goldenEndIso);
    expect(r?.goldenFromElevation).toBe(true);
    expect(r?.peakAnchorIso).toBe(today.goldenAm.peakAnchorIso);
  });

  it("uses the real evening window that runs PAST sunset", () => {
    const r = nextSunEvent(new Date("2026-07-21T20:00:00.000Z"), today);
    expect(r?.event).toBe("sunset");
    expect(r?.goldenEndIso).toBe(today.goldenEve.goldenEndIso);
    // The window end is after the sunset instant — golden hour straddles it.
    expect(Date.parse(r!.goldenEndIso)).toBeGreaterThan(Date.parse(today.sunset));
    expect(r?.goldenFromElevation).toBe(true);
  });

  it("falls back to the ±60-min window (goldenFromElevation:false) when no real window is supplied", () => {
    const r = nextSunEvent(new Date("2026-07-21T08:00:00.000Z"), {
      sunrise: today.sunrise,
      sunset: today.sunset,
    });
    expect(r?.goldenFromElevation).toBe(false);
    expect(r?.goldenStartIso).toBe(today.sunrise); // sunrise → +60
    expect(r?.peakAnchorIso).toBeUndefined();
  });

  it("uses tomorrow's real morning window once tonight's sunset has passed", () => {
    const r = nextSunEvent(
      new Date("2026-07-22T02:00:00.000Z"),
      today,
      {
        sunriseIso: "2026-07-22T10:42:00.000Z",
        goldenAm: {
          goldenStartIso: "2026-07-22T10:27:00.000Z",
          goldenEndIso: "2026-07-22T11:15:00.000Z",
          peakAnchorIso: "2026-07-22T10:32:00.000Z",
        },
      },
    );
    expect(r?.event).toBe("sunrise");
    expect(r?.timeIso).toBe("2026-07-22T10:42:00.000Z");
    expect(r?.goldenFromElevation).toBe(true);
    expect(r?.peakAnchorIso).toBe("2026-07-22T10:32:00.000Z");
  });

  it("still accepts the legacy string tomorrow-sunrise form (back-compat)", () => {
    const r = nextSunEvent(new Date("2026-07-22T02:00:00.000Z"), today, "2026-07-22T10:42:00.000Z");
    expect(r?.event).toBe("sunrise");
    expect(r?.timeIso).toBe("2026-07-22T10:42:00.000Z");
    expect(r?.goldenFromElevation).toBe(false); // no window supplied with the string
  });
});

// --- peak-color timing -----------------------------------------------------
describe("peakColorTime", () => {
  const sunsetIso = "2026-07-22T00:11:00.000Z";
  const eveAnchor = "2026-07-22T00:22:00.000Z"; // sun −3°, 11 min after sunset
  const sunriseIso = "2026-07-21T10:41:00.000Z";
  const amAnchor = "2026-07-21T10:31:00.000Z"; // sun −3°, 10 min before sunrise

  it("with a high-cloud deck + clear horizon, sunset peak lags to the −3° anchor", () => {
    const p = peakColorTime({
      event: "sunset",
      eventIso: sunsetIso,
      peakAnchorIso: eveAnchor,
      highPct: 30,
      clearPathScore: 80,
    });
    expect(p?.iso).toBe(eveAnchor);
    expect(p?.minutesFromEvent).toBe(11);
  });

  it("for a sunrise the anchor lands BEFORE the event (negative offset)", () => {
    const p = peakColorTime({
      event: "sunrise",
      eventIso: sunriseIso,
      peakAnchorIso: amAnchor,
      highPct: 20,
      clearPathScore: 70,
    });
    expect(p?.minutesFromEvent).toBe(-10);
  });

  it("without a meaningful high-cloud deck, peak is at the event itself", () => {
    const p = peakColorTime({
      event: "sunset",
      eventIso: sunsetIso,
      peakAnchorIso: eveAnchor,
      highPct: 5, // below the 15% threshold
      clearPathScore: 80,
    });
    expect(p?.iso).toBe(sunsetIso);
    expect(p?.minutesFromEvent).toBe(0);
  });

  it("a socked-in horizon (low clear-path) also collapses peak to the event", () => {
    const p = peakColorTime({
      event: "sunset",
      eventIso: sunsetIso,
      peakAnchorIso: eveAnchor,
      highPct: 40,
      clearPathScore: 20, // not clear
    });
    expect(p?.minutesFromEvent).toBe(0);
  });

  it("caps the lag at +30 min from the event", () => {
    const p = peakColorTime({
      event: "sunset",
      eventIso: sunsetIso,
      peakAnchorIso: "2026-07-22T01:30:00.000Z", // 79 min out — absurd
      highPct: 40,
      clearPathScore: 90,
    });
    expect(p?.minutesFromEvent).toBe(30);
  });

  it("with no anchor (elevation solve unavailable) peak stays at the event", () => {
    const p = peakColorTime({ event: "sunset", eventIso: sunsetIso, highPct: 40, clearPathScore: 90 });
    expect(p?.minutesFromEvent).toBe(0);
  });

  it("honest-null when there's no event time at all", () => {
    expect(peakColorTime({ event: "sunset", eventIso: undefined })).toBeNull();
  });
});
