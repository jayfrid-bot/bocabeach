import { describe, it, expect } from "vitest";
import { parseGeocode } from "@/lib/resolve/geocode";

// Realistic Open-Meteo /v1/search response for "Boca Raton". Includes a non-US
// row (filtered out) and a non-PPL place (kind "place") to exercise mapping.
const OPEN_METEO_BOCA = {
  generationtime_ms: 0.7,
  results: [
    {
      id: 4151316,
      name: "Boca Raton",
      latitude: 26.35869,
      longitude: -80.0831,
      elevation: 4,
      feature_code: "PPLA2",
      country_code: "US",
      admin1: "Florida",
      admin2: "Palm Beach",
      timezone: "America/New_York",
      population: 93235,
      country: "United States",
      country_id: 6252001,
    },
    {
      id: 99999,
      name: "Boca Raton Inlet",
      latitude: 26.3399,
      longitude: -80.0719,
      feature_code: "CHN", // not a populated place -> kind "place"
      country_code: "US",
      admin1: "Florida",
      timezone: "America/New_York",
    },
    {
      id: 12345,
      name: "Boca Chica",
      latitude: 18.45,
      longitude: -69.6,
      feature_code: "PPL",
      country_code: "DO", // non-US -> filtered out
      admin1: "Santo Domingo",
      timezone: "America/Santo_Domingo",
    },
  ],
};

describe("parseGeocode", () => {
  it("maps an Open-Meteo result to a GeoPoint (Boca Raton)", () => {
    const points = parseGeocode(OPEN_METEO_BOCA);
    // The non-US row is dropped, leaving the two FL results.
    expect(points).toHaveLength(2);

    const boca = points[0];
    expect(boca.name).toBe("Boca Raton");
    expect(boca.lat).toBeCloseTo(26.35, 1);
    expect(boca.lon).toBeCloseTo(-80.08, 1);
    expect(boca.admin1).toBe("Florida");
    expect(boca.admin1Code).toBe("FL");
    expect(boca.countryCode).toBe("US");
    expect(boca.timezone).toBe("America/New_York");
    expect(boca.population).toBe(93235);
    expect(boca.featureCode).toBe("PPLA2");
    expect(boca.kind).toBe("city"); // feature_code starts with "PPL"
  });

  it("classifies non-PPL feature codes as kind 'place'", () => {
    const inlet = parseGeocode(OPEN_METEO_BOCA)[1];
    expect(inlet.name).toBe("Boca Raton Inlet");
    expect(inlet.kind).toBe("place");
    expect(inlet.admin1Code).toBe("FL");
  });

  it("filters out non-US results", () => {
    const points = parseGeocode(OPEN_METEO_BOCA);
    expect(points.some((p) => p.name === "Boca Chica")).toBe(false);
    expect(points.every((p) => p.countryCode === "US")).toBe(true);
  });

  it("is defensive against missing/empty/mistyped input", () => {
    expect(parseGeocode(undefined)).toEqual([]);
    expect(parseGeocode(null)).toEqual([]);
    expect(parseGeocode({})).toEqual([]);
    expect(parseGeocode({ results: [] })).toEqual([]);
    expect(parseGeocode({ results: "nope" })).toEqual([]);
    // Rows missing coordinates are skipped; an unknown state yields no admin1Code.
    const partial = parseGeocode({
      results: [
        { name: "No Coords", country_code: "US" },
        {
          name: "Mystery",
          latitude: 40,
          longitude: -100,
          country_code: "US",
          admin1: "Nowhereland",
          feature_code: "PPL",
        },
      ],
    });
    expect(partial).toHaveLength(1);
    expect(partial[0].name).toBe("Mystery");
    expect(partial[0].admin1Code).toBeUndefined();
    expect(partial[0].kind).toBe("city");
  });
});
