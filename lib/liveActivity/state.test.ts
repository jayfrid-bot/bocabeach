import { describe, it, expect } from "vitest";
import { contentStateFromConditions, hashContentState } from "@/lib/liveActivity/state";
import type { HazardAssessment } from "@/lib/hazards/assess";
import type { ConditionsResponse } from "@/lib/types";

const NOW = Date.parse("2026-06-01T15:00:00.000Z");

// deriveMetrics (lib/score.ts) — the consensus path state.ts now defers to
// for wind/waves — reads every one of ConditionsSnapshot's source wrappers
// unconditionally (e.g. `s.metno.data`), so the fixture must supply all of
// them, not just the ones this module's own mapping touches. Absent sources
// default to an honest "error"/no-data wrapper; deriveMetrics already
// tolerates that (it's the normal shape for a source that's down).
const emptySource = { status: "error" as const, data: null };

function res(over: Record<string, unknown> = {}): ConditionsResponse {
  return {
    score: {
      score: (over.score as number) ?? 84,
      dataAvailable: over.dataAvailable === undefined ? true : (over.dataAvailable as boolean),
    },
    snapshot: {
      location: { slug: "boca-raton", name: "Boca Raton" },
      generatedAt: (over.generatedAt as string) ?? new Date(NOW).toISOString(),
      weather: { status: "ok", data: over.weather ?? { windSpeedMph: 9, windDirDeg: 68 } },
      buoy: { status: "ok", data: over.buoy ?? { windGustMph: 14 } },
      marine: { status: "ok", data: over.marine ?? { waveHeightFt: 1.3 } },
      clarity: { status: "ok", data: over.clarity ?? { level: "clear" } },
      sargassum: { status: "ok", data: over.sargassum ?? { level: "low" } },
      tides: {
        status: "ok",
        data: over.tides ?? { next: [{ type: "low", time: "2026-06-01T17:14:00.000Z", heightFt: 0.2 }] },
      },
      sun: { status: "ok", data: over.sun ?? { date: "2026-06-01", sunset: "2026-06-01T18:12:00.000Z" } },
      lightning: {
        status: (over.lightningStatus as string) ?? "ok",
        data: over.lightning === undefined ? {} : (over.lightning as Record<string, unknown> | null),
      },
      // Untouched by this module's own mapping — only read by deriveMetrics
      // for its internal consensus math, which tolerates all-absent sources.
      cityOfficial: emptySource,
      waterQuality: emptySource,
      nowcast: emptySource,
      nws: emptySource,
      airQuality: emptySource,
      metno: emptySource,
      gfs: emptySource,
      goesCloud: emptySource,
      precipRadar: emptySource,
      busyness: emptySource,
      traffic: emptySource,
      forecast: { status: "error", data: [] },
      hourly: { status: "error", data: [] },
    },
  } as unknown as ConditionsResponse;
}

describe("contentStateFromConditions", () => {
  it("maps score, wind, waves, tide, sunset from the snapshot", () => {
    const s = contentStateFromConditions(res(), { nowMs: NOW });
    expect(s.score).toBe(84);
    expect(s.windMph).toBe(9);
    expect(s.gustMph).toBe(14);
    expect(s.windDeg).toBe(68);
    expect(s.waveFt).toBe(1.3);
    expect(s.nextTideAt).toBe(Date.parse("2026-06-01T17:14:00.000Z"));
    expect(s.nextTideKind).toBe("low");
    expect(s.sunsetAt).toBe(Date.parse("2026-06-01T18:12:00.000Z"));
    expect(s.updatedAt).toBe(NOW);
    expect(s.unavailable).toBeUndefined();
  });

  it("rounds a fractional score", () => {
    const s = contentStateFromConditions(res({ score: 83.6 }), { nowMs: NOW });
    expect(s.score).toBe(84);
  });

  it("flags unavailable when the score reports dataAvailable: false", () => {
    const s = contentStateFromConditions(res({ dataAvailable: false }), { nowMs: NOW });
    expect(s.unavailable).toBe(true);
  });

  it("uses the score's own consensus wind/wave path (deriveMetrics), not a single raw source", () => {
    // Buoy reports a wave height too — deriveMetrics prefers it over marine's,
    // same as score.ts's own `b?.waveHeightFt ?? m?.waveHeightFt`.
    const s = contentStateFromConditions(
      res({ buoy: { windGustMph: 14, waveHeightFt: 2.4 }, marine: { waveHeightFt: 1.3 } }),
      { nowMs: NOW },
    );
    expect(s.waveFt).toBe(2.4);
  });

  it("does not advance updatedAt past the snapshot's generatedAt when data is unavailable", () => {
    const generatedAt = "2026-06-01T14:30:00.000Z";
    const s = contentStateFromConditions(res({ dataAvailable: false, generatedAt }), { nowMs: NOW });
    expect(s.unavailable).toBe(true);
    expect(s.updatedAt).toBe(Date.parse(generatedAt));
  });

  it("still uses nowMs for updatedAt when data is available", () => {
    const s = contentStateFromConditions(res({ generatedAt: "2026-06-01T14:30:00.000Z" }), { nowMs: NOW });
    expect(s.updatedAt).toBe(NOW);
  });

  describe("sunsetAt", () => {
    it("omits sunset once it is in the past", () => {
      const s = contentStateFromConditions(res({ sun: { date: "2026-06-01", sunset: "2026-06-01T14:00:00.000Z" } }), {
        nowMs: NOW,
      });
      expect(s.sunsetAt).toBeUndefined();
    });

    it("keeps a sunset that has not happened yet", () => {
      const s = contentStateFromConditions(res(), { nowMs: NOW });
      expect(s.sunsetAt).toBe(Date.parse("2026-06-01T18:12:00.000Z"));
    });
  });

  describe("clarity / seaweed collapsing", () => {
    it("maps clear and murky variants", () => {
      expect(contentStateFromConditions(res({ clarity: { level: "clear" } }), { nowMs: NOW }).clarity).toBe("clear");
      expect(contentStateFromConditions(res({ clarity: { level: "slightly_murky" } }), { nowMs: NOW }).clarity).toBe(
        "murky",
      );
      expect(contentStateFromConditions(res({ clarity: { level: "churned" } }), { nowMs: NOW }).clarity).toBe(
        "murky",
      );
      expect(contentStateFromConditions(res({ clarity: { level: null } }), { nowMs: NOW }).clarity).toBeUndefined();
    });

    it("omits seaweed \"none\" and \"unknown\" rather than forcing a bucket", () => {
      expect(contentStateFromConditions(res({ sargassum: { level: "none" } }), { nowMs: NOW }).seaweed).toBeUndefined();
      expect(
        contentStateFromConditions(res({ sargassum: { level: "unknown" } }), { nowMs: NOW }).seaweed,
      ).toBeUndefined();
      expect(contentStateFromConditions(res({ sargassum: { level: "high" } }), { nowMs: NOW }).seaweed).toBe("high");
    });
  });

  describe("lightning", () => {
    it("prefers the point assessment when given one", () => {
      const active: HazardAssessment = {
        kind: "lightning",
        anchor: { kind: "point", lat: 1, lon: 2, cell: "c" },
        active: true,
        latched: true,
        severity: "lightning-near",
        observedAtIso: "2026-06-01T14:58:00.000Z",
        expiresAtIso: "2026-06-01T15:28:00.000Z",
        reason: "Lightning 4.8 miles away, 2 min ago",
      };
      const s = contentStateFromConditions(res(), {
        nowMs: NOW,
        lightningPoint: { lightning: active, lightningMi: 4.8 },
      });
      expect(s.lightning).toEqual({
        active: true,
        latched: true,
        miles: 4.8,
        bearingDeg: undefined,
        observedAt: Date.parse("2026-06-01T14:58:00.000Z"),
        holdUntil: Date.parse("2026-06-01T15:28:00.000Z"),
      });
    });

    it("omits lightning entirely when the point assessment is inactive", () => {
      const inactive: HazardAssessment = {
        kind: "lightning",
        anchor: { kind: "point", lat: 1, lon: 2, cell: "c" },
        active: false,
        latched: false,
        severity: "none",
        observedAtIso: null,
        expiresAtIso: null,
        reason: null,
      };
      const s = contentStateFromConditions(res(), {
        nowMs: NOW,
        lightningPoint: { lightning: inactive, lightningMi: null },
      });
      expect(s.lightning).toBeUndefined();
    });

    it("falls back to the beach's own assessLightning call from the snapshot when there is no point read", () => {
      const s = contentStateFromConditions(
        res({
          lightning: {
            closeStrikeMinutesAgo: 5,
            windowMinutes: 30,
            nearestMi: 3.2,
            nearestMinutesAgo: 5,
            nearestBearingDeg: 225,
          },
        }),
        { nowMs: NOW },
      );
      expect(s.lightning).toEqual({
        active: true,
        latched: false,
        miles: 3.2,
        bearingDeg: 225,
        observedAt: NOW - 5 * 60_000,
        holdUntil: NOW - 5 * 60_000 + 30 * 60_000,
      });
    });

    it("beach fallback is inactive (and omitted) when the feed reports no close strike", () => {
      const s = contentStateFromConditions(res({ lightning: {} }), { nowMs: NOW });
      expect(s.lightning).toBeUndefined();
    });
  });
});

describe("hashContentState", () => {
  it("is stable for identical states and ignores updatedAt", () => {
    const a = contentStateFromConditions(res(), { nowMs: NOW });
    const b = contentStateFromConditions(res(), { nowMs: NOW + 60_000 });
    expect(hashContentState(a)).toBe(hashContentState(b));
  });

  it("changes when a meaningful field changes", () => {
    const a = contentStateFromConditions(res(), { nowMs: NOW });
    const b = contentStateFromConditions(res({ score: 60 }), { nowMs: NOW });
    expect(hashContentState(a)).not.toBe(hashContentState(b));
  });

  // Codex review #8: coalescing — quantized noise never changes the hash,
  // but a real band-crossing move does.
  it("ignores a sub-band score wobble but catches a real move", () => {
    const a = contentStateFromConditions(res({ score: 84 }), { nowMs: NOW });
    const wobble = contentStateFromConditions(res({ score: 85 }), { nowMs: NOW }); // same 3-pt band
    const real = contentStateFromConditions(res({ score: 92 }), { nowMs: NOW }); // different band
    expect(hashContentState(a)).toBe(hashContentState(wobble));
    expect(hashContentState(a)).not.toBe(hashContentState(real));
  });

  it("ignores a sub-bucket wind change but catches a real gust", () => {
    const a = contentStateFromConditions(res({ weather: { windSpeedMph: 9, windDirDeg: 68 } }), { nowMs: NOW });
    const wobble = contentStateFromConditions(res({ weather: { windSpeedMph: 10, windDirDeg: 68 } }), {
      nowMs: NOW,
    });
    const real = contentStateFromConditions(res({ weather: { windSpeedMph: 22, windDirDeg: 68 } }), {
      nowMs: NOW,
    });
    expect(hashContentState(a)).toBe(hashContentState(wobble));
    expect(hashContentState(a)).not.toBe(hashContentState(real));
  });

  it("ignores a sub-compass-point windDeg wobble but catches a real direction shift", () => {
    const a = contentStateFromConditions(res({ weather: { windSpeedMph: 9, windDirDeg: 68 } }), { nowMs: NOW });
    // 68 -> 67.5 both round to the same 22.5°-step compass point (67.5, "ENE").
    const wobble = contentStateFromConditions(res({ weather: { windSpeedMph: 9, windDirDeg: 67 } }), {
      nowMs: NOW,
    });
    // A real swing to a different compass point (E, 90).
    const real = contentStateFromConditions(res({ weather: { windSpeedMph: 9, windDirDeg: 95 } }), {
      nowMs: NOW,
    });
    expect(hashContentState(a)).toBe(hashContentState(wobble));
    expect(hashContentState(a)).not.toBe(hashContentState(real));
  });

  it("wraps a windDeg near 360 back to the 0/N bucket", () => {
    const near360 = contentStateFromConditions(res({ weather: { windSpeedMph: 9, windDirDeg: 359 } }), {
      nowMs: NOW,
    });
    const north = contentStateFromConditions(res({ weather: { windSpeedMph: 9, windDirDeg: 1 } }), {
      nowMs: NOW,
    });
    expect(hashContentState(near360)).toBe(hashContentState(north));
  });

  it("rounds tide/sunset epochs to the minute so re-fetch jitter doesn't change the hash", () => {
    const a = contentStateFromConditions(res(), { nowMs: NOW });
    const jitter = contentStateFromConditions(
      res({ tides: { next: [{ type: "low", time: "2026-06-01T17:14:20.000Z", heightFt: 0.2 }] } }),
      { nowMs: NOW },
    );
    expect(hashContentState(a)).toBe(hashContentState(jitter));
  });
});
