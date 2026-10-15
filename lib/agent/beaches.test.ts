import { describe, expect, it } from "vitest";
import { listLocations } from "@/config/locations";
import {
  beachUrl,
  filterBeaches,
  findBeach,
  listBeachSummaries,
  nearestBeaches,
  normalizeState,
  stateOf,
} from "@/lib/agent/beaches";
import { haversineMiles } from "@/lib/util";

describe("beach directory", () => {
  const all = listBeachSummaries();

  it("lists every served beach once, each with a state and a page URL", () => {
    expect(all.length).toBe(listLocations().length);
    expect(new Set(all.map((b) => b.slug)).size).toBe(all.length);
    for (const b of all) {
      expect(b.state, b.slug).toMatch(/^[A-Z]{2}$/);
      expect(b.url.startsWith("https://isitbeachday.com/")).toBe(true);
      expect(Number.isFinite(b.lat) && Number.isFinite(b.lon)).toBe(true);
    }
  });

  it("puts the flagship at / and every other beach at /<slug>", () => {
    const urls = all.map((b) => b.url);
    expect(urls.filter((u) => u === "https://isitbeachday.com/")).toHaveLength(1);
    expect(beachUrl("miami-beach")).toBe("https://isitbeachday.com/miami-beach");
  });

  it("reads the state from the region text", () => {
    expect(stateOf("Palm Beach County, FL")).toBe("FL");
    expect(stateOf("Honolulu County, HI")).toBe("HI");
    expect(stateOf("Nowhere")).toBeNull();
  });

  it("normalizes states by code or by name, and refuses nonsense", () => {
    expect(normalizeState("fl")).toBe("FL");
    expect(normalizeState(" Florida ")).toBe("FL");
    expect(normalizeState("new  jersey")).toBe("NJ");
    expect(normalizeState("Atlantis")).toBeNull();
    expect(normalizeState("")).toBeNull();
  });

  it("filters by state and by text in the region or name", () => {
    const fl = filterBeaches(all, { state: "FL" });
    expect(fl.length).toBeGreaterThan(3);
    expect(fl.every((b) => b.state === "FL")).toBe(true);
    expect(filterBeaches(all, { region: "broward" }).map((b) => b.slug)).toContain("deerfield-beach");
    expect(filterBeaches(all, { region: "boca" }).map((b) => b.slug)).toContain("boca-raton");
    expect(filterBeaches(all, { state: "FL", region: "zzz" })).toEqual([]);
  });

  it("finds a beach by slug", () => {
    expect(findBeach("boca-raton")?.name).toBe("Boca Raton");
    expect(findBeach("nope")).toBeUndefined();
  });
});

describe("nearestBeaches", () => {
  it("ranks nearest first, with a distance that matches the map maths", () => {
    // A point just off the sand at Boca Raton.
    const lat = 26.36;
    const lon = -80.06;
    const near = nearestBeaches(lat, lon, 5);
    expect(near).toHaveLength(5);
    expect(near[0].slug).toBe("boca-raton");
    for (let i = 1; i < near.length; i++) expect(near[i].distanceMiles).toBeGreaterThanOrEqual(near[i - 1].distanceMiles);
    // Shore distance is measured to the shoreline, not the pin, but they are close for a point this near.
    const pinMi = haversineMiles(lat, lon, near[0].lat, near[0].lon);
    expect(Math.abs(near[0].distanceMiles - pinMi)).toBeLessThan(0.4);
    expect(near[0].distanceKm).toBeCloseTo(near[0].distanceMiles * 1.609344, 0);
  });

  it("gives a compass bearing toward the sand, as degrees and a word", () => {
    // Due west of Boca Raton in the Gulf-side suburbs: the beach is to the east.
    const [first] = nearestBeaches(26.36, -80.2, 1);
    expect(first.slug).toBe("boca-raton");
    expect(first.bearingDeg).toBeGreaterThan(60);
    expect(first.bearingDeg).toBeLessThan(120);
    expect(first.direction).toMatch(/^(ENE|E|ESE)$/);
  });

  it("is distance zero on the sand itself", () => {
    const boca = findBeach("boca-raton")!;
    expect(nearestBeaches(boca.lat, boca.lon, 1)[0].distanceMiles).toBeLessThan(0.5);
  });

  it("honors the limit and a pool, and works from the other side of the world", () => {
    expect(nearestBeaches(0, 0, 3)).toHaveLength(3);
    expect(nearestBeaches(0, 0, 0)).toHaveLength(0);
    const pool = filterBeaches(listBeachSummaries(), { state: "HI" });
    const [hi] = nearestBeaches(26.3, -80.07, 1, pool);
    expect(hi.state).toBe("HI");
    expect(hi.distanceMiles).toBeGreaterThan(3000);
  });
});
