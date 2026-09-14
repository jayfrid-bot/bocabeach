import { describe, it, expect } from "vitest";
import {
  camFeedUrl,
  legacyCamFeedUrl,
  allowsLegacyCamFeedFallback,
  camFeedUrlCandidates,
  LEGACY_FALLBACK_SLUG,
} from "@/lib/sources/camFeed";

describe("camFeedUrl", () => {
  it("builds a per-beach URL keyed off the slug", () => {
    expect(camFeedUrl("boca-raton")).toBe(
      "https://raw.githubusercontent.com/jayfrid-bot/bocabeach/sargassum-data/cam_seaweed.boca-raton.json",
    );
    expect(camFeedUrl("deerfield-beach")).toBe(
      "https://raw.githubusercontent.com/jayfrid-bot/bocabeach/sargassum-data/cam_seaweed.deerfield-beach.json",
    );
  });
});

describe("legacyCamFeedUrl", () => {
  it("points at the pre-split single-file feed", () => {
    expect(legacyCamFeedUrl()).toBe(
      "https://raw.githubusercontent.com/jayfrid-bot/bocabeach/sargassum-data/cam_seaweed.json",
    );
  });
});

describe("allowsLegacyCamFeedFallback", () => {
  it("is true only for boca-raton, the one pre-split beach", () => {
    expect(LEGACY_FALLBACK_SLUG).toBe("boca-raton");
    expect(allowsLegacyCamFeedFallback("boca-raton")).toBe(true);
    expect(allowsLegacyCamFeedFallback("deerfield-beach")).toBe(false);
    expect(allowsLegacyCamFeedFallback("")).toBe(false);
  });
});

describe("camFeedUrlCandidates", () => {
  it("tries only the per-beach file for a beach with no legacy history", () => {
    expect(camFeedUrlCandidates("deerfield-beach")).toEqual([
      camFeedUrl("deerfield-beach"),
    ]);
  });

  it("tries the per-beach file first, then the legacy file, for boca-raton", () => {
    expect(camFeedUrlCandidates("boca-raton")).toEqual([
      camFeedUrl("boca-raton"),
      legacyCamFeedUrl(),
    ]);
  });
});
