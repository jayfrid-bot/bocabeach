import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readLumaDc } from "../src/lib/dcLuma";
import { regionStats } from "../src/lib/frameQuality";

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

// Expected region statistics come from a FULL decode (jpeg-js, BT.601 luma, 8x8
// block averages) of the same file, taken once on 2026-10-17. The DC-only reader
// must agree to within 1 level of brightness.
const REFERENCE: Record<string, { cols: number; rows: number; mean: number; p95: number }> = {
  "black-noise-20696.jpg": { cols: 160, rows: 90, mean: 20.8, p95: 23 },
  "black-slate-12815.jpg": { cols: 160, rows: 90, mean: 20.8, p95: 22 },
  "daylight-pensacola.jpg": { cols: 160, rows: 90, mean: 121.8, p95: 158 },
  "daylight-fortmyers-q30.jpg": { cols: 160, rows: 90, mean: 132.2, p95: 175 },
  "night-pier-lights.jpg": { cols: 160, rows: 90, mean: 28.6, p95: 45 },
  "underwater-flat.jpg": { cols: 160, rows: 90, mean: 140.8, p95: 170 },
  "daylight-640-baseline.jpg": { cols: 80, rows: 45, mean: 132.3, p95: 166 },
};

describe("readLumaDc", () => {
  for (const [name, ref] of Object.entries(REFERENCE)) {
    it(`matches a full decode for ${name}`, () => {
      const grid = readLumaDc(fixture(name));
      expect(grid).not.toBeNull();
      expect(grid!.cols).toBe(ref.cols);
      expect(grid!.rows).toBe(ref.rows);
      const stats = regionStats(grid!)!;
      expect(Math.abs(stats.mean - ref.mean)).toBeLessThanOrEqual(1);
      expect(Math.abs(stats.p95 - ref.p95)).toBeLessThanOrEqual(1);
    });
  }

  it("reads the picture size", () => {
    const grid = readLumaDc(fixture("black-slate-12815.jpg"))!;
    expect([grid.width, grid.height]).toEqual([1280, 720]);
  });

  it("reads a JPEG that uses restart markers the same as one that does not", () => {
    const plain = readLumaDc(fixture("daylight-640-baseline.jpg"))!;
    const restart = readLumaDc(fixture("daylight-640-restart.jpg"))!;
    expect(restart).not.toBeNull();
    expect(Array.from(restart.data)).toEqual(Array.from(plain.data));
  });

  it("returns null for a progressive JPEG (not supported, so not checked)", () => {
    expect(readLumaDc(fixture("daylight-640-progressive.jpg"))).toBeNull();
  });

  it("returns null for a file cut short, rather than a grey guess", () => {
    const whole = fixture("daylight-640-baseline.jpg");
    expect(readLumaDc(whole.subarray(0, Math.floor(whole.length / 2)))).toBeNull();
  });

  it("returns null for bytes that are not a JPEG, and never throws", () => {
    expect(readLumaDc(new Uint8Array([1, 2, 3, 4, 5, 6]))).toBeNull();
    expect(readLumaDc(new Uint8Array(0))).toBeNull();
    const junk = new Uint8Array(2000).map((_, i) => (i * 37) & 255);
    junk[0] = 0xff;
    junk[1] = 0xd8;
    expect(() => readLumaDc(junk)).not.toThrow();
  });

  it("is cheap: a 1280x720 frame reads in well under the 10 ms CPU limit once warm", () => {
    const bytes = fixture("night-pier-lights.jpg");
    readLumaDc(bytes); // warm up the JIT
    // Best of several runs: the full suite runs files in parallel, so one slow
    // run says more about the machine than about the decoder.
    let best = Infinity;
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now();
      readLumaDc(bytes);
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(10);
  });
});
