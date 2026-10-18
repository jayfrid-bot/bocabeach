import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { jpegSize } from "@/lib/jpegSize";

const doc = (name: string) => new Uint8Array(readFileSync(new URL(`../docs/research/2026-10-18-cam-resolution/${name}`, import.meta.url)));

describe("jpegSize", () => {
  it("reads a real 1080p courier frame and a real 720p one", () => {
    expect(jpegSize(doc("deerfield-beach-cam_1080p.jpg"))).toEqual({ width: 1920, height: 1080 });
    expect(jpegSize(doc("deerfield-beach-cam_720p.jpg"))).toEqual({ width: 1280, height: 720 });
  });
  it("reads a real feed still", () => {
    expect(jpegSize(doc("vm-boca-s4-mr.jpg"))).toEqual({ width: 1200, height: 900 });
  });
  it("reads only the header, so the first few KB are enough", () => {
    expect(jpegSize(doc("deerfield-beach-cam_1080p.jpg").subarray(0, 4096))).toEqual({ width: 1920, height: 1080 });
  });
  it("is null for anything that is not a readable JPEG", () => {
    expect(jpegSize(new Uint8Array())).toBeNull();
    expect(jpegSize(new TextEncoder().encode("<html>not a picture</html>"))).toBeNull();
    expect(jpegSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0]))).toBeNull();
  });
});
