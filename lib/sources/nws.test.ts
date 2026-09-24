import { describe, it, expect } from "vitest";
import { parseAlerts, parseRipRisk, parseSrfPeriods } from "@/lib/sources/nws";

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

  it("drops NWS test/exercise products (status !== Actual) — e.g. the monthly tsunami test", () => {
    const a = parseAlerts({
      features: [
        { properties: { event: "Tsunami Warning", severity: "Extreme", status: "Test", headline: "TEST Tsunami Warning" } },
        { properties: { event: "Coastal Flood Advisory", severity: "Moderate", status: "Exercise" } },
        { properties: { event: "Rip Current Statement", severity: "Moderate", status: "Actual" } },
        { properties: { event: "Heat Advisory", severity: "Minor" } }, // no status → treated as Actual
      ],
    });
    expect(a.map((x) => x.event)).toEqual(["Rip Current Statement", "Heat Advisory"]);
  });

  it("keeps onset/effective/ends/expires/id/status/messageType/description", () => {
    const a = parseAlerts({
      features: [
        {
          properties: {
            id: "urn:oid:2.49.0.1.840.0.abc123",
            event: "Rip Current Statement",
            severity: "Moderate",
            status: "Actual",
            messageType: "Alert",
            headline: "Rip Current Statement issued",
            description: "Life-threatening rip currents expected.",
            sent: "2026-09-24T14:00:00Z",
            effective: "2026-09-24T14:00:00Z",
            onset: "2026-09-25T06:00:00Z",
            ends: "2026-09-26T12:00:00Z",
            expires: "2026-09-26T12:00:00Z",
          },
        },
      ],
    });
    expect(a[0]).toMatchObject({
      id: "urn:oid:2.49.0.1.840.0.abc123",
      status: "Actual",
      messageType: "Alert",
      onset: "2026-09-25T06:00:00Z",
      effective: "2026-09-24T14:00:00Z",
      ends: "2026-09-26T12:00:00Z",
      expires: "2026-09-26T12:00:00Z",
      description: "Life-threatening rip currents expected.",
    });
  });
});

describe("parseSrfPeriods", () => {
  const MULTI_PERIOD_SRF = `
FLZ168-...
Coastal Broward-
...HIGH RIP CURRENT RISK...
.TODAY...
Rip Current Risk*...........High.
.TONIGHT...
Rip Current Risk*...........Moderate.
.FRIDAY...
Rip Current Risk*...........High.
$$`;

  it("parses every period with its own label and word", () => {
    const periods = parseSrfPeriods(MULTI_PERIOD_SRF, "Coastal Broward");
    expect(periods).toEqual([
      { label: "TODAY", level: "high" },
      { label: "TONIGHT", level: "moderate" },
      { label: "FRIDAY", level: "high" },
    ]);
  });

  it("attaches TODAY/TONIGHT/named-day windows when issuedAt+tz are given", () => {
    // Issued Thu 2026-09-24 14:00 UTC (10:00 AM EDT).
    const periods = parseSrfPeriods(MULTI_PERIOD_SRF, "Coastal Broward", {
      issuedAt: "2026-09-24T14:00:00Z",
      tz: "America/New_York",
    });
    const today = periods.find((p) => p.label === "TODAY")!;
    expect(today.start).toBe("2026-09-24T14:00:00Z");
    expect(today.end).toBe("2026-09-24T22:00:00.000Z"); // 6 PM EDT = 22:00 UTC

    const tonight = periods.find((p) => p.label === "TONIGHT")!;
    expect(tonight.start).toBe("2026-09-24T22:00:00.000Z");
    expect(tonight.end).toBe("2026-09-25T10:00:00.000Z"); // 6 AM EDT next day

    const friday = periods.find((p) => p.label === "FRIDAY")!;
    expect(friday.start).toBe("2026-09-25T10:00:00.000Z"); // 6 AM EDT Fri
    expect(friday.end).toBe("2026-09-25T22:00:00.000Z"); // 6 PM EDT Fri
  });

  it("falls back to a single TODAY period with no headers", () => {
    const periods = parseSrfPeriods(
      "FLZ168-...\nCoastal Broward-\nRip Current Risk*...........Low.\n$$",
      "Coastal Broward",
    );
    expect(periods).toEqual([{ label: "TODAY", level: "low" }]);
  });

  it("returns empty for a missing zone", () => {
    expect(parseSrfPeriods(MULTI_PERIOD_SRF, "Monroe")).toEqual([]);
  });
});
