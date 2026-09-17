import { describe, it, expect } from "vitest";
import { listLocations } from "@/config/locations";

/**
 * Sanity checks over the whole beach list (hand-curated LOCATIONS + admin-added
 * GENERATED entries — see config/locations.ts's allLocations()). Catches a
 * copy-paste slug/cam-id collision or a non-https snapshot URL before it ships,
 * and pins down the specific shape Deerfield Beach needs (its own score inputs
 * + flags feed + all four cams) so a future refactor can't quietly drop one.
 */

const ALL = listLocations();
const CURATED = ALL.filter((l) => l.tier === undefined || l.tier === "curated");

describe("every curated location has the fields the score/UI depend on", () => {
  for (const loc of CURATED) {
    it(`"${loc.slug}" has slug/name/region/lat/lon/timezone/tide/buoy`, () => {
      expect(loc.slug).toBeTruthy();
      expect(loc.name).toBeTruthy();
      expect(loc.region).toBeTruthy();
      expect(typeof loc.lat).toBe("number");
      expect(typeof loc.lon).toBe("number");
      expect(loc.timezone).toBeTruthy();
      expect(loc.noaaTideStationId).toBeTruthy();
      expect(loc.ndbcBuoyId).toBeTruthy();
    });
  }
});

describe("slugs are unique across every location", () => {
  it("has no duplicate slug", () => {
    const slugs = ALL.map((l) => l.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe("cam ids are unique across every location", () => {
  it("has no duplicate cam id", () => {
    const ids = ALL.flatMap((l) => l.cams.map((c) => c.id).filter((id): id is string => !!id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("every cam snapshotUrl is https", () => {
  for (const loc of ALL) {
    for (const cam of loc.cams) {
      if (!cam.snapshotUrl) continue;
      it(`"${loc.slug}" cam "${cam.id ?? cam.name}" snapshotUrl is https`, () => {
        expect(cam.snapshotUrl!.startsWith("https://")).toBe(true);
      });
    }
  }
});

describe("Deerfield Beach", () => {
  const loc = ALL.find((l) => l.slug === "deerfield-beach");

  it("is registered", () => {
    expect(loc).toBeDefined();
  });

  it("has a flags feed (its official page isn't scrapable HTML)", () => {
    expect(loc?.flagsFeedUrl).toBeTruthy();
    expect(loc!.flagsFeedUrl!.startsWith("https://")).toBe(true);
  });

  it("has exactly four cams: crowd, surf, pier, and the underwater sea cam", () => {
    expect(loc?.cams).toHaveLength(4);
    const ids = loc!.cams.map((c) => c.id).sort();
    expect(ids).toEqual(
      ["deerfield-beach-cam", "deerfield-pier-cam", "deerfield-spinner-uw", "deerfield-surf-cam"].sort(),
    );
  });

  it("every cam is a proxied same-origin image with a stable id + attribution", () => {
    for (const cam of loc!.cams) {
      expect(cam.embedType).toBe("image");
      expect(cam.id).toBeTruthy();
      expect(cam.snapshotUrl).toBeTruthy();
      expect(cam.attribution).toBeTruthy();
    }
  });
});

describe("fort-lauderdale", () => {
  const loc = ALL.find((l) => l.slug === "fort-lauderdale");
  it("is a curated Broward beach with water quality, tides, and a wave buoy", () => {
    expect(loc).toBeDefined();
    expect(loc?.region).toBe("Broward County, FL");
    expect(loc?.healthyBeaches).toEqual({ county: "Broward", sites: ["SEBASTIAN STREET", "BAHIA MAR"] });
    expect(loc?.noaaTideStationId).toBe("8722939");
    expect(loc?.ndbcBuoyId).toBe("41122");
    expect(loc?.surfZone).toEqual({ office: "MFL", name: "Broward" });
  });
});
