import { describe, it, expect } from "vitest";
import { safetyTone } from "@/lib/safetyTone";

describe("safetyTone", () => {
  it("2026-07-17 regression: a Heat Advisory + LOW rip + green flag is CAUTION, not danger", () => {
    // The exact live state that painted the banner rose while its own contents
    // said "Rip current risk: LOW" and "Low hazard".
    expect(
      safetyTone({
        ripCurrentRisk: "low",
        flags: ["green"],
        alertEvents: ["Heat Advisory"],
      }),
    ).toBe("caution");
  });

  it("reserves danger for get-out-of-the-water facts", () => {
    expect(safetyTone({ lightningDanger: true })).toBe("danger");
    expect(safetyTone({ advisory: true })).toBe("danger");
    expect(safetyTone({ noSwim: true })).toBe("danger");
    expect(safetyTone({ ripCurrentRisk: "high" })).toBe("danger");
    expect(safetyTone({ flags: ["red"] })).toBe("danger");
    expect(safetyTone({ flags: ["double-red"] })).toBe("danger");
  });

  it("treats a warning-class NWS event as danger but an advisory/watch as caution", () => {
    expect(safetyTone({ alertEvents: ["Hurricane Warning"] })).toBe("danger");
    expect(safetyTone({ alertEvents: ["Tornado Warning"] })).toBe("danger");
    expect(safetyTone({ alertEvents: ["Rip Current Statement"] })).toBe("caution");
    expect(safetyTone({ alertEvents: ["Hurricane Watch"] })).toBe("caution");
    expect(safetyTone({ alertEvents: ["Heat Advisory"] })).toBe("caution");
  });

  it("escalates: danger beats caution when both are present", () => {
    expect(
      safetyTone({ lightningDanger: true, alertEvents: ["Heat Advisory"], ripCurrentRisk: "low" }),
    ).toBe("danger");
  });

  it("moderate rip and yellow/purple flags are caution", () => {
    expect(safetyTone({ ripCurrentRisk: "moderate" })).toBe("caution");
    expect(safetyTone({ flags: ["yellow"] })).toBe("caution");
    expect(safetyTone({ flags: ["purple"] })).toBe("caution");
  });

  it("is calm when nothing is wrong", () => {
    expect(safetyTone({})).toBe("calm");
    expect(safetyTone({ ripCurrentRisk: "low", flags: ["green"], alertEvents: [] })).toBe("calm");
  });
});
