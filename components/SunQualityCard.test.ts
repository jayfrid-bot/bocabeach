import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { cardTitle, SunForecastPendingHeadline, SunQualityCard, SunScoreHeadline, sunScoreAriaLabel, SUN_SCORE_HINT } from "./SunQualityCard";
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

describe("forecast window on the card (no score before an hour out)", () => {
  // Sunset 6:30 PM EDT (22:30Z). The forecast opens at 5:30 PM EDT (21:30Z).
  const SUNSET = "2026-10-15T22:30:00.000Z";
  const SUNRISE = "2026-10-15T11:09:00.000Z";
  const TOMORROW = "2026-10-16T11:10:00.000Z";
  const hourly = [
    { time: "2026-10-15T22:00:00.000Z", cloud: { lowPct: 10, midPct: 35, highPct: 10, totalPct: 40 }, humidityPct: 60 },
    { time: "2026-10-16T11:00:00.000Z", cloud: { lowPct: 10, midPct: 35, highPct: 10, totalPct: 40 }, humidityPct: 60 },
  ];
  const render = (nowIso: string) =>
    renderToStaticMarkup(
      createElement(SunQualityCard, {
        now: new Date(nowIso),
        tz: "America/New_York",
        today: {
          sunrise: SUNRISE,
          sunset: SUNSET,
          // Real elevation window, so the card keeps tonight's sunset up until it closes.
          goldenAm: { goldenStartIso: "2026-10-15T10:49:00.000Z", goldenEndIso: "2026-10-15T11:29:00.000Z" },
          goldenEve: { goldenStartIso: "2026-10-15T22:10:00.000Z", goldenEndIso: "2026-10-15T22:50:00.000Z" },
        },
        tomorrow: { sunriseIso: TOMORROW },
        hourly,
      }),
    );

  it("pending headline: 'Sunset forecast ready at 5:30 PM', no number, no band word, no /100", () => {
    const out = renderToStaticMarkup(
      createElement(SunForecastPendingHeadline, { kind: "sunset", availableAtIso: "2026-10-15T21:30:00.000Z", tz: "America/New_York" }),
    );
    expect(out).toContain("Sunset forecast ready at 5:30 PM");
    expect(out).not.toMatch(/out of 100|\/100|Poor|Fair|Good|Great|Amazing/);
  });

  it("midday: the card says when the sunset forecast opens and shows no score anywhere, front or back", () => {
    const html = render("2026-10-15T17:00:00.000Z"); // 1 PM EDT
    expect(html).toContain("Sunset forecast ready at 5:30 PM");
    expect(html).not.toMatch(/out of 100|\/100|No forecast yet/);
    expect(html).not.toMatch(/→ \d+/); // the back's arrow line with the score
    expect(html).not.toMatch(/Peak color ~/);
  });

  it("before dawn: the sunrise line", () => {
    const html = render("2026-10-15T07:00:00.000Z"); // 3 AM EDT
    expect(html).toContain("Sunrise forecast ready at 6:09 AM");
    expect(html).not.toMatch(/out of 100|\/100/);
  });

  it("an hour before the sunset it shows the existing score again", () => {
    const html = render("2026-10-15T21:45:00.000Z"); // 5:45 PM EDT, 45 min out
    expect(html).not.toContain("forecast at");
    expect(html).toMatch(/Sunset color \d+ out of 100/);
  });

  it("right at the window's first minute the score shows; one minute before it does not", () => {
    expect(render("2026-10-15T21:29:00.000Z")).toContain("Sunset forecast ready at 5:30 PM");
    expect(render("2026-10-15T21:30:00.000Z")).toMatch(/out of 100/);
  });

  it("after the sunset passes (golden hour still on screen) the score stays", () => {
    const html = render("2026-10-15T22:40:00.000Z"); // 6:40 PM EDT, 10 min after
    expect(html).toMatch(/Sunset color \d+ out of 100/);
  });
});
