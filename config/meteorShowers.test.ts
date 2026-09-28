import { describe, it, expect } from "vitest";
import { METEOR_SHOWERS } from "@/config/meteorShowers";

const MAJOR_SHOWER_IDS = [
  "quadrantids",
  "lyrids",
  "eta-aquariids",
  "perseids",
  "orionids",
  "leonids",
  "geminids",
];

describe("METEOR_SHOWERS — static shape", () => {
  it("has exactly the 7 major showers, no duplicates", () => {
    const ids = METEOR_SHOWERS.map((s) => s.showerId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual([...MAJOR_SHOWER_IDS].sort());
  });

  it("every shower has plausible radiant/ZHR values", () => {
    for (const s of METEOR_SHOWERS) {
      expect(s.radiantRaDeg).toBeGreaterThanOrEqual(0);
      expect(s.radiantRaDeg).toBeLessThan(360);
      expect(s.radiantDecDeg).toBeGreaterThanOrEqual(-90);
      expect(s.radiantDecDeg).toBeLessThanOrEqual(90);
      expect(s.zhr).toBeGreaterThan(0);
      expect(s.zhr).toBeLessThan(1000);
    }
  });

  it("every peak entry's activity window contains its peak, and start < end", () => {
    for (const s of METEOR_SHOWERS) {
      for (const p of s.peaks) {
        const peakMs = Date.parse(p.peak);
        const startMs = Date.parse(p.activityWindow.start);
        const endMs = Date.parse(p.activityWindow.end);
        expect(startMs).toBeLessThan(endMs);
        expect(peakMs).toBeGreaterThanOrEqual(startMs);
        expect(peakMs).toBeLessThan(endMs);
        expect(p.sourceEdition.length).toBeGreaterThan(0);
      }
    }
  });

  it("every ISO instant is UTC (ends in Z), never a bare local-time string", () => {
    for (const s of METEOR_SHOWERS) {
      for (const p of s.peaks) {
        expect(p.peak.endsWith("Z")).toBe(true);
        expect(p.activityWindow.start.endsWith("Z")).toBe(true);
        expect(p.activityWindow.end.endsWith("Z")).toBe(true);
      }
    }
  });

  it("Quadrantids' activity window starts in the PRIOR Gregorian year (year-rollover case)", () => {
    const quad = METEOR_SHOWERS.find((s) => s.showerId === "quadrantids")!;
    for (const p of quad.peaks) {
      const startYear = new Date(p.activityWindow.start).getUTCFullYear();
      expect(startYear).toBe(p.year - 1);
    }
  });

  it("no peak year appears twice for the same shower", () => {
    for (const s of METEOR_SHOWERS) {
      const years = s.peaks.map((p) => p.year);
      expect(new Set(years).size).toBe(years.length);
    }
  });
});

// --- CI-style freshness gate -------------------------------------------------
//
// SKY_EVENTS_PLAN.md §6: "config/meteorShowers.ts always carries data for
// the current year and the next year; a CI check fails the build if either
// is missing." This uses the REAL wall clock deliberately — it's a
// build-time data-freshness gate (like a linter), not part of the app's
// SSR-safe selection logic (which stays pure/nowMs-injected elsewhere in
// this feature, see lib/sources/meteorShowers.ts). Running this suite in
// CI on a date past 2027-12-31 without the table having been extended is
// exactly the failure this test exists to catch.
describe("CI gate: current + next year coverage", () => {
  const currentYear = new Date().getUTCFullYear();
  const nextYear = currentYear + 1;

  it.each(MAJOR_SHOWER_IDS)("%s has a peak entry for the current year (%s)", (showerId) => {
    const shower = METEOR_SHOWERS.find((s) => s.showerId === showerId);
    expect(shower, `shower "${showerId}" missing from METEOR_SHOWERS entirely`).toBeDefined();
    const hasCurrent = shower!.peaks.some((p) => p.year === currentYear);
    expect(
      hasCurrent,
      `${showerId} is missing its ${currentYear} entry — config/meteorShowers.ts must always carry the current year (SKY_EVENTS_PLAN.md §6)`,
    ).toBe(true);
  });

  it.each(MAJOR_SHOWER_IDS)("%s has a peak entry for next year (%s)", (showerId) => {
    const shower = METEOR_SHOWERS.find((s) => s.showerId === showerId);
    expect(shower, `shower "${showerId}" missing from METEOR_SHOWERS entirely`).toBeDefined();
    const hasNext = shower!.peaks.some((p) => p.year === nextYear);
    expect(
      hasNext,
      `${showerId} is missing its ${nextYear} entry — config/meteorShowers.ts must always carry next year too, so a January shower doesn't fall through a year-boundary gap late each December (SKY_EVENTS_PLAN.md §6)`,
    ).toBe(true);
  });
});
