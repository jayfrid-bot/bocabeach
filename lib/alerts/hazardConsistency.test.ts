// Phase 1d: the at-beach alert engine and the shared hazard assessment must
// never disagree. Same inputs — a 4.8 mi / 12 min strike, radar dry now but
// wet 10 min ago — fed through the alert engine, `assessLightning`/`assessRain`
// directly, and (when ready) the score's own `deriveMetrics`.

import { describe, it, expect, vi } from "vitest";
import { evaluateAtBeach, type AtBeachInput } from "@/lib/alerts/evaluate";
import { rainForFix, newRainCache } from "@/lib/alerts/rain";
import { assessLightning, assessRain, type HazardAnchor } from "@/lib/hazards/assess";
import { cellKey } from "@/lib/location/cell";
import { defaultPrefs } from "@/lib/db/types";
import { deriveMetrics } from "@/lib/score";
import { scorableSnapshot, wrapped } from "@/lib/alerts/fixtures";
import type { LightningData, PrecipRadarData, Wrapped } from "@/lib/types";

const NOW = Date.parse("2026-09-18T18:00:00Z");
const LAT = 26.35;
const LON = -80.07;
const SLUG = "boca-raton";
const ANCHOR: HazardAnchor = { kind: "point", lat: LAT, lon: LON, cell: cellKey(LAT, LON) };

const STRIKES: LightningData = {
  within10mi: 1,
  within20mi: 1,
  within25mi: 1,
  within50mi: 1,
  totalInArea: 1,
  stormEnergy: 1,
  nearestMi: 4.8,
  nearestMinutesAgo: 12,
  closeStrikeMinutesAgo: 12, // same strike is the only one within 5 mi
};

const RADAR: Wrapped<PrecipRadarData> = {
  source: "NOAA MRMS",
  status: "ok",
  fetchedAt: new Date(NOW).toISOString(),
  attribution: "NOAA MRMS",
  data: {
    rainNowMmHr: 0, // dry now
    nearestRainKm: null,
    nearestBearingDeg: null,
    coveragePct: null,
    motion: null,
    etaMinutes: null,
    frameIso: new Date(NOW - 2 * 60_000).toISOString(),
    framesUsed: 2,
    frameAgeMinutes: 2, // fresh
    wetMinutesAgo: 10, // wet 10 min ago
  },
};

describe("phase 1d — alerts and the shared hazard assessment never disagree", () => {
  it("lightning: assessLightning is active for the fixture, and the alert engine fires it", () => {
    const assessment = assessLightning({
      status: "ok",
      nearestMi: STRIKES.nearestMi,
      nearestMinutesAgo: STRIKES.nearestMinutesAgo,
      closeStrikeMinutesAgo: STRIKES.closeStrikeMinutesAgo,
      nowMs: NOW,
      anchor: ANCHOR,
    });
    expect(assessment.active).toBe(true);

    const input: AtBeachInput = {
      now: NOW,
      device: { prefs: defaultPrefs(), profile: null },
      presence: { slug: SLUG, lat: LAT, lon: LON, fixSource: "device" },
      beachName: "Boca Raton",
      strikes: STRIKES,
      rain: null,
      conditions: null,
    };
    const decisions = evaluateAtBeach(input).decisions;
    expect(decisions.some((d) => d.dedupKey.startsWith("lightning@"))).toBe(true);
  });

  it("rain: assessRain is active for the fixture (wet within the 20-min hold), and rainForFix agrees", async () => {
    const assessment = assessRain({
      radar: {
        status: RADAR.status,
        frameAgeMinutes: RADAR.data!.frameAgeMinutes,
        rainNowMmHr: RADAR.data!.rainNowMmHr,
        nearestRainKm: RADAR.data!.nearestRainKm,
        wetMinutesAgo: RADAR.data!.wetMinutesAgo,
      },
      nowcastState: null,
      corroborated: false,
      stormSignal: false,
      nowMs: NOW,
      anchor: ANCHOR,
    });
    expect(assessment.active).toBe(true);

    const read = await rainForFix(LAT, LON, SLUG, NOW, newRainCache(), RADAR);
    // This fixture is dry NOW but wet 10 min ago (inside the 20-min hold), so
    // `assessment.active` is true only via the latch — `rainingNow` (the
    // literal observation) stays false, and `hazardActive` is what agrees
    // with the shared assessment.
    expect(read?.rainingNow).toBe(false);
    expect(read?.hazardActive).toBe(assessment.active);
    expect(read?.latched).toBe(assessment.latched);

    // A latched hazard still suppresses rain-soon/rain-clearing — the alert
    // engine's rain subject stays quiet, which is the correct, consistent
    // read (it never sends a plain "it's raining" push — see evaluate.ts
    // rainSubject).
    const input: AtBeachInput = {
      now: NOW,
      device: { prefs: defaultPrefs(), profile: null },
      presence: { slug: SLUG, lat: LAT, lon: LON, fixSource: "device" },
      beachName: "Boca Raton",
      strikes: null,
      rain: read,
      conditions: null,
    };
    const decisions = evaluateAtBeach(input).decisions;
    expect(decisions.some((d) => d.dedupKey.startsWith("rain-soon@") || d.dedupKey.startsWith("rain-clearing@"))).toBe(
      false,
    );
  });

  it("score.ts deriveMetrics agrees with the same assessment for the same fixture", () => {
    // deriveMetrics is ready (lib/score.ts wires lightningWithin5mi/nowcastRaining
    // straight from assessLightning/assessRain's `.active`) — compare against it too.
    const snapshot = scorableSnapshot();
    snapshot.location = { ...snapshot.location, slug: SLUG, lat: LAT, lon: LON };
    snapshot.lightning = wrapped<LightningData>(STRIKES);
    snapshot.precipRadar = RADAR;

    const derived = deriveMetrics(snapshot, NOW);
    expect(derived.lightningWithin5mi).toBe(true);
    expect(derived.nowcastRaining).toBe(true);
  });
});

describe("phase 1d — INACTIVE fixtures agree everywhere too", () => {
  // A strike just past the 30-minute hold (LIGHTNING_HOLD_MIN) — history, not
  // a warning.
  const STRIKES_STALE: LightningData = { ...STRIKES, nearestMinutesAgo: 31, closeStrikeMinutesAgo: 31 };
  // Dry now, and the last wet reading is past the 20-minute hold (RAIN_HOLD_MIN).
  const RADAR_STALE_WET: Wrapped<PrecipRadarData> = {
    ...RADAR,
    data: { ...RADAR.data!, wetMinutesAgo: 25 },
  };

  it("lightning: a 31-minute-old strike is inactive, and no subject fires", () => {
    const assessment = assessLightning({
      status: "ok",
      nearestMi: STRIKES_STALE.nearestMi,
      nearestMinutesAgo: STRIKES_STALE.nearestMinutesAgo,
      closeStrikeMinutesAgo: STRIKES_STALE.closeStrikeMinutesAgo,
      nowMs: NOW,
      anchor: ANCHOR,
    });
    expect(assessment.active).toBe(false);

    const input: AtBeachInput = {
      now: NOW,
      device: { prefs: defaultPrefs(), profile: null },
      presence: { slug: SLUG, lat: LAT, lon: LON, fixSource: "device" },
      beachName: "Boca Raton",
      strikes: STRIKES_STALE,
      rain: null,
      conditions: null,
    };
    const decisions = evaluateAtBeach(input).decisions;
    expect(decisions.some((d) => d.dedupKey.startsWith("lightning@"))).toBe(false);
  });

  it("rain: dry now with a 25-minute-old wet mark is past the hold, and rainForFix agrees", async () => {
    const assessment = assessRain({
      radar: {
        status: RADAR_STALE_WET.status,
        frameAgeMinutes: RADAR_STALE_WET.data!.frameAgeMinutes,
        rainNowMmHr: RADAR_STALE_WET.data!.rainNowMmHr,
        nearestRainKm: RADAR_STALE_WET.data!.nearestRainKm,
        wetMinutesAgo: RADAR_STALE_WET.data!.wetMinutesAgo,
      },
      nowcastState: null,
      corroborated: false,
      stormSignal: false,
      nowMs: NOW,
      anchor: ANCHOR,
    });
    expect(assessment.active).toBe(false);

    const read = await rainForFix(LAT, LON, SLUG, NOW, newRainCache(), RADAR_STALE_WET);
    expect(read?.rainingNow).toBe(false);
    expect(read?.hazardActive).toBe(assessment.active);
    expect(read?.latched).toBe(assessment.latched);

    const input: AtBeachInput = {
      now: NOW,
      device: { prefs: defaultPrefs(), profile: null },
      presence: { slug: SLUG, lat: LAT, lon: LON, fixSource: "device" },
      beachName: "Boca Raton",
      strikes: null,
      rain: read,
      conditions: null,
    };
    const decisions = evaluateAtBeach(input).decisions;
    expect(
      decisions.some((d) => d.dedupKey.startsWith("rain-soon@") || d.dedupKey.startsWith("rain-clearing@")),
    ).toBe(false);
  });
});

describe("phase 1d — a latched rain hold suppresses clearing but not a real ETA (Codex review #2)", () => {
  // Same dry-now/wet-10-min-ago radar as the top fixture, but with an ETA on
  // the upstream advection track — a latched hazard must not erase honest
  // "rain is coming" information, only the "all clear" message.
  const LATCHED_RADAR_WITH_ETA: Wrapped<PrecipRadarData> = {
    ...RADAR,
    data: { ...RADAR.data!, etaMinutes: 12 },
  };

  it("marks no rain-wet, holds back clearing, but still surfaces the ETA", async () => {
    const read = await rainForFix(LAT, LON, SLUG, NOW, newRainCache(), LATCHED_RADAR_WITH_ETA);
    expect(read?.hazardActive).toBe(true);
    expect(read?.latched).toBe(true);
    // Bookkeeping (the `rain-wet` mark in run.ts) is keyed off this literal
    // field, and it must stay false through the latch.
    expect(read?.rainingNow).toBe(false);
    // The ETA is bookkeeping too, and only the literal observation may erase
    // it — a latched-but-dry read keeps it.
    expect(read?.etaMinutes).toBe(12);

    const input: AtBeachInput = {
      now: NOW,
      device: { prefs: defaultPrefs(), profile: null },
      presence: { slug: SLUG, lat: LAT, lon: LON, fixSource: "device" },
      beachName: "Boca Raton",
      strikes: null,
      rain: read,
      conditions: null,
    };
    const decisions = evaluateAtBeach(input).decisions;
    expect(decisions.some((d) => d.dedupKey.startsWith("rain-clearing@"))).toBe(false);
    expect(decisions.some((d) => d.dedupKey.startsWith("rain-soon@"))).toBe(true);
  });
});

describe("phase 1d — the rain anchor label matches what the read actually covers (Codex review #1)", () => {
  it("beach radar anchors to the beach, not the fix's point", async () => {
    const read = await rainForFix(LAT, LON, SLUG, NOW, newRainCache(), RADAR);
    expect(read?.anchor).toEqual({ kind: "beach", slug: SLUG });
  });

  it("the cell forecast anchors to the fix's own point", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({
          minutely_15: {
            time: ["2026-09-18T18:15"],
            precipitation: [0],
            precipitation_probability: [0],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    try {
      const read = await rainForFix(LAT, LON, SLUG, NOW, newRainCache(), null);
      expect(read?.source).toBe("forecast");
      expect(read?.anchor).toEqual({ kind: "point", lat: LAT, lon: LON, cell: cellKey(LAT, LON) });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("phase 1d round 3 — a trace radar reading agrees on both sides of RAIN_WET_MM_HR", () => {
  const radarWith = (rainNowMmHr: number): Wrapped<PrecipRadarData> => ({
    ...RADAR,
    data: { ...RADAR.data!, rainNowMmHr, nearestRainKm: 12, wetMinutesAgo: null },
  });

  it("0.1 mm/hr trace: literal rainingNow and the hazard's active both read dry, no latch", async () => {
    const radar = radarWith(0.1);
    const assessment = assessRain({
      radar: {
        status: radar.status,
        frameAgeMinutes: radar.data!.frameAgeMinutes,
        rainNowMmHr: radar.data!.rainNowMmHr,
        nearestRainKm: radar.data!.nearestRainKm,
        wetMinutesAgo: radar.data!.wetMinutesAgo,
      },
      nowcastState: null,
      corroborated: false,
      stormSignal: false,
      nowMs: NOW,
      anchor: ANCHOR,
    });
    expect(assessment.active).toBe(false);
    expect(assessment.confidentDryVeto).toBe(true);

    const read = await rainForFix(LAT, LON, SLUG, NOW, newRainCache(), radar);
    expect(read?.rainingNow).toBe(false);
    expect(read?.hazardActive).toBe(assessment.active);
    expect(read?.latched).toBe(assessment.latched);
  });

  it("0.6 mm/hr: literal rainingNow and the hazard's active both read wet, no latch", async () => {
    const radar = radarWith(0.6);
    const assessment = assessRain({
      radar: {
        status: radar.status,
        frameAgeMinutes: radar.data!.frameAgeMinutes,
        rainNowMmHr: radar.data!.rainNowMmHr,
        nearestRainKm: radar.data!.nearestRainKm,
        wetMinutesAgo: radar.data!.wetMinutesAgo,
      },
      nowcastState: null,
      corroborated: false,
      stormSignal: false,
      nowMs: NOW,
      anchor: ANCHOR,
    });
    expect(assessment.active).toBe(true);
    expect(assessment.latched).toBe(false);

    const read = await rainForFix(LAT, LON, SLUG, NOW, newRainCache(), radar);
    expect(read?.rainingNow).toBe(true);
    expect(read?.hazardActive).toBe(assessment.active);
    expect(read?.latched).toBe(assessment.latched);
  });
});
