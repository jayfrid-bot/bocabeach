import { describe, it, expect } from "vitest";
import { GOES_CLOUD_STALE_MINUTES } from "@/lib/sources/goesCloud";

// The ACM 4-level cloud mask -> 0-1 fraction mapping actually lives in
// scripts/goes_cloud.py (ACM_WEIGHTS) — the Python job does the pixel
// averaging server-side, so there's no TS runtime code that recomputes it.
// This pins the documented spec here (mirrored exactly from the module
// docstring in scripts/goes_cloud.py) so a future edit to one side without
// the other shows up as a failing/changed expectation instead of silent drift.
const ACM_WEIGHTS: Record<number, number> = {
  0: 0, // clear
  1: 0.33, // probably_clear
  2: 0.67, // probably_cloudy
  3: 1.0, // cloudy
};

describe("ACM level -> cloud fraction mapping (spec mirrored from scripts/goes_cloud.py)", () => {
  it("maps clear to 0", () => {
    expect(ACM_WEIGHTS[0]).toBe(0);
  });
  it("maps probably_clear to 0.33", () => {
    expect(ACM_WEIGHTS[1]).toBeCloseTo(0.33, 5);
  });
  it("maps probably_cloudy to 0.67", () => {
    expect(ACM_WEIGHTS[2]).toBeCloseTo(0.67, 5);
  });
  it("maps cloudy to 1.0 (fully overcast)", () => {
    expect(ACM_WEIGHTS[3]).toBe(1.0);
  });
  it("is monotonically increasing (more cloud flag -> more cloud fraction)", () => {
    const vals = [ACM_WEIGHTS[0], ACM_WEIGHTS[1], ACM_WEIGHTS[2], ACM_WEIGHTS[3]];
    for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeGreaterThan(vals[i - 1]);
  });
});

describe("GOES_CLOUD_STALE_MINUTES", () => {
  it("is generous enough to absorb the observed real-world feed gap (83 min on 2026-07-15)", () => {
    // Not >= 83: the threshold should still eventually refuse a genuinely old
    // granule. But it must be well above the ~1-2 min GLM lightning can hold to.
    expect(GOES_CLOUD_STALE_MINUTES).toBeGreaterThan(10);
    expect(GOES_CLOUD_STALE_MINUTES).toBeLessThan(83);
  });
});
