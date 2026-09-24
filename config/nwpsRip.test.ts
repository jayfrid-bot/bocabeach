import { describe, it, expect } from "vitest";
import { NWPS_RIP_COVERAGE } from "@/config/nwpsRip";
import { listLocations } from "@/config/locations";

describe("NWPS_RIP_COVERAGE (config/nwpsRip.ts)", () => {
  it("parses to a non-empty map", () => {
    const slugs = Object.keys(NWPS_RIP_COVERAGE);
    expect(slugs.length).toBeGreaterThan(0);
  });

  it("every entry is within 3 km of the beach's shoreline", () => {
    for (const [slug, c] of Object.entries(NWPS_RIP_COVERAGE)) {
      expect(c.distKm, `${slug} distKm`).toBeLessThanOrEqual(3);
      expect(c.distKm).toBeGreaterThanOrEqual(0);
    }
  });

  it("every entry references a real beach in config/locations.ts", () => {
    const known = new Set(listLocations().map((l) => l.slug));
    for (const slug of Object.keys(NWPS_RIP_COVERAGE)) {
      expect(known.has(slug), `${slug} not in listLocations()`).toBe(true);
    }
  });

  it("every entry has a lowercase 3-letter office id and a valid region", () => {
    const regions = new Set(["sr", "er", "wr", "pr", "ar"]);
    for (const [slug, c] of Object.entries(NWPS_RIP_COVERAGE)) {
      expect(c.office, slug).toMatch(/^[a-z]{3}$/);
      expect(regions.has(c.region), `${slug} region ${c.region}`).toBe(true);
      expect(Number.isFinite(c.lat)).toBe(true);
      expect(Number.isFinite(c.lon)).toBe(true);
    }
  });
});
