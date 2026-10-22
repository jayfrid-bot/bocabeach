import { describe, expect, it } from "vitest";
import { CAMPAIGN, campaignForBeach, campaignForZip, campaignLive } from "./campaignBanner";

const BEFORE = Date.parse("2026-10-25T12:00:00Z");
const AFTER = Date.parse(CAMPAIGN.endIso);

describe("Woodward campaign strip", () => {
  it("says Re-elect and links to the campaign", () => {
    expect(CAMPAIGN.headline).toBe("Re-elect Marci Woodward");
    expect(CAMPAIGN.href).toBe("https://marciwoodward.com/");
  });
  it("ends exactly at poll close, 7 PM Eastern on Nov 3", () => {
    expect(campaignLive(AFTER - 1)).toBe(true);
    expect(campaignLive(AFTER)).toBe(false);
  });
  it("shows on District 4 beaches only", () => {
    expect(campaignForBeach("boca-raton", BEFORE)).toBe(true);
    expect(campaignForBeach("jupiter", BEFORE)).toBe(false);
    expect(campaignForBeach("boca-raton", AFTER)).toBe(false);
  });
  it("shows to District 4 ZIP codes only", () => {
    expect(campaignForZip("33432", BEFORE)).toBe(true);
    expect(campaignForZip("33432-1234", BEFORE)).toBe(true);
    expect(campaignForZip("33496", BEFORE)).toBe(false);
    expect(campaignForZip(undefined, BEFORE)).toBe(false);
    expect(campaignForZip("33432", AFTER)).toBe(false);
  });
});
