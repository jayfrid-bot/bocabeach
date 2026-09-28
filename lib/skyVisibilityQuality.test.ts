import { describe, it, expect } from "vitest";
import {
  skyVisibilityQuality,
  type SkyHourlyPoint,
} from "@/lib/skyVisibilityQuality";

// A tidy run of UTC hourly rows starting at `startIso`, one per hour, all
// clear (0% cloud) by default. `overrides` patches specific hours by index.
function hourlyRun(
  startIso: string,
  count: number,
  overrides?: Record<number, Partial<SkyHourlyPoint>>,
): SkyHourlyPoint[] {
  const startMs = Date.parse(startIso);
  const rows: SkyHourlyPoint[] = [];
  for (let i = 0; i < count; i++) {
    rows.push({
      time: new Date(startMs + i * 3_600_000).toISOString(),
      cloudCoverPct: 0,
      cloudCoverLowPct: 0,
      cloudCoverMidPct: 0,
      cloudCoverHighPct: 0,
      precipProbability: 0,
      precipIn: 0,
      ...overrides?.[i],
    });
  }
  return rows;
}

describe("skyVisibilityQuality", () => {
  it("clear night → Amazing", () => {
    const window = { start: "2026-10-10T02:00:00Z", end: "2026-10-10T03:00:00Z" };
    const r = skyVisibilityQuality({ window, hourly: hourlyRun("2026-10-10T02:00:00Z", 1) });
    expect(r).not.toBeNull();
    expect(r!.label).toBe("Amazing");
    expect(r!.score).toBeGreaterThanOrEqual(90);
    expect(r!.drivers).toBeUndefined();
  });

  it("overcast → Poor", () => {
    const window = { start: "2026-10-10T02:00:00Z", end: "2026-10-10T03:00:00Z" };
    const hourly = hourlyRun("2026-10-10T02:00:00Z", 1, {
      0: { cloudCoverPct: 100, cloudCoverLowPct: 100, cloudCoverMidPct: 100, cloudCoverHighPct: 100 },
    });
    const r = skyVisibilityQuality({ window, hourly });
    expect(r).not.toBeNull();
    expect(r!.label).toBe("Poor");
    expect(r!.score).toBeLessThan(20);
  });

  it("cloud amount is monotonic — more cloud never scores higher", () => {
    const mk = (pct: number) =>
      skyVisibilityQuality({
        window: { start: "2026-10-10T02:00:00Z", end: "2026-10-10T03:00:00Z" },
        hourly: hourlyRun("2026-10-10T02:00:00Z", 1, {
          0: { cloudCoverPct: pct, cloudCoverLowPct: pct, cloudCoverMidPct: pct, cloudCoverHighPct: pct },
        }),
      });
    const scores = [0, 10, 25, 40, 60, 80, 100].map((pct) => mk(pct)!.score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
    }
  });

  it("rain caps the score at Poor even with an otherwise clear/good sky", () => {
    const window = { start: "2026-10-10T02:00:00Z", end: "2026-10-10T03:00:00Z" };
    const clear = skyVisibilityQuality({ window, hourly: hourlyRun("2026-10-10T02:00:00Z", 1) })!;
    expect(clear.label).not.toBe("Poor");

    const rainy = skyVisibilityQuality({
      window,
      hourly: hourlyRun("2026-10-10T02:00:00Z", 1, { 0: { weatherCode: 61, precipIn: 0.1 } }),
    });
    expect(rainy).not.toBeNull();
    expect(rainy!.label).toBe("Poor");
    expect(rainy!.score).toBeLessThan(20);
    expect(rainy!.drivers).toContain("Rain in the window blocks the view.");
  });

  it("a high precip probability alone (no measurable rain yet) also caps at Poor", () => {
    const window = { start: "2026-10-10T02:00:00Z", end: "2026-10-10T03:00:00Z" };
    const r = skyVisibilityQuality({
      window,
      hourly: hourlyRun("2026-10-10T02:00:00Z", 1, { 0: { precipProbability: 80 } }),
    });
    expect(r).not.toBeNull();
    expect(r!.label).toBe("Poor");
  });

  it("fog caps the score at Poor even under an otherwise clear sky", () => {
    const window = { start: "2026-10-10T02:00:00Z", end: "2026-10-10T03:00:00Z" };
    const r = skyVisibilityQuality({
      window,
      hourly: hourlyRun("2026-10-10T02:00:00Z", 1, { 0: { weatherCode: 45 } }),
    });
    expect(r).not.toBeNull();
    expect(r!.label).toBe("Poor");
    expect(r!.drivers).toContain("Fog reduces visibility.");
  });

  it("near-total low cloud (>=85%) caps at Poor even with clear mid/high above it", () => {
    const window = { start: "2026-10-10T02:00:00Z", end: "2026-10-10T03:00:00Z" };
    const r = skyVisibilityQuality({
      window,
      hourly: hourlyRun("2026-10-10T02:00:00Z", 1, {
        0: { cloudCoverLowPct: 90, cloudCoverMidPct: 0, cloudCoverHighPct: 0, cloudCoverPct: 30 },
      }),
    });
    expect(r).not.toBeNull();
    expect(r!.label).toBe("Poor");
    expect(r!.drivers).toContain("Heavy low cloud blankets the sky.");
  });

  it("partial coverage — a gap anywhere inside the window → null, never guessed", () => {
    // 3-hour window, but the middle hour is simply missing from the feed.
    const window = { start: "2026-10-10T02:00:00Z", end: "2026-10-10T05:00:00Z" };
    const hourly = [
      { time: "2026-10-10T02:00:00Z", cloudCoverPct: 0 },
      // 03:00 row missing
      { time: "2026-10-10T04:00:00Z", cloudCoverPct: 0 },
    ];
    const r = skyVisibilityQuality({ window, hourly });
    expect(r).toBeNull();
  });

  it("a window reaching beyond the available forecast rows → null", () => {
    const window = { start: "2026-10-10T02:00:00Z", end: "2026-10-17T02:00:00Z" }; // 7 days out
    const r = skyVisibilityQuality({ window, hourly: hourlyRun("2026-10-10T02:00:00Z", 4) }); // only 4h available
    expect(r).toBeNull();
  });

  it("a row with no usable cloud reading (no total, no level split) → null", () => {
    const window = { start: "2026-10-10T02:00:00Z", end: "2026-10-10T03:00:00Z" };
    const r = skyVisibilityQuality({ window, hourly: [{ time: "2026-10-10T02:00:00Z" }] });
    expect(r).toBeNull();
  });

  it("window straddling hours uses every overlapping hour, worst one conservatively", () => {
    // 13:30–15:30 overlaps the 13:00, 14:00, and 15:00 buckets. Make the
    // middle hour overcast — the window should read that worst hour, not
    // the clear hours on either side.
    const window = { start: "2026-10-10T13:30:00Z", end: "2026-10-10T15:30:00Z" };
    const hourly = [
      { time: "2026-10-10T13:00:00Z", cloudCoverPct: 0 },
      { time: "2026-10-10T14:00:00Z", cloudCoverPct: 100 },
      { time: "2026-10-10T15:00:00Z", cloudCoverPct: 0 },
    ];
    const r = skyVisibilityQuality({ window, hourly });
    expect(r).not.toBeNull();
    expect(r!.label).toBe("Poor"); // dragged down by the worst (14:00) hour
    // The interval reported back is the caller's own window, not a trimmed one.
    expect(r!.sampledOver).toEqual(window);
  });

  it("a zero-width window (start === end) samples the single hour covering that instant", () => {
    const instant = "2026-10-10T13:45:00Z";
    const r = skyVisibilityQuality({
      window: { start: instant, end: instant },
      hourly: [{ time: "2026-10-10T13:00:00Z", cloudCoverPct: 0 }],
    });
    expect(r).not.toBeNull();
    expect(r!.label).toBe("Amazing");
  });

  describe("moonlight penalty", () => {
    const window = { start: "2026-10-10T02:00:00Z", end: "2026-10-10T03:00:00Z" };
    const clearHourly = hourlyRun("2026-10-10T02:00:00Z", 1);

    it("is NOT applied when the Moon is below the horizon, however bright", () => {
      const r = skyVisibilityQuality({
        window,
        hourly: clearHourly,
        moon: { aboveHorizon: false, illuminationPct: 95 },
      });
      expect(r).not.toBeNull();
      expect(r!.label).toBe("Amazing");
    });

    it("is NOT applied at exactly 70% illumination — the rule is strictly >70%", () => {
      const r = skyVisibilityQuality({
        window,
        hourly: clearHourly,
        moon: { aboveHorizon: true, illuminationPct: 70 },
      });
      expect(r).not.toBeNull();
      expect(r!.label).toBe("Amazing");
    });

    it("caps at Fair when the Moon is above the horizon and >70% illuminated", () => {
      const r = skyVisibilityQuality({
        window,
        hourly: clearHourly,
        moon: { aboveHorizon: true, illuminationPct: 95 },
      });
      expect(r).not.toBeNull();
      expect(r!.label).toBe("Fair");
      expect(r!.score).toBeLessThanOrEqual(44);
      expect(r!.drivers?.some((d) => d.includes("Bright moon"))).toBe(true);
    });

    it("a hard cap (fog/rain/heavy low cloud) still wins over a mere moonlight Fair cap", () => {
      const r = skyVisibilityQuality({
        window,
        hourly: hourlyRun("2026-10-10T02:00:00Z", 1, { 0: { weatherCode: 45 } }),
        moon: { aboveHorizon: true, illuminationPct: 95 },
      });
      expect(r).not.toBeNull();
      expect(r!.label).toBe("Poor");
    });
  });

  it("DST transition (US spring-forward, 2026-03-08) — pure UTC bucketing is unaffected", () => {
    // 07:00–09:00 UTC on the US spring-forward date; nothing here reads a
    // local clock, so this should behave exactly like any other 2-hour
    // window straddling two hourly buckets.
    const window = { start: "2026-03-08T07:00:00Z", end: "2026-03-08T09:00:00Z" };
    const hourly = [
      { time: "2026-03-08T07:00:00Z", cloudCoverPct: 0 },
      { time: "2026-03-08T08:00:00Z", cloudCoverPct: 0 },
    ];
    const r = skyVisibilityQuality({ window, hourly });
    expect(r).not.toBeNull();
    expect(r!.label).toBe("Amazing");
    expect(r!.sampledOver).toEqual(window);
  });

  it("malformed window (end before start) → null rather than throwing", () => {
    const r = skyVisibilityQuality({
      window: { start: "2026-10-10T03:00:00Z", end: "2026-10-10T02:00:00Z" },
      hourly: hourlyRun("2026-10-10T02:00:00Z", 2),
    });
    expect(r).toBeNull();
  });

  it("color always matches SUN_QUALITY_BANDS' own hex for the returned label", async () => {
    const { SUN_QUALITY_BANDS } = await import("@/lib/sunQuality");
    const window = { start: "2026-10-10T02:00:00Z", end: "2026-10-10T03:00:00Z" };
    const r = skyVisibilityQuality({ window, hourly: hourlyRun("2026-10-10T02:00:00Z", 1) })!;
    const meta = SUN_QUALITY_BANDS.find((b) => b.label === r.label);
    expect(meta).toBeDefined();
    expect(r.color).toBe(meta!.color);
  });
});
