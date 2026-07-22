import { describe, it, expect } from "vitest";
import {
  computeTideAberration,
  percentile,
  type TideWindowEvent,
} from "@/lib/tideAberration";

const TZ = "America/New_York";
// A fixed "now": 2026-07-15 13:00 America/New_York (17:00 UTC). Today = 2026-07-15.
const NOW = Date.parse("2026-07-15T17:00:00Z");
const DAY = 86_400_000;

/** ISO for a given day-offset from NOW at a fixed UTC hour (kept mid-day so the
 *  local NY calendar day is unambiguous — 12/20 UTC → 08/16 NY, same date). */
function iso(dayOffset: number, utcHour: number): string {
  const d = new Date(NOW + dayOffset * DAY).toISOString().slice(0, 10);
  return `${d}T${String(utcHour).padStart(2, "0")}:00:00.000Z`;
}

/**
 * Build a ±20-day window (41 local days) of one high + one low per day. Every
 * day EXCEPT today follows a smooth spring–neap sinusoid; today's high/low are
 * overridden so each test controls exactly the day under judgement.
 */
function buildWindow(todayHigh: number, todayLow: number, spanDays = 20): TideWindowEvent[] {
  const events: TideWindowEvent[] = [];
  for (let d = -spanDays; d <= spanDays; d++) {
    const phase = (2 * Math.PI * d) / 14; // ~fortnightly spring–neap cycle
    const hi = d === 0 ? todayHigh : 2.5 + 0.8 * Math.cos(phase);
    const lo = d === 0 ? todayLow : 0.3 - 0.8 * Math.cos(phase);
    events.push({ type: "high", time: iso(d, 12), heightFt: Math.round(hi * 100) / 100 });
    events.push({ type: "low", time: iso(d, 20), heightFt: Math.round(lo * 100) / 100 });
  }
  return events;
}

describe("percentile", () => {
  it("interpolates linearly (type-7)", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBeCloseTo(2.5, 6);
    expect(percentile([10], 90)).toBe(10);
    expect(percentile([0, 10], 90)).toBeCloseTo(9, 6);
  });
});

describe("computeTideAberration", () => {
  it("flags a clear KING tide day (today's high far above the band)", () => {
    const ab = computeTideAberration(buildWindow(4.0, 0.3), { nowMs: NOW, tz: TZ });
    expect(ab).not.toBeNull();
    expect(ab!.highStatus).toBe("king");
    expect(ab!.todayMaxHighFt).toBe(4.0);
    expect(ab!.deltaHighFt).toBeGreaterThanOrEqual(0.5);
    expect(ab!.todayMaxHighFt).toBeGreaterThanOrEqual(ab!.p90HighFt);
    // King highs shouldn't drag the low side into an aberration on their own.
    expect(ab!.lowStatus).toBe("normal");
    expect(ab!.windowDays).toBe(41);
  });

  it("reports NORMAL when today sits inside the band", () => {
    const ab = computeTideAberration(buildWindow(2.5, 0.3), { nowMs: NOW, tz: TZ });
    expect(ab).not.toBeNull();
    expect(ab!.highStatus).toBe("normal");
    expect(ab!.lowStatus).toBe("normal");
    expect(Math.abs(ab!.deltaHighFt)).toBeLessThan(0.5);
  });

  it("flags an UNUSUALLY LOW low (today's low far below the band)", () => {
    const ab = computeTideAberration(buildWindow(2.5, -1.5), { nowMs: NOW, tz: TZ });
    expect(ab).not.toBeNull();
    expect(ab!.lowStatus).toBe("very-low");
    expect(ab!.todayMinLowFt).toBe(-1.5);
    expect(ab!.todayMinLowFt).toBeLessThanOrEqual(ab!.p10LowFt);
    expect(ab!.deltaLowFt).toBeLessThanOrEqual(-0.5);
    expect(ab!.highStatus).toBe("normal");
  });

  it("classifies a near-king high as 'elevated' (>= p90 but < p95)", () => {
    // Craft a window whose top decile spans a wide range so a value can land
    // above p90 yet below p95, while still clearing the median by >= 0.5 ft.
    const highs = [
      1.6, 1.7, 1.8, 1.9, 2.0, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 3.0,
      3.1, 3.2, 3.6, 4.2, 4.8,
    ];
    // today's high = 3.7: above p90 (~3.85? tuned below) but below the 4.x tail.
    const events: TideWindowEvent[] = [];
    let day = -20; // baseline occupies days -20..-1, leaving day 0 for today only
    for (const h of highs) {
      events.push({ type: "high", time: iso(day, 12), heightFt: h });
      events.push({ type: "low", time: iso(day, 20), heightFt: 0.3 });
      day += 1;
    }
    // today (d=0): a high between p90 and p95, a normal low.
    events.push({ type: "high", time: iso(0, 12), heightFt: 3.7 });
    events.push({ type: "low", time: iso(0, 20), heightFt: 0.3 });
    const ab = computeTideAberration(events, { nowMs: NOW, tz: TZ })!;
    expect(ab.highStatus).toBe("elevated");
    expect(ab.todayMaxHighFt).toBeGreaterThanOrEqual(ab.p90HighFt);
  });

  it("returns null (honest-null) on a thin window (< 14 days)", () => {
    const events = buildWindow(4.0, 0.3, 5); // ±5 days = 11 local days
    const ab = computeTideAberration(events, { nowMs: NOW, tz: TZ });
    expect(ab).toBeNull();
  });

  it("returns null when today has no high/low in the window", () => {
    // Window centred elsewhere: nowMs a year later, so no event is 'today'.
    const events = buildWindow(4.0, 0.3);
    const farNow = NOW + 365 * DAY;
    expect(computeTideAberration(events, { nowMs: farNow, tz: TZ })).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(computeTideAberration([], { nowMs: NOW, tz: TZ })).toBeNull();
  });
});
