import { describe, expect, it } from "vitest";
import { getDeviceId } from "@/lib/deviceId";

// vitest.config.ts runs this suite under environment: "node" (no jsdom), so
// there is no `window`/`localStorage` global here — only the SSR-safe branch
// is reachable. The localStorage-backed mint-once/persist behavior needs a
// DOM (jsdom) or a real browser/WebView to exercise; it isn't covered by this
// suite. See lib/location/device.test.ts for the same node-env caveat.
describe("getDeviceId (SSR / no-window environment)", () => {
  it("returns \"\" instead of throwing when there is no window", () => {
    expect(typeof window).toBe("undefined");
    expect(getDeviceId()).toBe("");
  });

  it("is stable (still \"\") across repeated calls with no window", () => {
    expect(getDeviceId()).toBe(getDeviceId());
  });
});
