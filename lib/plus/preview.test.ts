import { describe, expect, it } from "vitest";
import { buildPreview, formatPreviewDate, localDateKey, previewReminder, revealLine } from "@/lib/plus/preview";

const NOON_ET = Date.parse("2026-09-02T16:00:00Z"); // 12:00 in America/New_York

describe("localDateKey", () => {
  it("uses the BEACH's calendar day, not the viewer's", () => {
    // 01:00 UTC on Sep 3 is still Sep 2 in Florida — the reveal must be dated
    // by the beach, or a night-time tap reads as tomorrow.
    const lateNight = Date.parse("2026-09-03T01:00:00Z");
    expect(localDateKey(lateNight, "America/New_York")).toBe("2026-09-02");
    expect(localDateKey(lateNight, "UTC")).toBe("2026-09-03");
  });

  it("falls back to a UTC date rather than throwing on a bad timezone", () => {
    expect(localDateKey(NOON_ET, "Not/AZone")).toBe("2026-09-02");
  });
});

describe("buildPreview", () => {
  it("rounds the two numbers and stamps the beach-local day", () => {
    expect(buildPreview(70.6, 58.2, "snorkeling", NOON_ET, "America/New_York")).toEqual({
      date: "2026-09-02",
      personal: 71,
      everyone: 58,
      label: "snorkeling",
    });
  });
});

describe("formatPreviewDate", () => {
  it("reads as a date a person would say", () => {
    expect(formatPreviewDate("2026-09-01")).toBe("Sep 1");
    expect(formatPreviewDate("2026-12-25")).toBe("Dec 25");
  });

  it("hands back anything it cannot parse untouched", () => {
    expect(formatPreviewDate("whenever")).toBe("whenever");
  });
});

describe("previewReminder", () => {
  it("is the line the locked pill shows", () => {
    expect(
      previewReminder({ date: "2026-09-01", personal: 71, everyone: 58, label: "snorkeling" }),
    ).toBe("On Sep 1 your score ran 13 points above everyone's.");
  });

  it("says below when the profile scored the day lower", () => {
    expect(
      previewReminder({ date: "2026-09-01", personal: 40, everyone: 58, label: "surfing" }),
    ).toBe("On Sep 1 your score ran 18 points below everyone's.");
  });

  it("does not say '1 points'", () => {
    expect(
      previewReminder({ date: "2026-09-01", personal: 59, everyone: 58, label: "swimming" }),
    ).toBe("On Sep 1 your score ran 1 point above everyone's.");
  });

  it("has an honest line for a day the two agreed", () => {
    expect(
      previewReminder({ date: "2026-09-01", personal: 58, everyone: 58, label: "swimming" }),
    ).toBe("On Sep 1 your score matched everyone's.");
  });

  it("says nothing at all with no saved reveal", () => {
    expect(previewReminder(null)).toBeNull();
  });
});

describe("revealLine", () => {
  it("is the sentence the reveal screen promises", () => {
    expect(revealLine(71, 58, "snorkeling")).toBe(
      "Your score today 71 · Everyone's 58 · tuned for snorkeling",
    );
  });
});
