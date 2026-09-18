import { describe, it, expect } from "vitest";
import { assessLightning, assessRain, type HazardAnchor } from "@/lib/hazards/assess";

const anchor: HazardAnchor = { kind: "beach", slug: "boca-raton" };
const NOW = Date.parse("2026-06-01T15:00:00.000Z");

describe("assessLightning", () => {
  it("close strike 5 min ago -> active, not latched", () => {
    const r = assessLightning({
      status: "ok",
      closeStrikeMinutesAgo: 5,
      nearestMi: 4.8,
      nearestMinutesAgo: 5,
      nowMs: NOW,
      anchor,
    });
    expect(r.active).toBe(true);
    expect(r.latched).toBe(false);
  });

  it("close strike 12 min ago -> active + latched", () => {
    const r = assessLightning({
      status: "ok",
      closeStrikeMinutesAgo: 12,
      nearestMi: 4.8,
      nearestMinutesAgo: 12,
      nowMs: NOW,
      anchor,
    });
    expect(r.active).toBe(true);
    expect(r.latched).toBe(true);
  });

  it("close strike 31 min ago -> inactive (hold expired)", () => {
    const r = assessLightning({
      status: "ok",
      closeStrikeMinutesAgo: 31,
      nearestMi: 4.8,
      nearestMinutesAgo: 31,
      nowMs: NOW,
      anchor,
    });
    expect(r.active).toBe(false);
    expect(r.latched).toBe(false);
  });

  it("no strike within 5 mi -> inactive (a far recent strike must not count)", () => {
    const r = assessLightning({
      status: "ok",
      closeStrikeMinutesAgo: undefined, // lightning.ts leaves this undefined when nothing is within 5 mi
      nearestMi: 6.4,
      nearestMinutesAgo: 2,
      nowMs: NOW,
      anchor,
    });
    expect(r.active).toBe(false);
  });

  it("caps the effective hold at a narrower feed window (never claims a hold the feed can't back)", () => {
    const r = assessLightning({
      status: "ok",
      closeStrikeMinutesAgo: 20,
      windowMinutes: 15, // narrower than LIGHTNING_HOLD_MIN (30)
      nowMs: NOW,
      anchor,
    });
    expect(r.active).toBe(false); // 20 > the 15-min effective hold
  });

  it("a full 30-min window is not further shortened", () => {
    const r = assessLightning({
      status: "ok",
      closeStrikeMinutesAgo: 25,
      windowMinutes: 30,
      nowMs: NOW,
      anchor,
    });
    expect(r.active).toBe(true);
  });

  it("counts transitions across a 40-min hover sequence: a close strike at 12 min old, nearestMi flickering 4.8/5.2 every 2 min", () => {
    // The bug this fixes: assessLightning used to recompute `active` off the
    // CURRENT nearestMi every call, so nearestMi hovering around the 5 mi
    // line (triangulation noise) flipped active on/off every call. Now
    // active/latched are driven purely by closeStrikeMinutesAgo (the aging
    // clock of the one strike that landed within 5 mi), and nearestMi is
    // display-only — it must NOT move the needle at all.
    const startAgo = 12; // the close strike's age at t=0 of this sequence
    const steps = Array.from({ length: 21 }, (_, i) => i * 2); // 0,2,4,...,40 min elapsed
    const results = steps.map((elapsed, i) => {
      const nearestMi = i % 2 === 0 ? 4.8 : 5.2; // flickers every step, ignored by the decision
      return assessLightning({
        status: "ok",
        closeStrikeMinutesAgo: startAgo + elapsed,
        nearestMi,
        nowMs: NOW + elapsed * 60_000,
        anchor,
      }).active;
    });
    // Active while the close strike's age (12..30) stays within the 30-min
    // hold, i.e. for elapsed 0..18 (age 12..30) -> steps 0..9 (18 min).
    const activeCount = results.filter(Boolean).length;
    expect(activeCount).toBe(10); // elapsed 0,2,...,18 -> ages 12,14,...,30
    expect(results.slice(0, 10).every(Boolean)).toBe(true);
    expect(results.slice(10).every((v) => v === false)).toBe(true);
    // Exactly one transition: true -> false, never back to true.
    let transitions = 0;
    for (let i = 1; i < results.length; i++) {
      if (results[i] !== results[i - 1]) transitions++;
    }
    expect(transitions).toBe(1);
  });
});

describe("assessRain", () => {
  const okRadar = (over: Partial<{ frameAgeMinutes: number; rainNowMmHr: number; nearestRainKm: number; wetMinutesAgo: number | null }>) => ({
    status: "ok",
    frameAgeMinutes: 5,
    rainNowMmHr: 0,
    nearestRainKm: 20,
    wetMinutesAgo: null as number | null,
    ...over,
  });

  it("radar dry now + wetMinutesAgo 10 -> active + latched (rain hold)", () => {
    const r = assessRain({
      radar: okRadar({ wetMinutesAgo: 10 }),
      nowcastState: "dry",
      corroborated: false,
      stormSignal: false,
      nowMs: NOW,
      anchor,
    });
    expect(r.active).toBe(true);
    expect(r.latched).toBe(true);
  });

  it("wetMinutesAgo 25 -> inactive (past the 20-min hold)", () => {
    const r = assessRain({
      radar: okRadar({ wetMinutesAgo: 25 }),
      nowcastState: "dry",
      corroborated: false,
      stormSignal: false,
      nowMs: NOW,
      anchor,
    });
    expect(r.active).toBe(false);
    expect(r.latched).toBe(false);
  });

  it("wetMinutesAgo undefined + dry radar -> today's behavior: nowcast path only if corroborated", () => {
    // Uncorroborated nowcast under a confidently dry, fresh radar -> vetoed.
    const vetoed = assessRain({
      radar: okRadar({}),
      nowcastState: "raining",
      corroborated: false,
      stormSignal: false,
      nowMs: NOW,
      anchor,
    });
    expect(vetoed.active).toBe(false);

    // Corroborated nowcast, radar dry but not confidently so (missing
    // wetMinutesAgo behaves exactly like today: no hold, no veto data change)
    // still lets a corroborated nowcast signal through when radar doesn't
    // confidently veto it (e.g. radar itself errored/absent here).
    const corroborated = assessRain({
      radar: null,
      nowcastState: "raining",
      corroborated: true,
      stormSignal: false,
      nowMs: NOW,
      anchor,
    });
    expect(corroborated.active).toBe(true);
    expect(corroborated.latched).toBe(false);
  });

  it("absent wetMinutesAgo + corroborated nowcast raining + FRESH DRY radar -> confident veto wins (matches pre-change behavior)", () => {
    const r = assessRain({
      radar: okRadar({ wetMinutesAgo: undefined }),
      nowcastState: "raining",
      corroborated: true,
      stormSignal: false,
      nowMs: NOW,
      anchor,
    });
    expect(r.active).toBe(false);
    expect(r.confidentDryVeto).toBe(true);
  });

  it("absent wetMinutesAgo + corroborated nowcast raining + STALE radar -> no confident veto, active", () => {
    const r = assessRain({
      radar: okRadar({ wetMinutesAgo: undefined, frameAgeMinutes: 999 }), // past RADAR_DRY_VETO_MAX_AGE_MIN
      nowcastState: "raining",
      corroborated: true,
      stormSignal: false,
      nowMs: NOW,
      anchor,
    });
    expect(r.active).toBe(true);
    expect(r.confidentDryVeto).toBe(false);
  });

  it("radar wet now (rainNowMmHr > 0) -> active, not latched", () => {
    const r = assessRain({
      radar: okRadar({ rainNowMmHr: 1.2 }),
      nowcastState: "dry",
      corroborated: false,
      stormSignal: false,
      nowMs: NOW,
      anchor,
    });
    expect(r.active).toBe(true);
    expect(r.latched).toBe(false);
  });

  it("trace rain below RAIN_WET_MM_HR (0.1, far away) -> not wet now, confident dry veto", () => {
    const r = assessRain({
      radar: okRadar({ rainNowMmHr: 0.1, nearestRainKm: 12 }),
      nowcastState: "dry",
      corroborated: false,
      stormSignal: false,
      nowMs: NOW,
      anchor,
    });
    expect(r.active).toBe(false);
    expect(r.confidentDryVeto).toBe(true);
  });

  it("rainNowMmHr at RAIN_WET_MM_HR (0.5) -> wet now, active, not latched", () => {
    const r = assessRain({
      radar: okRadar({ rainNowMmHr: 0.5, nearestRainKm: 12 }),
      nowcastState: "dry",
      corroborated: false,
      stormSignal: false,
      nowMs: NOW,
      anchor,
    });
    expect(r.active).toBe(true);
    expect(r.latched).toBe(false);
  });

  it("trace rain below threshold but nearby (0.1 mm/hr, 3 km) -> wet now via nearby clause", () => {
    const r = assessRain({
      radar: okRadar({ rainNowMmHr: 0.1, nearestRainKm: 3 }),
      nowcastState: "dry",
      corroborated: false,
      stormSignal: false,
      nowMs: NOW,
      anchor,
    });
    expect(r.active).toBe(true);
    expect(r.latched).toBe(false);
  });
});
