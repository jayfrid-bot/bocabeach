import { describe, it, expect } from "vitest";
import {
  CAM_SOURCES,
  camSourceForId,
  pickFeedFramePath,
  resolveFeedImageUrl,
} from "@/lib/camSnapshots";

describe("cam snapshot allowlist", () => {
  it("derives direct-URL sources from configured cams", () => {
    expect(CAM_SOURCES["boca-surf"]).toEqual({
      kind: "direct",
      url: "http://bocasurfcam.com/most_recent_image.php",
    });
    expect(CAM_SOURCES["lake-boca"]).toEqual({
      kind: "direct",
      url: "http://lakebocacam.com/most_recent_image.php",
    });
  });

  it("derives latest.json feed sources (inlet + south beach)", () => {
    expect(CAM_SOURCES["boca-inlet"]).toEqual({
      kind: "feed",
      base: "http://video-monitoring.com/beachcams/bocainlet",
      view: "s4",
      res: "mr",
    });
    expect(CAM_SOURCES["boca-south"]).toEqual({
      kind: "feed",
      base: "http://video-monitoring.com/beachcams/boca",
      view: "s4",
      res: "mr",
    });
    expect(CAM_SOURCES["boca-inlet-surf"]).toEqual({
      kind: "feed",
      base: "http://video-monitoring.com/beachcams/bocainlet",
      view: "s16",
      res: "mr",
    });
  });

  it("returns undefined for unknown ids (SSRF guard)", () => {
    expect(camSourceForId("not-a-cam")).toBeUndefined();
    expect(camSourceForId("")).toBeUndefined();
    // must not resolve via prototype keys
    expect(camSourceForId("toString")).toBeUndefined();
    expect(camSourceForId("constructor")).toBeUndefined();
  });

  it("only allowlists http(s) sources", () => {
    for (const src of Object.values(CAM_SOURCES)) {
      const host = src.kind === "direct" ? src.url : src.base;
      expect(host).toMatch(/^https?:\/\//);
    }
  });
});

describe("latest.json feed resolution", () => {
  // Shape mirrors video-monitoring.com/beachcams/bocainlet/latest.json.
  const FEED = {
    s4: { hr: "pics/s4/may3026o/u012059o.jpg", mr: "pics/s4/may3026o/u012059_.jpg" },
    s8: { hr: "pics/s8/x/a.jpg", mr: "pics/s8/x/a_.jpg" },
  };

  it("picks the requested view + resolution", () => {
    expect(pickFeedFramePath(FEED, "s4", "mr")).toBe("pics/s4/may3026o/u012059_.jpg");
    expect(pickFeedFramePath(FEED, "s4", "hr")).toBe("pics/s4/may3026o/u012059o.jpg");
  });

  it("falls back / returns undefined when a view or path is missing", () => {
    expect(pickFeedFramePath(FEED, "s99", "mr")).toBeUndefined();
    expect(pickFeedFramePath({}, "s4", "mr")).toBeUndefined();
    expect(pickFeedFramePath(null, "s4", "mr")).toBeUndefined();
  });

  it("resolves a relative frame path against the base dir", () => {
    expect(
      resolveFeedImageUrl(
        "http://video-monitoring.com/beachcams/bocainlet",
        "pics/s4/may3026o/u012059_.jpg",
      ),
    ).toBe("http://video-monitoring.com/beachcams/bocainlet/pics/s4/may3026o/u012059_.jpg");
  });

  it("rejects a path that escapes the allowlisted base dir (SSRF guard)", () => {
    const base = "http://video-monitoring.com/beachcams/bocainlet";
    expect(() => resolveFeedImageUrl(base, "../../../../etc/passwd")).toThrow();
    expect(() => resolveFeedImageUrl(base, "http://evil.example.com/x.jpg")).toThrow();
    expect(() => resolveFeedImageUrl(base, "//evil.example.com/x.jpg")).toThrow();
  });
});
