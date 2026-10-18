import { describe, it, expect } from "vitest";
import { clampZoom, fittedSize, IDENTITY, MAX_SCALE, zoomAt } from "@/components/ZoomableImage";

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
