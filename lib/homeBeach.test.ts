import { describe, expect, it } from "vitest";
import { getHomeBeach, setHomeBeach, clearHomeBeach } from "@/lib/homeBeach";

// Same node-environment caveat as lib/deviceId.test.ts: no window/localStorage
// here, so only the SSR-safe no-op branch is exercised.
describe("homeBeach (SSR / no-window environment)", () => {
  it("getHomeBeach returns null instead of throwing when there is no window", () => {
    expect(typeof window).toBe("undefined");
    expect(getHomeBeach()).toBeNull();
  });

  it("setHomeBeach and clearHomeBeach are no-ops (don't throw) when there is no window", () => {
    expect(() => setHomeBeach("boca-raton")).not.toThrow();
    expect(() => clearHomeBeach()).not.toThrow();
    expect(getHomeBeach()).toBeNull();
  });
});
