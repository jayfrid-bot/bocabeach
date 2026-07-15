import { describe, expect, it } from "vitest";
import { BUSYNESS_SLOTS, busynessFilledSlots } from "@/lib/busynessFill";

describe("busynessFilledSlots", () => {
  it("uses the measured crowdPct when present", () => {
    expect(busynessFilledSlots(40, "moderate")).toBe(4);
    expect(busynessFilledSlots(0, "empty")).toBe(0);
    expect(busynessFilledSlots(100, "packed")).toBe(BUSYNESS_SLOTS);
  });

  it("rounds to the nearest slot", () => {
    expect(busynessFilledSlots(44, "moderate")).toBe(4);
    expect(busynessFilledSlots(46, "moderate")).toBe(5);
  });

  it("falls back to the level midpoint when crowdPct is absent", () => {
    expect(busynessFilledSlots(undefined, "empty")).toBe(1); // 5% -> rounds to 0.5 -> 1
    expect(busynessFilledSlots(undefined, "packed")).toBe(9);
  });

  it("clamps out-of-range crowdPct instead of overflowing the strip", () => {
    expect(busynessFilledSlots(150, "packed")).toBe(BUSYNESS_SLOTS);
    expect(busynessFilledSlots(-10, "empty")).toBe(0);
  });
});
