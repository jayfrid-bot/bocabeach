import { describe, it, expect } from "vitest";
import { coastalGate } from "@/lib/resolve/coastalGate";
import { BOCA_BEACH } from "@/lib/resolve/__fixtures__/registries";

const US_POINT = { ...BOCA_BEACH, countryCode: "US" };

describe("coastalGate", () => {
  it("passes a US point with a beach well within range", () => {
    expect(coastalGate(US_POINT, 0.26)).toEqual({ ok: true });
  });

  it("rejects non-US points before any distance check", () => {
    // null distance would also fail, but NON_US must win.
    expect(coastalGate({ ...BOCA_BEACH, countryCode: "CA" }, null)).toEqual({
      ok: false,
      reason: "NON_US",
    });
    expect(coastalGate({ ...BOCA_BEACH, countryCode: "MX" }, 1)).toEqual({
      ok: false,
      reason: "NON_US",
    });
  });

  it("rejects when there is no beach in range (null)", () => {
    expect(coastalGate(US_POINT, null)).toEqual({
      ok: false,
      reason: "COASTAL_GATE_FAIL",
    });
  });

  it("rejects when the nearest beach is beyond the max distance", () => {
    expect(coastalGate(US_POINT, 30.01)).toEqual({
      ok: false,
      reason: "COASTAL_GATE_FAIL",
    });
  });

  it("treats the default 30-mile boundary as inclusive", () => {
    // exactly 30mi passes; just over fails.
    expect(coastalGate(US_POINT, 30).ok).toBe(true);
    expect(coastalGate(US_POINT, 30 + 1e-9).ok).toBe(false);
  });

  it("honors a custom maxMiles", () => {
    expect(coastalGate(US_POINT, 25, 20).ok).toBe(false);
    expect(coastalGate(US_POINT, 25, 50).ok).toBe(true);
    // boundary stays inclusive with a custom max
    expect(coastalGate(US_POINT, 20, 20).ok).toBe(true);
  });

  it("models the inland-lake false-positive failing the gate", () => {
    // A MN lake beach is hundreds of miles from any coast -> COASTAL_GATE_FAIL.
    const inland = { lat: 44.9483, lon: -93.3105, countryCode: "US" };
    expect(coastalGate(inland, 412).reason).toBe("COASTAL_GATE_FAIL");
  });
});
