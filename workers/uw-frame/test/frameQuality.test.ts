import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readJpegDimensions } from "../src/lib/jpeg";
import { BLANK_MEAN_AT_LEAST, BLANK_P95_BELOW, judgeFrame, MAX_FRAME_BYTES, MIN_FRAME_BYTES, RICH_FRAME_BYTES, richThresholdBytes } from "../src/lib/frameQuality";

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
// Always read the pixels, whatever the size.
const CHECK_ALL = { richBytes: null } as const;

describe("judgeFrame: frames that are NOT a real picture", () => {
  const blanks: [string, string][] = [
    ["spinner-pensacola.jpg", "YouTube loading spinner on black, stored as good by the browser grab (Pensacola, 2026-10-17 22:02Z)"],
    ["spinner-deerfield-surf.jpg", "YouTube loading spinner on black, with the 'More videos' thumbnail (Deerfield surf, 2026-10-17 22:01Z)"],
    ["black-slate-12815.jpg", "YouTube's black slate as ffmpeg grabs it: 12,815 bytes, the size the courier tried to upload"],
    ["black-noise-20696.jpg", "a black frame with noise, 20 KB: it passed the old 20,000-byte floor"],
    ["black-underwater-night.jpg", "near-black frame stored by the browser grab for the underwater cam"],
    ["video-unavailable.jpg", "the player's 'Video unavailable' page"],
    ["black-noise-1080p-94956.jpg", "a flat dark grey at 1920x1080 with 95 KB of sensor noise: over the old fixed 60 KB line, under the 1080p line"],
    ["black-slate-1080p-29144.jpg", "YouTube's black slate at 1920x1080: 29,144 bytes, twice the 720p size and still under the 60 KB pixel-check line"],
  ];
  for (const [name, why] of blanks) {
    it(`rejects ${name} (${why})`, () => {
      const v = judgeFrame(fixture(name));
      expect(v.ok).toBe(false);
      expect(v.reason).toBe("blank");
      expect(v.checked).toBe(true);
      expect(v.stats!.p95).toBeLessThan(BLANK_P95_BELOW);
      expect(v.stats!.mean).toBeGreaterThanOrEqual(BLANK_MEAN_AT_LEAST);
      expect(v.message).toMatch(/blank frame/);
    });
  }
});

describe("judgeFrame: frames that ARE a real picture", () => {
  const goods: [string, string][] = [
    ["daylight-pensacola.jpg", "daylight beach"],
    ["daylight-fortmyers-q30.jpg", "daylight beach, another cam"],
    ["daylight-640-baseline.jpg", "daylight beach, 640x360"],
    ["underwater-flat.jpg", "flat green underwater frame, no detail"],
    ["night-pier-lights.jpg", "night, mostly dark, with pier lights"],
    ["dim-hazy.jpg", "dim grey frame before dawn"],
    ["night-underwater-dark.jpg", "real underwater frame before dawn: near black, City overlay text, 58 KB of sensor noise"],
    ["dim-feed-frame.jpg", "dim real frame from a still-image feed cam (mean 14.5)"],
    ["daylight-1080p-siesta.jpg", "daylight beach at 1920x1080 (the courier asks for 1080p since 2026-10-18)"],
  ];
  for (const [name, why] of goods) {
    it(`accepts ${name} (${why})`, () => {
      const v = judgeFrame(fixture(name), CHECK_ALL);
      expect(v.ok).toBe(true);
      expect(v.checked).toBe(true);
    });
  }

  it("a real night frame is darker than YouTube's grey: black passes, grey is blank", () => {
    // Real dark frames measured 0-14.5 on the mean; every YouTube non-picture frame measured 17.3-20.9.
    const darkReal = ["night-underwater-dark.jpg", "dim-feed-frame.jpg"].map((n) => judgeFrame(fixture(n), CHECK_ALL).stats!.mean);
    const blanks = ["spinner-pensacola.jpg", "spinner-deerfield-surf.jpg", "black-slate-12815.jpg", "black-slate-1080p-29144.jpg", "black-noise-20696.jpg", "video-unavailable.jpg", "black-underwater-night.jpg"].map(
      (n) => judgeFrame(fixture(n), CHECK_ALL).stats!.mean
    );
    expect(Math.max(...darkReal)).toBeLessThan(BLANK_MEAN_AT_LEAST);
    expect(Math.min(...blanks)).toBeGreaterThanOrEqual(BLANK_MEAN_AT_LEAST);
  });

  it("a bright frame with a dark corner is not blank (the middle decides, and brightness anywhere in it counts)", () => {
    expect(judgeFrame(fixture("night-pier-lights.jpg"), CHECK_ALL).stats!.p95).toBeGreaterThanOrEqual(BLANK_P95_BELOW);
  });
});

describe("judgeFrame: size and format", () => {
  it("the size floor is a stub guard, not a darkness guard: a 12,815-byte frame passes it and is refused for what it shows", () => {
    // The old floor was 20,000 bytes. YouTube's black slate is 12,815 bytes, so
    // that floor refused the slate by accident and a 20 KB black frame by luck of
    // being bigger. Now only what the picture shows decides.
    expect(MIN_FRAME_BYTES).toBeLessThan(12_815);
    const v = judgeFrame(fixture("black-slate-12815.jpg"));
    expect(v.reason).toBe("blank");
    expect(v.checked).toBe(true);
  });

  it("rejects bytes that are not a JPEG", () => {
    const v = judgeFrame(new Uint8Array(30_000).fill(7));
    expect([v.ok, v.reason, v.checked]).toEqual([false, "not-jpeg", false]);
  });

  it("rejects a stub: a JPEG header with almost nothing after it", () => {
    const stub = new Uint8Array(MIN_FRAME_BYTES - 1);
    stub[0] = 0xff;
    stub[1] = 0xd8;
    expect(judgeFrame(stub).reason).toBe("too-small");
  });

  it("rejects a body over the size limit", () => {
    const big = new Uint8Array(MAX_FRAME_BYTES + 1);
    big[0] = 0xff;
    big[1] = 0xd8;
    expect(judgeFrame(big).reason).toBe("too-large");
  });

  it("skips the pixel check for a frame with full detail (to save CPU) and says so", () => {
    expect(RICH_FRAME_BYTES).not.toBeNull();
    const v = judgeFrame(fixture("daylight-fortmyers-q30.jpg"));
    expect(v.ok).toBe(true);
    expect(v.checked).toBe(false);
  });

  it("the skip line grows with the picture: 60 KB at 720p, about 135 KB at 1080p, never under 60 KB", () => {
    expect(richThresholdBytes({ width: 1280, height: 720 })).toBe(60_000);
    expect(richThresholdBytes({ width: 1920, height: 1080 })).toBe(134_784);
    expect(richThresholdBytes({ width: 640, height: 360 })).toBe(60_000);
    expect(richThresholdBytes(null)).toBe(60_000);
  });

  it("a noisy black 1080p frame over 60 KB is pixel-checked by default and refused as blank", () => {
    const v = judgeFrame(fixture("black-noise-1080p-94956.jpg"));
    expect(fixture("black-noise-1080p-94956.jpg").length).toBeGreaterThan(RICH_FRAME_BYTES!);
    expect(v).toMatchObject({ ok: false, reason: "blank", checked: true });
  });

  it("a real 1080p daylight frame over the 1080p line skips the pixel check, and passes", () => {
    const f = fixture("daylight-1080p-siesta.jpg");
    expect(f.length).toBeGreaterThan(richThresholdBytes({ width: 1920, height: 1080 })!);
    expect(judgeFrame(f)).toMatchObject({ ok: true, checked: false });
  });

  it("no blank frame measured so far is large enough to be waved through by the rich-frame shortcut", () => {
    for (const n of ["spinner-pensacola.jpg", "spinner-deerfield-surf.jpg", "black-slate-12815.jpg", "black-noise-20696.jpg", "video-unavailable.jpg", "black-underwater-night.jpg", "black-slate-1080p-29144.jpg", "black-noise-1080p-94956.jpg"]) {
      expect(fixture(n).length).toBeLessThan(richThresholdBytes(readJpegDimensions(fixture(n)))!);
    }
  });

  it("fails open: a progressive JPEG cannot be pixel-checked and is accepted", () => {
    const v = judgeFrame(fixture("daylight-640-progressive.jpg"), CHECK_ALL);
    expect([v.ok, v.checked]).toEqual([true, false]);
  });

  it("fails open: a JPEG cut short is accepted as unchecked, not called blank", () => {
    const whole = fixture("daylight-pensacola.jpg");
    const v = judgeFrame(whole.subarray(0, 30_000), CHECK_ALL);
    expect([v.ok, v.checked]).toEqual([true, false]);
  });
});
