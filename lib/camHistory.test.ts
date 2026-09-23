import { describe, it, expect } from "vitest";
import { capCamHistory, MAX_CAM_HISTORY_ENTRIES } from "@/lib/camHistory";

describe("capCamHistory", () => {
  it("returns everything, unchanged, when within the bound", () => {
    const history = [1, 2, 3];
    expect(capCamHistory(history, 10)).toEqual([1, 2, 3]);
  });

  it("keeps only the newest N entries (the tail) when over the bound", () => {
    const history = Array.from({ length: 10 }, (_, i) => i);
    expect(capCamHistory(history, 4)).toEqual([6, 7, 8, 9]);
  });

  it("defaults to MAX_CAM_HISTORY_ENTRIES", () => {
    const history = Array.from({ length: MAX_CAM_HISTORY_ENTRIES + 50 }, (_, i) => i);
    const capped = capCamHistory(history);
    expect(capped.length).toBe(MAX_CAM_HISTORY_ENTRIES);
    expect(capped[capped.length - 1]).toBe(MAX_CAM_HISTORY_ENTRIES + 49);
  });

  it("handles undefined/empty history", () => {
    expect(capCamHistory(undefined)).toEqual([]);
    expect(capCamHistory([])).toEqual([]);
  });

  it("returns a fresh array, not the same reference (never mutates the input)", () => {
    const history = [1, 2, 3];
    const capped = capCamHistory(history, 10);
    expect(capped).not.toBe(history);
  });
});
