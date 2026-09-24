import { describe, expect, it } from "vitest";
import { ripCopy } from "@/lib/ripRisk/copy";
import type { RipNow } from "@/lib/ripRisk/types";
import type { RipModelHourInput } from "@/lib/ripRisk/timeline";

const TZ = "America/New_York";
// 2026-09-24T18:00:00Z = 2 PM Thu America/New_York.
const NOW = Date.parse("2026-09-24T18:00:00Z");

const hour = (isoOffsetH: number, prob: number): RipModelHourInput => ({
  t: new Date(NOW + isoOffsetH * 3_600_000).toISOString(),
  prob,
});

describe("ripCopy", () => {
  it("warning in effect: two short sentences, no percentages or source jargon", () => {
    const ripNow: RipNow = {
      source: "alert",
      level: "high",
      alert: {
        id: "x",
        event: "Rip Current Statement",
        status: "inEffect",
        onset: "2026-09-24T06:00:00Z",
        end: "2026-09-26T12:00:00Z", // Sat
      },
      upcomingAlert: null,
      period: null,
      model: null,
      watch: false,
    };
    const c = ripCopy(ripNow, null, NOW, TZ);
    expect(c.headline).toBe("High");
    expect(c.line1).toBe("Rip current warning in effect until 8 AM Sat.");
    expect(c.line2).toBe("Swim near a lifeguard, or stay out.");
    expect(c.bannerText).toBe("Rip current warning in effect until 8 AM Sat");
    for (const s of [c.line1, c.line2, c.bannerText]) {
      expect(s).not.toMatch(/%|NOAA|NWS|disagree/i);
    }
  });

  it("2026-09-24 Boca fixture: forecast floor — model reads calmer than the resolved level", () => {
    // Resolved Moderate (SRF High stepped down one band) while the model's
    // OWN raw reading is 3% -> Low. This is the exact case that used to
    // print "Moderate  NOAA model 3% (model: Low)" on the front of the card.
    const ripNow: RipNow = {
      source: "model",
      level: "moderate",
      alert: null,
      upcomingAlert: {
        id: "y",
        event: "Rip Current Statement",
        status: "scheduled",
        onset: "2026-09-25T06:00:00Z", // 2 AM Fri local
        end: "2026-09-26T12:00:00Z",
      },
      period: { level: "high", periodLabel: "TODAY" },
      model: { prob: 3, level: "low", run: "2026-09-24T12:00:00Z" },
      watch: true,
    };
    const c = ripCopy(ripNow, null, NOW, TZ);
    expect(c.headline).toBe("Moderate");
    expect(c.line1).toBe("The water is calmer now, but rough surf is on the way.");
    expect(c.line2).toBe("Rip current warning starts 2 AM Fri.");
    expect(c.bannerText).toBe("Rip current risk: Moderate · Warning starts 2 AM Fri");
  });

  it("rises: hourly series climbing to a higher band later", () => {
    const ripNow: RipNow = {
      source: "model",
      level: "low",
      alert: null,
      upcomingAlert: null,
      period: null,
      model: { prob: 10, level: "low", run: "2026-09-24T12:00:00Z" },
      watch: false,
    };
    const timeline = [hour(0, 10), hour(6, 15), hour(22, 55)]; // rises to High at +22h
    const c = ripCopy(ripNow, timeline, NOW, TZ);
    expect(c.headline).toBe("Low");
    expect(c.line1).toBe("Rises to High by 12 PM Fri.");
  });

  it("eases: hourly series dropping to a lower band later, same day", () => {
    const ripNow: RipNow = {
      source: "model",
      level: "high",
      alert: null,
      upcomingAlert: null,
      period: null,
      model: { prob: 60, level: "high", run: "2026-09-24T12:00:00Z" },
      watch: false,
    };
    const timeline = [hour(0, 60), hour(4, 10)]; // eases to Low by 6 PM local (18:00Z+4h=22:00Z=6PM ET)
    const c = ripCopy(ripNow, timeline, NOW, TZ);
    expect(c.headline).toBe("High");
    expect(c.line1).toBe("Easing to Low by 6 PM.");
  });

  it("steady: hourly series stays in the same band", () => {
    const ripNow: RipNow = {
      source: "forecast",
      level: "low",
      alert: null,
      upcomingAlert: null,
      period: { level: "low", periodLabel: "TODAY" },
      model: null,
      watch: false,
    };
    const timeline = [hour(0, 5), hour(6, 8), hour(12, 12)];
    const c = ripCopy(ripNow, timeline, NOW, TZ);
    expect(c.headline).toBe("Low");
    expect(c.line1).toBe("Should stay Low through tonight.");
    expect(c.line2).toBeUndefined();
    expect(c.bannerText).toBe("Rip current risk: Low");
  });

  it("no model coverage at all: still a plain, non-contradicting steady line", () => {
    const ripNow: RipNow = {
      source: "forecast",
      level: "moderate",
      alert: null,
      upcomingAlert: null,
      period: { level: "moderate", periodLabel: "TODAY" },
      model: null,
      watch: false,
    };
    const c = ripCopy(ripNow, null, NOW, TZ);
    expect(c.headline).toBe("Moderate");
    expect(c.line1).toBe("Should stay Moderate through tonight.");
  });

  it("no ripNow at all: defaults to Low rather than throwing", () => {
    const c = ripCopy(undefined, undefined, NOW, TZ);
    expect(c.headline).toBe("Low");
    expect(c.bannerText).toBe("Rip current risk: Low");
  });

  it("never contradicts the level word: headline always matches the words used in line1/bannerText", () => {
    const ripNow: RipNow = {
      source: "model",
      level: "high",
      alert: null,
      upcomingAlert: null,
      period: { level: "high", periodLabel: "TODAY" },
      model: { prob: 70, level: "high", run: "2026-09-24T12:00:00Z" },
      watch: false,
    };
    const c = ripCopy(ripNow, [hour(0, 70), hour(3, 70)], NOW, TZ);
    expect(c.headline).toBe("High");
    expect(c.bannerText).toContain("High");
  });
});
