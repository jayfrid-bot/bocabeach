import { describe, it, expect } from "vitest";
import {
  nearestHourlyPoint,
  nextSunEvent,
  sunEventQuality,
  sunQualityBandMeta,
  type HourlyCloudPoint,
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

  it("picks today's sunrise when now is before it", () => {
    const r = nextSunEvent(new Date("2026-07-21T08:00:00.000Z"), today, tomorrowSunrise);
    expect(r).toEqual({ event: "sunrise", timeIso: today.sunrise });
  });

  it("picks today's sunset when sunrise has passed but sunset hasn't", () => {
    const r = nextSunEvent(new Date("2026-07-21T15:00:00.000Z"), today, tomorrowSunrise);
    expect(r).toEqual({ event: "sunset", timeIso: today.sunset });
  });

  it("picks tomorrow's sunrise once today's sunset has passed", () => {
    const r = nextSunEvent(new Date("2026-07-22T01:00:00.000Z"), today, tomorrowSunrise);
    expect(r).toEqual({ event: "sunrise", timeIso: tomorrowSunrise });
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
    expect(r).toEqual({ event: "sunset", timeIso: today.sunset });
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
