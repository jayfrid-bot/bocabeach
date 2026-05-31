import { describe, it, expect } from "vitest";
import { CAM_SNAPSHOTS, snapshotUrlForId } from "@/lib/camSnapshots";

describe("cam snapshot allowlist", () => {
  it("derives the allowlist from configured cams (boca-surf included)", () => {
    expect(CAM_SNAPSHOTS["boca-surf"]).toBe(
      "http://bocasurfcam.com/most_recent_image.php",
    );
  });

  it("resolves a known cam id to its upstream URL", () => {
    expect(snapshotUrlForId("boca-surf")).toMatch(/^https?:\/\//);
  });

  it("returns undefined for unknown ids (SSRF guard)", () => {
    expect(snapshotUrlForId("not-a-cam")).toBeUndefined();
    expect(snapshotUrlForId("")).toBeUndefined();
    // must not resolve via prototype keys
    expect(snapshotUrlForId("toString")).toBeUndefined();
    expect(snapshotUrlForId("constructor")).toBeUndefined();
  });

  it("only allowlists http(s) image endpoints", () => {
    for (const url of Object.values(CAM_SNAPSHOTS)) {
      expect(url).toMatch(/^https?:\/\//);
    }
  });
});
