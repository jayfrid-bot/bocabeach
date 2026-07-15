import { describe, expect, it } from "vitest";
import {
  arcPoint,
  daylightFraction,
  daylightStatusLabel,
  fmtDurationShort,
  goldenHourWindows,
  isDaylight,
  isGoldenHour,
  nightArcPoint,
  nightProgress,
} from "@/lib/sunArc";

const T = (s: string) => Date.parse(s);

describe("isDaylight", () => {
  it("true strictly between sunrise and sunset", () => {
    const span = { sunriseMs: T("2026-07-15T10:00:00Z"), sunsetMs: T("2026-07-15T23:00:00Z") };
    expect(isDaylight(T("2026-07-15T15:00:00Z"), span)).toBe(true);
    expect(isDaylight(T("2026-07-15T09:00:00Z"), span)).toBe(false);
    expect(isDaylight(T("2026-07-16T00:00:00Z"), span)).toBe(false);
  });

  it("false for a degenerate span", () => {
    expect(isDaylight(T("2026-07-15T15:00:00Z"), { sunriseMs: T("2026-07-15T20:00:00Z"), sunsetMs: T("2026-07-15T10:00:00Z") })).toBe(false);
  });
});

describe("daylightFraction", () => {
  it("is 0 at sunrise and 1 at sunset (linear, no solar noon given)", () => {
    const span = { sunriseMs: T("2026-07-15T10:00:00Z"), sunsetMs: T("2026-07-15T22:00:00Z") };
    expect(daylightFraction(span.sunriseMs, span)).toBe(0);
    expect(daylightFraction(span.sunsetMs, span)).toBe(1);
    expect(daylightFraction(T("2026-07-15T16:00:00Z"), span)).toBeCloseTo(0.5, 5);
  });

  it("uses the real solar noon as the 0.5 apex, not the sunrise/sunset midpoint", () => {
    // Sunrise 06:00, sunset 20:00 (midpoint would be 13:00), but solar noon
    // is skewed to 13:40 — the honest mapping should put fraction 0.5 there.
    const span = {
      sunriseMs: T("2026-07-15T06:00:00Z"),
      sunsetMs: T("2026-07-15T20:00:00Z"),
      solarNoonMs: T("2026-07-15T13:40:00Z"),
    };
    expect(daylightFraction(span.solarNoonMs!, span)).toBeCloseTo(0.5, 5);
    // The naive midpoint (13:00) is BEFORE the real apex now, so its fraction
    // should read less than 0.5 under the honest two-segment mapping.
    expect(daylightFraction(T("2026-07-15T13:00:00Z"), span)).toBeLessThan(0.5);
  });

  it("ignores an out-of-range solar noon and falls back to linear", () => {
    const span = {
      sunriseMs: T("2026-07-15T06:00:00Z"),
      sunsetMs: T("2026-07-15T20:00:00Z"),
      solarNoonMs: T("2026-07-15T21:00:00Z"), // after sunset — bogus, ignore
    };
    expect(daylightFraction(T("2026-07-15T13:00:00Z"), span)).toBeCloseTo(0.5, 5);
  });

  it("clamps outside [sunrise, sunset]", () => {
    const span = { sunriseMs: T("2026-07-15T06:00:00Z"), sunsetMs: T("2026-07-15T20:00:00Z") };
    expect(daylightFraction(T("2026-07-15T00:00:00Z"), span)).toBe(0);
    expect(daylightFraction(T("2026-07-16T00:00:00Z"), span)).toBe(1);
  });
});

describe("goldenHourWindows", () => {
  it("is the first/last hour of daylight, derived from real times", () => {
    const span = { sunriseMs: T("2026-07-15T06:00:00Z"), sunsetMs: T("2026-07-15T20:00:00Z") };
    const w = goldenHourWindows(span)!;
    expect(w.morning.startMs).toBe(span.sunriseMs);
    expect(w.morning.endMs - w.morning.startMs).toBe(3_600_000);
    expect(w.evening.endMs).toBe(span.sunsetMs);
    expect(w.evening.endMs - w.evening.startMs).toBe(3_600_000);
  });

  it("clamps to meet at the midpoint on a very short day instead of overlapping", () => {
    const span = { sunriseMs: T("2026-07-15T06:00:00Z"), sunsetMs: T("2026-07-15T07:00:00Z") }; // 1h day
    const w = goldenHourWindows(span)!;
    expect(w.morning.endMs).toBe(w.evening.startMs);
  });

  it("null for a degenerate span", () => {
    expect(goldenHourWindows({ sunriseMs: T("2026-07-15T20:00:00Z"), sunsetMs: T("2026-07-15T06:00:00Z") })).toBeNull();
  });
});

describe("isGoldenHour", () => {
  const span = { sunriseMs: T("2026-07-15T06:00:00Z"), sunsetMs: T("2026-07-15T20:00:00Z") };
  it("true right after sunrise and right before sunset", () => {
    expect(isGoldenHour(T("2026-07-15T06:30:00Z"), span)).toBe(true);
    expect(isGoldenHour(T("2026-07-15T19:45:00Z"), span)).toBe(true);
  });
  it("false at midday", () => {
    expect(isGoldenHour(T("2026-07-15T13:00:00Z"), span)).toBe(false);
  });
});

describe("nightProgress", () => {
  const span = { sunriseMs: T("2026-07-15T06:00:00Z"), sunsetMs: T("2026-07-15T20:00:00Z") }; // 14h day, 10h night
  it("null during the day", () => {
    expect(nightProgress(T("2026-07-15T13:00:00Z"), span)).toBeNull();
  });
  it("0 right at sunset, climbing after", () => {
    expect(nightProgress(span.sunsetMs, span)).toBeCloseTo(0, 5);
    const p = nightProgress(T("2026-07-15T21:00:00Z"), span)!;
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
  });
  it("approaches 1 near the estimated next sunrise (before today's sunrise)", () => {
    const p = nightProgress(T("2026-07-15T05:30:00Z"), span)!;
    expect(p).toBeGreaterThan(0.9);
    expect(p).toBeLessThanOrEqual(1);
  });
});

describe("fmtDurationShort", () => {
  it("formats hours and minutes", () => {
    expect(fmtDurationShort(2 * 3_600_000 + 10 * 60_000)).toBe("2h 10m");
    expect(fmtDurationShort(45 * 60_000)).toBe("45m");
    expect(fmtDurationShort(3 * 3_600_000)).toBe("3h");
  });
  it("floors negative/zero to 0m", () => {
    expect(fmtDurationShort(-5000)).toBe("0m");
  });
});

describe("daylightStatusLabel", () => {
  const span = { sunriseMs: T("2026-07-15T10:00:00Z"), sunsetMs: T("2026-07-15T23:00:00Z") };
  it("counts down to sunset during the day", () => {
    expect(daylightStatusLabel(T("2026-07-15T20:50:00Z"), span)).toBe("Sunset in 2h 10m");
  });
  it("counts down to sunrise before daylight", () => {
    expect(daylightStatusLabel(T("2026-07-15T08:00:00Z"), span)).toBe("Sunrise in 2h");
  });
  it("null after sunset (no fabricated next-day countdown)", () => {
    expect(daylightStatusLabel(T("2026-07-16T00:00:00Z"), span)).toBeNull();
  });
});

describe("arcPoint", () => {
  const geo = { width: 320, paddingX: 22, horizonY: 84, apexY: 20 };
  it("sits on the horizon at both ends", () => {
    expect(arcPoint(0, geo)).toEqual({ x: 22, y: 84 });
    expect(arcPoint(1, geo)).toEqual({ x: 298, y: 84 });
  });
  it("reaches the apex height at f=0.5", () => {
    const p = arcPoint(0.5, geo);
    expect(p.y).toBe(20);
    expect(p.x).toBeCloseTo(160, 0);
  });
  it("clamps out-of-range fractions", () => {
    expect(arcPoint(-1, geo)).toEqual(arcPoint(0, geo));
    expect(arcPoint(2, geo)).toEqual(arcPoint(1, geo));
  });
});

describe("nightArcPoint", () => {
  const geo = { width: 320, paddingX: 22, horizonY: 84, nightDepth: 32 };
  it("sits on the horizon at both ends and dips at the midpoint", () => {
    expect(nightArcPoint(0, geo).y).toBe(84);
    expect(nightArcPoint(1, geo).y).toBe(84);
    expect(nightArcPoint(0.5, geo).y).toBe(116);
  });
  it("starts at the RIGHT (sunset) edge and ends at the LEFT (sunrise) edge — the mirror of arcPoint, continuing the sun's rotation instead of jumping backward at dusk", () => {
    expect(nightArcPoint(0, geo).x).toBe(298); // right edge = width - paddingX
    expect(nightArcPoint(1, geo).x).toBe(22); // left edge = paddingX
  });
});
