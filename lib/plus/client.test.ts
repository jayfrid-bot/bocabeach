// Unit tests for client.ts's pure dispatch-key helper. useHazardsAtPoint
// itself is a React hook wired to fetch/effects (untested directly, per this
// repo's convention — see lib/plus/beachMode.ts's header); hazardsInputKey is
// the pure piece Codex round 2 #3 depends on, so it is tested directly here.

import { describe, it, expect } from "vitest";
import { hazardsInputKey } from "@/lib/plus/client";
import type { Fix } from "@/lib/location/device";

function fix(over: Partial<Fix> = {}): Fix {
  return { lat: 26.3587, lon: -80.0686, accuracyM: 20, at: 1_000_000, ...over };
}

describe("hazardsInputKey", () => {
  it("differs with no fix vs. any fix", () => {
    expect(hazardsInputKey("boca-raton", null)).not.toBe(hazardsInputKey("boca-raton", fix()));
  });

  it("differs when the slug changes, fix held constant", () => {
    expect(hazardsInputKey("boca-raton", fix())).not.toBe(hazardsInputKey("delray-beach", fix()));
  });

  it("differs when the fix's timestamp changes", () => {
    expect(hazardsInputKey("boca-raton", fix())).not.toBe(hazardsInputKey("boca-raton", fix({ at: 1_000_001 })));
  });

  it("differs when lat/lon move by more than the rounding precision", () => {
    expect(hazardsInputKey("boca-raton", fix())).not.toBe(
      hazardsInputKey("boca-raton", fix({ lat: 26.4, lon: -80.1 })),
    );
  });

  it("is stable for the same slug + fix (rounded lat/lon)", () => {
    const a = hazardsInputKey("boca-raton", fix());
    const b = hazardsInputKey("boca-raton", fix({ lat: 26.3588, lon: -80.0685 })); // sub-0.01° jitter
    expect(a).toBe(b);
  });
});
