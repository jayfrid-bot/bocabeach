import { describe, it, expect } from "vitest";
import { pickSurfZoneName } from "@/lib/resolve/nwsZone";
import { parseRipRisk } from "@/lib/sources/nws";
import { SRF_MFL_FIXTURE } from "@/lib/resolve/__fixtures__/registries";

describe("pickSurfZoneName", () => {
  it("matches the coastal Palm Beach block by zone id at high confidence", () => {
    const r = pickSurfZoneName(SRF_MFL_FIXTURE, { forecastZone: "FLZ168" });
    expect(r.confidence).toBe("high");
    expect(r.name).toMatch(/Coastal Palm Beach/i);
  });

  it("produces a name that nws.ts parseRipRisk can match back to the same block", () => {
    const r = pickSurfZoneName(SRF_MFL_FIXTURE, { forecastZone: "FLZ168" });
    // The whole point: the resolved name must be a string parseRipRisk will
    // select the Coastal Palm Beach block with. That block's rip risk is MODERATE.
    expect(r.name).toBeDefined();
    expect(parseRipRisk(SRF_MFL_FIXTURE, r.name as string)).toBe("moderate");
  });

  it("matches by place name at medium confidence when no zone id is given", () => {
    const r = pickSurfZoneName(SRF_MFL_FIXTURE, { place: "Palm Beach" });
    expect(r.confidence).toBe("medium");
    expect(r.name).toMatch(/Coastal Palm Beach/i);
    expect(parseRipRisk(SRF_MFL_FIXTURE, r.name as string)).toBe("moderate");
  });

  it("zone id wins over a mismatched place name", () => {
    // Ask for the Broward block by id even though place says Miami-Dade.
    const r = pickSurfZoneName(SRF_MFL_FIXTURE, {
      forecastZone: "FLZ172",
      place: "Miami-Dade",
    });
    expect(r.confidence).toBe("high");
    expect(r.name).toMatch(/Coastal Broward/i);
    expect(parseRipRisk(SRF_MFL_FIXTURE, r.name as string)).toBe("low");
  });

  it("prefers a Coastal block and warns (low) when nothing matches", () => {
    const r = pickSurfZoneName(SRF_MFL_FIXTURE, {
      forecastZone: "FLZ999",
      place: "Nowhere",
    });
    expect(r.confidence).toBe("low");
    expect(r.name).toMatch(/^Coastal/i);
    expect(r.note).toBeTruthy();
  });

  it("returns low confidence with a note for empty / unparseable SRF text", () => {
    const r = pickSurfZoneName("", { forecastZone: "FLZ168" });
    expect(r.confidence).toBe("low");
    expect(r.name).toBeUndefined();
    expect(r.note).toBeTruthy();
  });
});
