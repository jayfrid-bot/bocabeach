import { describe, expect, it } from "vitest";
import { analyticsEnabled, shouldLoadAnalytics } from "./posthog";

describe("analytics switch", () => {
  it("stays off without a real project key", () => {
    expect(analyticsEnabled("")).toBe(false);
    expect(analyticsEnabled("phx_secretpersonalkey000000000")).toBe(false);
    expect(analyticsEnabled("phc_short")).toBe(false);
  });

  it("turns on with a project key", () => {
    expect(analyticsEnabled("phc_abcdefghijklmnopqrstuvwxyz0123456789")).toBe(true);
  });

  it("never loads in automated browsers", () => {
    const key = "phc_abcdefghijklmnopqrstuvwxyz0123456789";
    expect(shouldLoadAnalytics(key, true)).toBe(false);
    expect(shouldLoadAnalytics(key, false)).toBe(true);
  });
});
