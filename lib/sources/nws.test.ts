import { describe, it, expect } from "vitest";
import { parseAlerts, parseRipRisk } from "@/lib/sources/nws";

// Mirrors the structure of an NWS Surf Zone Forecast (SRF) product.
const SRF = `
FLZ168-...
Coastal Broward-
...HIGH RIP CURRENT RISK...
Rip Current Risk*...........High.
$$
Palm Beach-
Including the beaches of Palm Beach
...MODERATE RIP CURRENT RISK...
Rip Current Risk*...........Moderate.
Rip Current Risk*...........High.
$$
Coastal Miami Dade-
Rip Current Risk*...........Low.
$$`;

describe("parseRipRisk", () => {
  it("pulls today's rip risk for the requested zone", () => {
    expect(parseRipRisk(SRF, "Palm Beach")).toBe("moderate"); // first (today) in the zone
    expect(parseRipRisk(SRF, "Coastal Miami Dade")).toBe("low");
  });
  it("returns unknown for a missing zone or text", () => {
    expect(parseRipRisk(SRF, "Monroe")).toBe("unknown");
    expect(parseRipRisk("", "Palm Beach")).toBe("unknown");
  });
});

describe("parseAlerts", () => {
  it("maps active alerts to event/severity/ends", () => {
    const a = parseAlerts({
      features: [
        {
          properties: {
            event: "Rip Current Statement",
            severity: "Moderate",
            headline: "Rip Current Statement until Friday",
            ends: "2026-06-05T20:00:00-04:00",
          },
        },
        { properties: { event: "Heat Advisory", severity: "Minor" } },
        { properties: {} }, // no event -> dropped
      ],
    });
    expect(a).toHaveLength(2);
    expect(a[0]).toMatchObject({ event: "Rip Current Statement", severity: "Moderate" });
    expect(a[1].event).toBe("Heat Advisory");
  });
});
