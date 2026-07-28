import { describe, expect, it } from "vitest";
import { observedChip, OBSERVED_STALE_MINUTES } from "@/components/TidePanel";
import type { TideObserved } from "@/lib/types";

const NOW = Date.parse("2026-07-28T19:24:00.000Z");
const base: TideObserved = {
  heightFt: 0.83,
  tIso: "2026-07-28T19:18:00.000Z", // 6 min old — one gauge tick
  stationId: "8722670",
  stationName: "Lake Worth Pier, Atlantic Ocean",
  deltaFt: 0.53,
};

describe("observedChip", () => {
  it("names the gauge by its published place and states the gap in plain English", () => {
    const chip = observedChip(base, NOW)!;
    expect(chip.text).toBe("Observed: 0.8 ft — 0.5 ft above predicted (Lake Worth Pier gauge)");
  });

  it("goes AMBER at +0.5 ft or more (wind setup / surge running the water high)", () => {
    expect(observedChip({ ...base, deltaFt: 0.5 }, NOW)!.tone).toContain("amber");
    expect(observedChip({ ...base, deltaFt: 1.2 }, NOW)!.tone).toContain("amber");
  });

  it("goes CYAN at −0.5 ft or less, and reads 'below predicted'", () => {
    const chip = observedChip({ ...base, heightFt: -0.2, deltaFt: -0.6 }, NOW)!;
    expect(chip.tone).toContain("cyan");
    expect(chip.text).toContain("0.6 ft below predicted");
  });

  it("stays SLATE inside ±0.5 ft — a normal day earns no colour", () => {
    expect(observedChip({ ...base, deltaFt: 0.3 }, NOW)!.tone).toContain("slate");
    expect(observedChip({ ...base, deltaFt: -0.49 }, NOW)!.tone).toContain("slate");
  });

  it("says 'right on prediction' instead of '0.0 ft above predicted'", () => {
    expect(observedChip({ ...base, deltaFt: 0.02 }, NOW)!.text).toContain("right on prediction");
    expect(observedChip({ ...base, deltaFt: -0.03 }, NOW)!.text).toContain("right on prediction");
  });

  it("HIDES a reading older than the staleness window — a quiet gauge is not 'observed'", () => {
    const obsMs = Date.parse(base.tIso);
    const justInside = obsMs + (OBSERVED_STALE_MINUTES - 1) * 60_000;
    const justOutside = obsMs + (OBSERVED_STALE_MINUTES + 1) * 60_000;
    expect(observedChip(base, justInside)).not.toBeNull();
    expect(observedChip(base, justOutside)).toBeNull();
  });

  it("HIDES a future-dated reading too — that also means the feed isn't describing now", () => {
    const wellBeforeTheReading =
      Date.parse(base.tIso) - (OBSERVED_STALE_MINUTES + 1) * 60_000;
    expect(observedChip(base, wellBeforeTheReading)).toBeNull();
  });

  it("HIDES when there's no observation, or its timestamp is unparseable", () => {
    expect(observedChip(undefined, NOW)).toBeNull();
    expect(observedChip({ ...base, tIso: "nonsense" }, NOW)).toBeNull();
  });

  it("falls back to the bare station id rather than inventing a place name", () => {
    const chip = observedChip({ ...base, stationName: undefined }, NOW)!;
    expect(chip.text).toContain("(gauge 8722670)");
  });
});
