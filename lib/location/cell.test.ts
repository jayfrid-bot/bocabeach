import { describe, expect, it } from "vitest";
import { cellKey, cellCenter } from "@/lib/location/cell";

describe("cellKey", () => {
  it("is stable for two points in the same cell", () => {
    const a = cellKey(26.3587, -80.0686);
    const b = cellKey(26.36, -80.09);
    expect(a).toBe(b);
    expect(a).toBe("26.35,-80.10");
  });

  it("floors negative longitude toward the more-negative cell, not toward zero", () => {
    // -80.001 must fall in the -80.05 cell (floor), never round up to -80.00.
    expect(cellKey(26.0, -80.001, 0.05)).toBe("26.00,-80.05");
    // A value already exactly on a boundary stays in its own cell.
    expect(cellKey(26.0, -80.05, 0.05)).toBe("26.00,-80.05");
  });

  it("differs across a cell boundary", () => {
    expect(cellKey(26.3, -80.0, 0.05)).not.toBe(cellKey(26.36, -80.0, 0.05));
  });

  it("honors a custom cell size", () => {
    expect(cellKey(26.34, -80.07, 0.1)).toBe("26.3,-80.1");
  });
});

describe("cellCenter", () => {
  it("round-trips: the center of a cell maps back to the same key", () => {
    const key = cellKey(26.3587, -80.0686);
    const center = cellCenter(key);
    expect(cellKey(center.lat, center.lon)).toBe(key);
  });

  it("places the center strictly inside the cell's bounds", () => {
    const sizeDeg = 0.05;
    const key = cellKey(26.3587, -80.0686, sizeDeg);
    const [latLo, lonLo] = key.split(",").map(Number);
    const center = cellCenter(key, sizeDeg);
    expect(center.lat).toBeGreaterThan(latLo);
    expect(center.lat).toBeLessThan(latLo + sizeDeg);
    expect(center.lon).toBeGreaterThan(lonLo);
    expect(center.lon).toBeLessThan(lonLo + sizeDeg);
  });
});
