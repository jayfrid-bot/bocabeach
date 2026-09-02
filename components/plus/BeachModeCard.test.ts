import { describe, it, expect } from "vitest";
import { AUTO_ARM_MS, shouldAutoArm } from "@/components/plus/BeachModeCard";

const NOW = Date.parse("2026-09-02T16:00:00Z");
const MIN = 60_000;

describe("shouldAutoArm", () => {
  it("arms on arrival, when nothing is armed yet", () => {
    expect(shouldAutoArm(NOW, 0, 0)).toBe(true);
  });

  it("holds off for a minute after it just armed", () => {
    expect(shouldAutoArm(NOW, NOW - 30_000, 0)).toBe(false);
  });

  it("does not re-arm a window that still has hours on it", () => {
    // The effect re-runs on every render, and the app re-renders once a minute
    // to keep the clock moving — so a bare throttle wrote a new presence row
    // every 60 seconds for as long as someone stood on the sand.
    const justArmed = NOW + AUTO_ARM_MS;
    expect(shouldAutoArm(NOW + 61 * MIN, NOW, justArmed)).toBe(false);
    expect(shouldAutoArm(NOW + 2 * 60 * MIN, NOW, justArmed)).toBe(false);
  });

  it("tops the window up once it is down to its last hour", () => {
    expect(shouldAutoArm(NOW, NOW - 2 * MIN, NOW + 45 * MIN)).toBe(true);
  });

  it("re-arms a window that has already run out", () => {
    expect(shouldAutoArm(NOW, NOW - 2 * MIN, NOW - MIN)).toBe(true);
  });
});
