import { describe, it, expect } from "vitest";
import {
  clampZoom,
  fittedSize,
  IDENTITY,
  MAX_SCALE,
  maxScaleFor,
  originalAllowed,
  parseSizeHeader,
  zoomAt,
} from "@/components/ZoomableImage";

describe("fittedSize", () => {
  it("fits a 16:9 still into a portrait phone box by width", () => {
    const { fw, fh } = fittedSize(390, 650, 1280, 720);
    expect(fw).toBeCloseTo(390);
    expect(fh).toBeCloseTo(219.375);
  });

  it("falls back to the box when the image size is unknown", () => {
    expect(fittedSize(400, 300)).toEqual({ fw: 400, fh: 300 });
    expect(fittedSize(400, 300, 0, 0)).toEqual({ fw: 400, fh: 300 });
  });
});

describe("clampZoom", () => {
  it("snaps back to the identity at 1x or below", () => {
    expect(clampZoom({ scale: 1, x: 50, y: -20 }, 400, 300)).toEqual(IDENTITY);
    expect(clampZoom({ scale: 0.4, x: 5, y: 5 }, 400, 300)).toEqual(IDENTITY);
  });

  it("caps the scale at MAX_SCALE", () => {
    expect(clampZoom({ scale: 50, x: 0, y: 0 }, 400, 300).scale).toBe(MAX_SCALE);
  });

  it("lets a box-filling picture slide until its edge meets the box edge", () => {
    // At 2x a 400-wide picture is 800 wide: 200 px may hang off each side.
    const z = clampZoom({ scale: 2, x: 999, y: -999 }, 400, 300);
    expect(z.x).toBe(200);
    expect(z.y).toBe(-150);
  });

  it("does not let a wide still in a tall box slide off screen vertically", () => {
    // 1280x720 in 390x650 draws 390x219. At 2.5x it is 548 tall, under 650: no vertical pan.
    const { fw, fh } = fittedSize(390, 650, 1280, 720);
    const z = clampZoom({ scale: 2.5, x: 0, y: 400 }, 390, 650, fw, fh);
    expect(z.y).toBe(0);
    // At 4x it is 877 tall: at most (877 - 650) / 2 ≈ 114 px each way.
    const z4 = clampZoom({ scale: 4, x: 0, y: 400 }, 390, 650, fw, fh);
    expect(z4.y).toBeCloseTo((fh * 4 - 650) / 2);
  });
});

describe("zoomAt", () => {
  it("keeps the point under the finger fixed", () => {
    const start = { scale: 1, x: 0, y: 0 };
    const p = { x: 100, y: -40 };
    const z = zoomAt(start, 2.5, p.x, p.y);
    // A point at p in the box maps from picture point (p - t) / s; it must be the same before and after.
    expect((p.x - z.x) / z.scale).toBeCloseTo((p.x - start.x) / start.scale);
    expect((p.y - z.y) / z.scale).toBeCloseTo((p.y - start.y) / start.scale);
  });

  it("zooming at the centre keeps the picture centred", () => {
    expect(zoomAt({ scale: 2, x: 0, y: 0 }, 4, 0, 0)).toEqual({ scale: 4, x: 0, y: 0 });
  });
});

describe("maxScaleFor: zoom stops where the picture runs out of real pixels", () => {
  // A phone: 390 CSS px wide, 3 screen pixels per CSS pixel.
  it("gives a 720p still 2.2x, a 1080p still 3.3x and a 4352 px original the 5x limit", () => {
    expect(maxScaleFor(1280, 390, 3)).toBeCloseTo(2.188, 2);
    expect(maxScaleFor(1920, 390, 3)).toBeCloseTo(3.282, 2);
    expect(maxScaleFor(4352, 390, 3)).toBe(MAX_SCALE);
    expect(maxScaleFor(6000, 390, 3)).toBe(MAX_SCALE);
  });
  it("a feed still of 1200 px is 2.1x, one of 1920 px is 3.3x", () => {
    expect(maxScaleFor(1200, 390, 3)).toBeCloseTo(2.051, 2);
    expect(maxScaleFor(1920, 390, 3)).toBeCloseTo(3.282, 2);
  });
  it("never goes under 2x, even for a small picture on a big screen", () => {
    expect(maxScaleFor(640, 1440, 2)).toBe(2);
  });
  it("is the old fixed limit while the picture size is unknown", () => {
    expect(maxScaleFor(undefined, 390, 3)).toBe(MAX_SCALE);
    expect(maxScaleFor(0, 390, 3)).toBe(MAX_SCALE);
    expect(maxScaleFor(1280, 0, 3)).toBe(MAX_SCALE);
  });
  it("treats a missing or zero pixel ratio as 1", () => {
    expect(maxScaleFor(1280, 640, 0)).toBe(maxScaleFor(1280, 640, 1));
  });
  it("clampZoom honours a lower limit", () => {
    expect(clampZoom({ scale: 4, x: 0, y: 0 }, 400, 300, 400, 300, 2.2).scale).toBe(2.2);
    expect(clampZoom({ scale: 4, x: 0, y: 0 }, 400, 300).scale).toBe(4);
  });
});

describe("originalAllowed: which devices may decode a full-size original", () => {
  const big = { width: 6000, height: 4000 }; // 24 MP: Hobe Sound, Sebastian
  const mid = { width: 5184, height: 3456 }; // 17.9 MP
  const small = { width: 4000, height: 3000 }; // 12 MP
  it("refuses anything over 20 MP everywhere", () => {
    expect(originalAllowed({ ...big, smallScreen: false, saveData: false })).toBe(false);
  });
  it("lets a desktop take up to 20 MP", () => {
    expect(originalAllowed({ ...mid, smallScreen: false, saveData: false })).toBe(true);
  });
  it("keeps a touch or narrow screen to 12 MP", () => {
    expect(originalAllowed({ ...mid, smallScreen: true, saveData: false })).toBe(false);
    expect(originalAllowed({ ...small, smallScreen: true, saveData: false })).toBe(true);
  });
  it("never when the visitor asked to save data", () => {
    expect(originalAllowed({ ...small, smallScreen: false, saveData: true })).toBe(false);
  });
  it("refuses a size that makes no sense", () => {
    expect(originalAllowed({ width: 0, height: 0, smallScreen: false, saveData: false })).toBe(false);
  });
});

describe("parseSizeHeader", () => {
  it("reads WxH and nothing else", () => {
    expect(parseSizeHeader("4352x3264")).toEqual({ width: 4352, height: 3264 });
    for (const bad of [null, "", "4352", "axb", "4352x3264x1", "1e9x1e9", "123456x1"]) expect(parseSizeHeader(bad)).toBeNull();
  });
});
