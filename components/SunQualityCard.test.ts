import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { cardTitle, SunScoreHeadline, sunScoreAriaLabel, SUN_SCORE_HINT } from "./SunQualityCard";
import { SUN_QUALITY_BANDS } from "@/lib/sunQuality";

describe("sun color card wording", () => {
  it("says which event is coming, in plain words", () => {
    expect(cardTitle("sunrise", false)).toBe("Upcoming sunrise color");
    expect(cardTitle("sunset", false)).toBe("Upcoming sunset color");
  });

  it("drops 'upcoming' inside the golden window (the sun may already be down)", () => {
    expect(cardTitle("sunrise", true)).toBe("Sunrise color now");
    expect(cardTitle("sunset", true)).toBe("Sunset color now");
  });

  it("ranks with simple words, worst to best", () => {
    expect(SUN_QUALITY_BANDS.map((b) => b.label)).toEqual(["Poor", "Fair", "Good", "Great", "Amazing"]);
  });
});

describe("sun color score on the card front", () => {
  const html = (score: number | null, band: Parameters<typeof SunScoreHeadline>[0]["result"]["band"]) =>
    renderToStaticMarkup(createElement(SunScoreHeadline, { kind: "sunset", result: { score, band } }));

  it("shows the number and the word, with an accessible label", () => {
    const out = html(72, "vivid");
    expect(out).toContain(">72<");
    expect(out).toContain("Great");
    expect(out).toContain('aria-label="Sunset color 72 out of 100, Great"');
    expect(out).toContain("#fb923c"); // the Great band dot
  });

  it("reads the label for each kind and band in plain words", () => {
    expect(sunScoreAriaLabel("sunrise", { score: 64, band: "good" })).toBe("Sunrise color 64 out of 100, Good");
    expect(sunScoreAriaLabel("sunset", { score: 5, band: "dud" })).toBe("Sunset color 5 out of 100, Poor");
    expect(sunScoreAriaLabel("sunset", { score: 93, band: "epic" })).toBe("Sunset color 93 out of 100, Amazing");
  });

  it("says 'No forecast yet' with no number when the score is null", () => {
    const out = html(null, null);
    expect(out).toContain("No forecast yet");
    expect(out).not.toMatch(/out of 100/);
    expect(out).not.toMatch(/>\d+</);
    expect(sunScoreAriaLabel("sunset", { score: null, band: null })).toBe("Sunset color: no forecast yet");
  });

  it("explains the 0-100 scale in one plain sentence, never 'AI'", () => {
    expect(SUN_SCORE_HINT).toMatch(/^0–100\. About 1 in 5 .* 70 or more \(Great\)/);
    expect(SUN_SCORE_HINT).not.toMatch(/\bAI\b/);
  });
});
