import { describe, it, expect } from "vitest";
import { scoreBand, SCORE_BANDS } from "@/lib/scoreBands";
import { beachDayVerdict, scoreColor, scoreTextClass } from "@/lib/format";

describe("scoreBands (owner-set 2026-07-17 bands: 90 / 75 / 65 / 25)", () => {
  it("maps each band to its verdict + rating + colour", () => {
    // representative score in each band → [verdict, rating]
    const cases: Array<[number, string, string]> = [
      [95, "Absolutely!", "Excellent"],
      [90, "Absolutely!", "Excellent"],
      [82, "Yes — good beach day", "Good"],
      [75, "Yes — good beach day", "Good"],
      [70, "Decent", "Decent"],
      [65, "Decent", "Decent"],
      [50, "Likely not", "Marginal"],
      [25, "Likely not", "Marginal"],
      [12, "Definitely not", "Poor"],
      [0, "Definitely not", "Poor"],
    ];
    for (const [score, verdict, rating] of cases) {
      const b = scoreBand(score);
      expect(b.verdict, `verdict @ ${score}`).toBe(verdict);
      expect(b.rating, `rating @ ${score}`).toBe(rating);
      expect(beachDayVerdict(score)).toBe(verdict);
    }
  });

  it("the boundaries are exactly 90 / 75 / 65 / 25 (inclusive lower)", () => {
    expect(beachDayVerdict(89)).toBe("Yes — good beach day"); // just below 90
    expect(beachDayVerdict(74)).toBe("Decent"); // just below 75
    expect(beachDayVerdict(64)).toBe("Likely not"); // just below 65
    expect(beachDayVerdict(24)).toBe("Definitely not"); // just below 25
  });

  it("colour + text class come from the same band (never disagree)", () => {
    for (const score of [95, 80, 70, 40, 10]) {
      const b = scoreBand(score);
      expect(scoreColor(score)).toBe(b.color);
      expect(scoreTextClass(score)).toBe(b.text);
    }
    // 5 distinct colours, one per band.
    expect(new Set(SCORE_BANDS.map((b) => b.color)).size).toBe(5);
  });

  it("clamps out-of-range scores to the end bands", () => {
    expect(scoreBand(150).rating).toBe("Excellent");
    expect(scoreBand(-5).rating).toBe("Poor");
  });
});
