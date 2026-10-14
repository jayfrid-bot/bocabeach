import { describe, it, expect } from "vitest";
import visionCams from "@/config/vision-cams.json";
import { LOCATIONS } from "@/config/locations";
import type { CamConfig } from "@/lib/types";

/**
 * config/vision-cams.json is the vision job's own registry of which cams to
 * read (scripts/cam_seaweed.py reads it directly with stdlib json — no TS
 * parsing at capture time). This test is the lockstep check: every cam id the
 * registry names must be a real cam on that beach in config/locations.ts, and
 * for a "feed" source its base/view must match the same cam's `snapshotFeed`
 * exactly (aside from http/https, which some entries mix). Catches a typo'd id
 * or a base/view that drifted from the LOCATIONS entry without either side
 * noticing.
 */

interface VisionCamSource {
  kind: "feed" | "direct" | "hls";
  base?: string;
  view?: string;
  url?: string;
  /** "direct" cams only: a /meta URL the vision job polls for freshness/dedupe
   *  (see scripts/cam_seaweed.py's direct_cam_decision). */
  meta?: string;
}
interface VisionCam {
  id: string;
  name: string;
  source: VisionCamSource;
  role: "crowd" | "shore";
  /** Optional short sentence about what this camera sees; scripts/cam_seaweed.py
   *  appends it to the vision prompt as "About this camera: ..." (Gemini and the
   *  OpenAI-compatible providers; Clef's fixed server-side questions ignore it). */
  visionHint?: string;
}
interface VisionLocationEntry {
  timezone: string;
  cams: VisionCam[];
}

const REGISTRY = visionCams as Record<string, VisionLocationEntry>;

/** Strip the scheme so http:// and https:// compare equal. */
function normalizeScheme(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

describe("config/vision-cams.json — registry stays in lockstep with LOCATIONS", () => {
  const slugs = Object.keys(REGISTRY);

  it("has at least one beach registered", () => {
    expect(slugs.length).toBeGreaterThan(0);
  });

  it("the Boca inlet surf cam carries the rock-shelf hint (2026-10-13 false seaweed alarms)", () => {
    const cam = REGISTRY["boca-raton"].cams.find((c) => c.id === "boca-inlet-surf");
    expect(cam?.visionHint).toMatch(/rock shelf/i);
    expect(cam?.visionHint).toMatch(/not seaweed/i);
  });

  for (const slug of slugs) {
    describe(`beach "${slug}"`, () => {
      const entry = REGISTRY[slug];
      const loc = LOCATIONS.find((l) => l.slug === slug);

      it("exists in config/locations.ts", () => {
        expect(loc, `LOCATIONS has no entry for slug "${slug}"`).toBeDefined();
      });

      if (!loc) return;

      const camsById = new Map<string, CamConfig>(
        loc.cams.map((c) => [c.id ?? "", c]),
      );

      for (const cam of entry.cams) {
        it(`cam "${cam.id}" exists in LOCATIONS["${slug}"].cams[]`, () => {
          expect(
            camsById.has(cam.id),
            `vision-cams.json references cam id "${cam.id}" for "${slug}", ` +
              `but LOCATIONS["${slug}"].cams has no cam with that id`,
          ).toBe(true);
        });

        if (cam.visionHint !== undefined) {
          it(`cam "${cam.id}" visionHint is a short plain sentence`, () => {
            expect(typeof cam.visionHint).toBe("string");
            const hint = cam.visionHint as string;
            expect(hint.trim().length).toBeGreaterThan(0);
            // It rides on every vision call, so keep it short.
            expect(hint.length).toBeLessThanOrEqual(500);
            // User-facing copy rule: never name the tech.
            expect(hint).not.toMatch(/\bAI\b/);
          });
        }

        if (cam.source.kind === "feed") {
          it(`cam "${cam.id}" feed base/view matches its LOCATIONS snapshotFeed`, () => {
            const locCam = camsById.get(cam.id);
            expect(locCam?.snapshotFeed, `"${cam.id}" has no snapshotFeed in LOCATIONS`).toBeDefined();
            expect(normalizeScheme(cam.source.base ?? "")).toBe(
              normalizeScheme(locCam!.snapshotFeed!.base),
            );
            expect(cam.source.view).toBe(locCam!.snapshotFeed!.view);
          });
        }

        if (cam.source.kind === "direct") {
          it(`cam "${cam.id}" direct source url matches its LOCATIONS snapshotUrl`, () => {
            const locCam = camsById.get(cam.id);
            expect(locCam?.snapshotUrl, `"${cam.id}" has no snapshotUrl in LOCATIONS`).toBeDefined();
            expect(normalizeScheme(cam.source.url ?? "")).toBe(
              normalizeScheme(locCam!.snapshotUrl!),
            );
          });
        }
      }
    });
  }
});
