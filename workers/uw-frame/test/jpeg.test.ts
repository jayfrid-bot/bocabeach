import { describe, expect, it } from "vitest";
import { readJpegDimensions } from "../src/lib/jpeg";

function u16(n: number): number[] {
  return [(n >> 8) & 0xff, n & 0xff];
}

/** Builds a minimal-but-structurally-real JPEG byte buffer for testing. */
function buildMinimalJpeg(width: number, height: number, withApp0 = false): Uint8Array {
  const bytes: number[] = [0xff, 0xd8]; // SOI
  if (withApp0) {
    // A JFIF APP0 segment: length 4 (2 length bytes + 2 payload bytes).
    bytes.push(0xff, 0xe0, ...u16(4), 0xaa, 0xbb);
  }
  // SOF0: Lf = 11 -> P(1) + Y(2) + X(2) + Nf(1) + one component(3) = 9, + 2 length bytes.
  bytes.push(0xff, 0xc0, ...u16(11), 0x08, ...u16(height), ...u16(width), 0x01, 0x01, 0x11, 0x00);
  bytes.push(0xff, 0xd9); // EOI
  return new Uint8Array(bytes);
}

describe("readJpegDimensions", () => {
  it("returns null for a buffer that isn't a JPEG at all", () => {
    expect(readJpegDimensions(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull(); // PNG magic
    expect(readJpegDimensions(new Uint8Array([]))).toBeNull();
    expect(readJpegDimensions(new Uint8Array([0xff]))).toBeNull();
  });

  it("reads width/height from a minimal SOF0 JPEG", () => {
    const jpeg = buildMinimalJpeg(1280, 720);
    expect(readJpegDimensions(jpeg)).toEqual({ width: 1280, height: 720 });
  });

  it("skips a leading APP0/JFIF segment to find the SOF", () => {
    const jpeg = buildMinimalJpeg(640, 480, true);
    expect(readJpegDimensions(jpeg)).toEqual({ width: 640, height: 480 });
  });

  it("handles odd/non-16:9 dimensions correctly (no assumptions baked in)", () => {
    const jpeg = buildMinimalJpeg(853, 481);
    expect(readJpegDimensions(jpeg)).toEqual({ width: 853, height: 481 });
  });

  it("returns null when the buffer is truncated mid-segment", () => {
    const full = buildMinimalJpeg(1280, 720);
    const truncated = full.slice(0, full.length - 10);
    expect(readJpegDimensions(truncated)).toBeNull();
  });

  it("returns null when a scan marker is hit before any SOF is found", () => {
    // SOI then straight to Start-Of-Scan with no frame header at all.
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]);
    expect(readJpegDimensions(bytes)).toBeNull();
  });
});
