// config/sun-cams.json must stay in lockstep with config/locations.ts and the
// camera courier, or the ingest route would reject (or mislabel) what the Mac
// script uploads.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getLocation } from "@/config/locations";
import { SUN_CAMS, camFacing, expectedView } from "@/lib/sunObservations";

function miles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.7613;
  const rad = (d: number) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function locationCam(camId: string) {
  for (const slug of ["boca-raton", "deerfield-beach", "fort-lauderdale", "fort-myers-beach", "pensacola-beach", "jacksonville-beach"]) {
    const cam = getLocation(slug)?.cams?.find((c) => c.id === camId);
    if (cam) return cam;
  }
  return undefined;
}

describe("config/sun-cams.json", () => {
  it("lists the seven 24/7 livestream cams", () => {
    expect(SUN_CAMS.map((c) => c.id).sort()).toEqual([
      "deerfield-beach-cam",
      "deerfield-pier-cam",
      "deerfield-surf-cam",
      "fort-myers-beach-cam",
      "ftl-elbo-beach-cam",
      "jax-beach-bw-cam",
      "pensacola-sria-west-cam",
    ]);
  });

  it("the two Gulf cams face west: a sunset is the solar view, a sunrise the antisolar view", () => {
    const west = SUN_CAMS.filter((c) => c.facing === "west");
    expect(west.map((c) => c.id).sort()).toEqual(["fort-myers-beach-cam", "pensacola-sria-west-cam"]);
    for (const cam of west) {
      expect(cam.facing_azimuth_deg).toBeGreaterThanOrEqual(210);
      expect(cam.facing_azimuth_deg).toBeLessThanOrEqual(300);
      expect(expectedView("sunset", camFacing(cam))).toBe("solar");
      expect(expectedView("sunrise", camFacing(cam))).toBe("antisolar");
    }
  });

  it("the Jacksonville Beach cam looks east-north-east: its sunrise is the solar view, with the owners credited", () => {
    const cam = SUN_CAMS.find((c) => c.id === "jax-beach-bw-cam");
    expect(cam).toBeDefined();
    expect(cam?.facing_azimuth_deg).toBe(70);
    expect(expectedView("sunrise", camFacing(cam!))).toBe("solar");
    expect(expectedView("sunset", camFacing(cam!))).toBe("antisolar");
    expect(cam?.credit).toMatch(/Best Western Oceanfront Jacksonville Beach and 911 Surf Report/);
  });

  it("every cam without a facing label looks east (the Atlantic cams)", () => {
    for (const cam of SUN_CAMS.filter((c) => c.facing === undefined)) {
      expect(cam.facing_azimuth_deg).toBe(90);
    }
  });

  it("the west cams credit a public body (no business cam is added without permission)", () => {
    expect(SUN_CAMS.find((c) => c.id === "pensacola-sria-west-cam")?.credit).toMatch(/Santa Rosa Island Authority/);
    expect(SUN_CAMS.find((c) => c.id === "fort-myers-beach-cam")?.credit).toMatch(/Visit Fort Myers/);
  });

  it("every cam is a registered cam with the same credit, and its YouTube id matches the courier's", () => {
    const courier = readFileSync(path.join(process.cwd(), "scripts/cam_courier_local.sh"), "utf8");
    for (const cam of SUN_CAMS) {
      const registered = locationCam(cam.id);
      expect(registered, `${cam.id} is not in config/locations.ts`).toBeDefined();
      expect(cam.credit).toBe(registered?.attribution);
      expect(courier).toContain(`${cam.id}:${cam.youtube_id}`);
      if (registered?.url?.includes("youtube.com")) expect(registered.url).toContain(cam.youtube_id);
      expect(cam.lat).toBeCloseTo(registered?.lat ?? 0, 4);
      expect(cam.lon).toBeCloseTo(registered?.lon ?? 0, 4);
    }
  });

  it("credits Elbo Room on the Fort Lauderdale cam", () => {
    expect(SUN_CAMS.find((c) => c.id === "ftl-elbo-beach-cam")?.credit).toMatch(/Elbo Room/);
  });

  it("every observed beach exists, repeats its coordinates, and has the right distance", () => {
    for (const cam of SUN_CAMS) {
      expect(cam.beaches.length).toBeGreaterThan(0);
      for (const b of cam.beaches) {
        const loc = getLocation(b.slug);
        expect(loc, `${b.slug} is not a served beach`).toBeDefined();
        expect(b.lat).toBe(loc?.lat);
        expect(b.lon).toBe(loc?.lon);
        expect(Math.abs(b.distance_mi - miles(b.lat, b.lon, cam.lat, cam.lon))).toBeLessThanOrEqual(0.1);
      }
    }
  });

  it("the Deerfield cams also stand in for Boca Raton; every other cam serves only its own beach", () => {
    const own: Record<string, string> = {
      "ftl-elbo-beach-cam": "fort-lauderdale",
      "fort-myers-beach-cam": "fort-myers-beach",
      "pensacola-sria-west-cam": "pensacola-beach",
      "jax-beach-bw-cam": "jacksonville-beach",
    };
    for (const cam of SUN_CAMS) {
      const slugs = cam.beaches.map((b) => b.slug).sort();
      expect(slugs).toEqual(cam.id.startsWith("deerfield") ? ["boca-raton", "deerfield-beach"] : [own[cam.id]]);
    }
  });

  it("every cam's facing is east or west and agrees with its azimuth", () => {
    for (const cam of SUN_CAMS) {
      expect(["east", "west"], `${cam.id} facing`).toContain(camFacing(cam));
      if (cam.facing !== undefined) {
        const derived = cam.facing_azimuth_deg % 360 < 180 ? "east" : "west";
        expect(cam.facing, `${cam.id}: facing disagrees with facing_azimuth_deg`).toBe(derived);
      }
    }
  });

  it("sky regions are non-empty rectangles inside the frame", () => {
    for (const cam of SUN_CAMS) {
      expect(cam.sky_regions.length).toBeGreaterThan(0);
      for (const [x0, y0, x1, y1] of cam.sky_regions) {
        expect(x0).toBeGreaterThanOrEqual(0);
        expect(y0).toBeGreaterThanOrEqual(0);
        expect(x1).toBeLessThanOrEqual(1);
        expect(y1).toBeLessThanOrEqual(1);
        expect(x1).toBeGreaterThan(x0);
        expect(y1).toBeGreaterThan(y0);
      }
    }
  });
});
