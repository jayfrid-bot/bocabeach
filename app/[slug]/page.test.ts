import { describe, expect, it } from "vitest";
import { beachDescription } from "./beachDescription";
import { getLocation } from "@/config/locations";
import type { Location } from "@/lib/types";

// Minimal fixture for a beach with none of the optional local coverage: no
// cams, no water-quality sites, no lifeguard-flag source. Most auto-generated
// beaches look like this.
const NO_CAM_LOCATION: Location = {
  slug: "test-no-cam",
  name: "Test No-Cam Beach",
  region: "Test County, FL",
  lat: 0,
  lon: 0,
  timezone: "America/New_York",
  tier: "auto",
  noaaTideStationId: "0000000",
  ndbcBuoyId: "TEST1",
  cams: [],
};

describe("beachDescription", () => {
  it("stays under 160 characters and keeps the always-on topics for a beach with no cams", () => {
    const desc = beachDescription(NO_CAM_LOCATION);
    expect(desc.length).toBeLessThanOrEqual(160);
    for (const topic of ["Beach Day score", "weather", "water temp", "waves", "tides", "UV", "wind"]) {
      expect(desc).toContain(topic);
    }
  });

  it("never claims seaweed, crowds, water quality or lifeguard flags for a no-cam, no-site beach", () => {
    const desc = beachDescription(NO_CAM_LOCATION);
    for (const claim of ["seaweed", "crowd", "water quality", "lifeguard"]) {
      expect(desc.toLowerCase()).not.toContain(claim);
    }
  });

  it("adds seaweed/crowds, water quality and lifeguard flags for a fully-curated cam beach, staying under 160 chars", () => {
    const boca = getLocation("boca-raton");
    expect(boca).toBeDefined();
    const desc = beachDescription(boca as Location);
    expect(desc.length).toBeLessThanOrEqual(160);
    for (const topic of [
      "Beach Day score",
      "weather",
      "water temp",
      "waves",
      "tides",
      "UV",
      "wind",
      "seaweed",
      "crowds",
      "water quality",
      "lifeguard flags",
    ]) {
      expect(desc).toContain(topic);
    }
  });

  it("stays under 160 characters for every real beach in the config", () => {
    for (const slug of ["boca-raton", "deerfield-beach", "fort-lauderdale"]) {
      const loc = getLocation(slug);
      expect(loc).toBeDefined();
      expect(beachDescription(loc as Location).length).toBeLessThanOrEqual(160);
    }
  });
});
