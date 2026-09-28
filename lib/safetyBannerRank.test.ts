import { describe, it, expect } from "vitest";
import { rankSafetyItems, isWarningTierAlert, type SafetyItem } from "@/lib/safetyBannerRank";

const item = (kind: SafetyItem["kind"], id: string): SafetyItem => ({ kind, id, icon: "x", text: id });

describe("isWarningTierAlert", () => {
  it("an event name ending in Warning is warning-tier", () => {
    expect(isWarningTierAlert({ event: "Tornado Warning" })).toBe(true);
    expect(isWarningTierAlert({ event: "High Surf Warning" })).toBe(true);
    expect(isWarningTierAlert({ event: "Special Marine Warning" })).toBe(true);
  });

  it("Severe/Extreme CAP severity is warning-tier even without the word Warning", () => {
    expect(isWarningTierAlert({ event: "Coastal Flood Statement", severity: "Severe" })).toBe(true);
    expect(isWarningTierAlert({ event: "Coastal Flood Statement", severity: "Extreme" })).toBe(true);
  });

  it("an Advisory/Statement/Watch at ordinary severity is NOT warning-tier", () => {
    expect(isWarningTierAlert({ event: "Coastal Flood Advisory", severity: "Moderate" })).toBe(false);
    expect(isWarningTierAlert({ event: "High Surf Advisory", severity: "Minor" })).toBe(false);
    expect(isWarningTierAlert({ event: "Beach Hazards Statement", severity: "Moderate" })).toBe(false);
    expect(isWarningTierAlert({ event: "Rip Current Watch", severity: "Unknown" })).toBe(false);
  });
});

describe("rankSafetyItems", () => {
  it("lightning beats a water-quality advisory", () => {
    const ranked = rankSafetyItems([item("closure", "water-advisory"), item("lightning", "lightning")]);
    expect(ranked[0].id).toBe("lightning");
  });

  it("a warning-tier alert (a Tornado Warning) beats a Beach Hazards Statement", () => {
    const ranked = rankSafetyItems([
      item("softAdvisory", "beach-hazards-statement"),
      item("warningAlert", "tornado-warning"),
    ]);
    expect(ranked[0].id).toBe("tornado-warning");
  });

  it("a red flag / rip-current warning beats a soft advisory", () => {
    const ranked = rankSafetyItems([
      item("softAdvisory", "high-surf-advisory"),
      item("redFlagOrRipWarning", "red-flag"),
    ]);
    expect(ranked[0].id).toBe("red-flag");
  });

  it("a closure beats a red flag / rip-current warning", () => {
    const ranked = rankSafetyItems([
      item("redFlagOrRipWarning", "rip-warning"),
      item("closure", "no-swim"),
    ]);
    expect(ranked[0].id).toBe("no-swim");
  });

  it("orders every tier worst-first in one pass", () => {
    const shuffled = [
      item("other", "upcoming"),
      item("softAdvisory", "soft"),
      item("redFlagOrRipWarning", "red-flag"),
      item("closure", "closure"),
      item("warningAlert", "warning"),
      item("lightning", "lightning"),
    ];
    const ranked = rankSafetyItems(shuffled);
    expect(ranked.map((i) => i.kind)).toEqual([
      "lightning",
      "warningAlert",
      "closure",
      "redFlagOrRipWarning",
      "softAdvisory",
      "other",
    ]);
  });

  it("is stable within a tier — keeps the caller's push order for ties", () => {
    const ranked = rankSafetyItems([item("softAdvisory", "first"), item("softAdvisory", "second")]);
    expect(ranked.map((i) => i.id)).toEqual(["first", "second"]);
  });

  it("does not mutate the input array", () => {
    const input = [item("other", "a"), item("lightning", "b")];
    const copy = [...input];
    rankSafetyItems(input);
    expect(input).toEqual(copy);
  });

  it("empty in, empty out", () => {
    expect(rankSafetyItems([])).toEqual([]);
  });
});
