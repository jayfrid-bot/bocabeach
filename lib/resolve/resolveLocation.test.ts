import { describe, it, expect } from "vitest";

import { resolveBeach, type ResolveDeps } from "@/lib/resolve/resolveLocation";
import { pickSurfZoneName } from "@/lib/resolve/nwsZone";
import type { Confidence, GeoPoint } from "@/lib/resolve/types";
import {
  BEACH_FIXTURE,
  BUOY_FIXTURE,
  GEOCODE_BOCA,
  SRF_MFL_FIXTURE,
  TIDE_FIXTURE,
} from "@/lib/resolve/__fixtures__/registries";

// --- stubbed deps -----------------------------------------------------------
// We inject the fixture registries and stub the two network calls (geocode +
// NWS surf zone) so the resolver runs offline and deterministically. The surf
// stub reuses the real pickSurfZoneName over the SRF fixture, so MFL/high
// confidence comes out exactly as the live path would produce it.

/** An inland (non-coastal) US city far from any coast-confirmed beach. */
const GEOCODE_DENVER: GeoPoint = {
  name: "Denver",
  lat: 39.7392,
  lon: -104.9903,
  admin1: "Colorado",
  admin1Code: "CO",
  countryCode: "US",
  timezone: "America/Denver",
  population: 715522,
  featureCode: "PPLA",
  kind: "city",
};

/** A US city whose centroid sits ~10mi off, between two beaches that tie. */
const GEOCODE_MULTI: GeoPoint = {
  name: "Twin Beaches",
  lat: 26.2, // ~ between South Beach Park (26.3456) and Fort Lauderdale Beach (26.1413)
  lon: -80.09,
  admin1: "Florida",
  admin1Code: "FL",
  countryCode: "US",
  timezone: "America/New_York",
  population: 50000,
  featureCode: "PPL",
  kind: "city",
};

/** A non-US top hit (the geocoder is normally US-filtered; this exercises the guard). */
const GEOCODE_NON_US: GeoPoint = {
  name: "Cancún",
  lat: 21.1619,
  lon: -86.8515,
  countryCode: "MX",
  timezone: "America/Cancun",
  kind: "city",
};

const GEO_TABLE: Record<string, GeoPoint[]> = {
  "boca raton": [GEOCODE_BOCA],
  denver: [GEOCODE_DENVER],
  "twin beaches": [GEOCODE_MULTI],
  cancun: [GEOCODE_NON_US],
};

function makeDeps(over: Partial<ResolveDeps> = {}): ResolveDeps {
  return {
    geocodeName: async (q: string) => GEO_TABLE[q.trim().toLowerCase()] ?? [],
    loadBeachRegistry: () => BEACH_FIXTURE,
    loadTideStations: () => TIDE_FIXTURE,
    loadBuoyStations: () => BUOY_FIXTURE,
    // Mirror the live resolveSurfZone shape: office (high conf) + a name picked
    // from the SRF text. The Boca point falls in the MFL coverage area.
    resolveSurfZone: async (
      _lat: number,
      _lon: number,
      place?: string,
    ): Promise<{ office?: string; name?: string; confidence: Confidence; note?: string }> => {
      const picked = pickSurfZoneName(SRF_MFL_FIXTURE, { place, forecastZone: "FLZ168" });
      return { office: "MFL", ...picked };
    },
    ...over,
  };
}

describe("resolveBeach — golden anchor (Boca Raton)", () => {
  it("resolves Boca Raton to the hand-written config values", async () => {
    // Empty taken-list so the slug is the clean base (the live default collides
    // with the existing config "boca-raton", which is exercised separately below).
    const r = await resolveBeach("Boca Raton", { takenSlugs: [] }, makeDeps());

    expect(r.status).toBe("resolved");
    const loc = r.location;
    expect(loc).toBeDefined();
    if (!loc) return;

    // Beach point (Red Reef Park centroid) — matches config/locations.ts.
    expect(loc.lat).toBeGreaterThanOrEqual(26.35);
    expect(loc.lat).toBeLessThanOrEqual(26.36);
    expect(loc.timezone).toBe("America/New_York");

    // Station chain mirrors the current hand-written Boca entry.
    expect(loc.noaaTideStationId).toBe("8722816");
    expect(loc.noaaTideStationFallbackId).toBe("8722670");
    expect(loc.ndbcBuoyId).toBe("LKWF1");
    expect(loc.ndbcBuoyFallbackId).toBe("FWYF1");

    // Surf zone office is MFL (high-confidence); name comes from the SRF block.
    expect(loc.surfZone?.office).toBe("MFL");
    expect(loc.surfZone?.name).toMatch(/Palm Beach/i);

    // Curated fields are intentionally left blank for a human.
    expect(loc.cams).toEqual([]);
    expect(loc.cityConditionsUrl).toBeUndefined();
    expect(loc.healthyBeaches).toBeUndefined();

    // Slug is collision-free against the supplied taken list.
    expect(loc.slug).toBe("boca-raton");
  });

  it("fills provenance with sources, confidences, and distances", async () => {
    const r = await resolveBeach("Boca Raton", {}, makeDeps());
    const p = r.provenance;
    expect(p).toBeDefined();
    if (!p) return;

    expect(p.noaaTideStationId.source).toBe("tide-registry");
    expect(p.noaaTideStationId.confidence).toBe("high");
    expect(p.noaaTideStationId.distanceMi).toBeDefined();
    expect(p.ndbcBuoyId.source).toBe("buoy-registry");
    expect(p.surfZone.source).toBe("nws-srf");
    expect(p.surfZone.confidence).toBe("high");
    expect(p.timezone.value).toBe("America/New_York");
  });

  it("disambiguates the slug against a taken list", async () => {
    const r = await resolveBeach("Boca Raton", { takenSlugs: ["boca-raton"] }, makeDeps());
    expect(r.location?.slug).toBe("boca-raton-fl");
  });
});

describe("resolveBeach — pick-list / rejection paths", () => {
  it("returns a pick-list when a multi-beach city has no clear nearest beach", async () => {
    const r = await resolveBeach("Twin Beaches", {}, makeDeps());
    expect(r.status).toBe("pick-list");
    expect(r.candidates.length).toBeGreaterThanOrEqual(2);
    // No Location is emitted for a pick-list.
    expect(r.location).toBeUndefined();
  });

  it("auto-picks a pick-list candidate when opts.pick is set", async () => {
    const r = await resolveBeach("Twin Beaches", { pick: 0 }, makeDeps());
    expect(r.status).toBe("resolved");
    expect(r.location).toBeDefined();
  });

  it("rejects an inland/non-coastal point with COASTAL_GATE_FAIL", async () => {
    const r = await resolveBeach("Denver", {}, makeDeps());
    expect(r.status).toBe("rejected");
    expect(r.warnings.some((w) => w.code === "COASTAL_GATE_FAIL")).toBe(true);
    expect(r.location).toBeUndefined();
  });

  it("rejects a non-US geocode with NON_US", async () => {
    const r = await resolveBeach("Cancun", {}, makeDeps());
    expect(r.status).toBe("rejected");
    expect(r.warnings.some((w) => w.code === "NON_US")).toBe(true);
    expect(r.location).toBeUndefined();
  });

  it("rejects when neither geocode nor beach-name match anything", async () => {
    const r = await resolveBeach("Nonexistent Placeville", {}, makeDeps());
    expect(r.status).toBe("rejected");
    expect(r.warnings.some((w) => w.code === "GEOCODE_FAILED")).toBe(true);
  });
});

describe("resolveBeach — degradation (never throws)", () => {
  it("degrades to a warning when a station registry is empty", async () => {
    const deps = makeDeps({ loadBuoyStations: () => [] });
    const r = await resolveBeach("Boca Raton", {}, deps);
    expect(r.status).toBe("resolved");
    expect(r.location?.ndbcBuoyId).toBe("");
    expect(r.warnings.some((w) => w.code === "NO_BUOY_IN_RANGE")).toBe(true);
  });

  it("degrades to a warning when the surf-zone lookup throws", async () => {
    const deps = makeDeps({
      resolveSurfZone: async () => {
        throw new Error("network down");
      },
    });
    const r = await resolveBeach("Boca Raton", {}, deps);
    expect(r.status).toBe("resolved");
    expect(r.location?.surfZone).toBeUndefined();
    expect(r.warnings.some((w) => w.code === "SURF_ZONE_UNCERTAIN")).toBe(true);
  });
});
