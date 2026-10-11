// The webcam archive manifest (docs/CAM_ARCHIVE_PLAN.md R1/R6): which cams the
// archive keeps. It is DERIVED from config/locations.ts — every cam that has a
// proxied still (an `id` plus `snapshotFeed` or `snapshotUrl`) and whose new
// optional `archive` flag is not `false`. Nothing here is a second list to
// keep in step: add a cam to a location and it is archived; set
// `archive: false` and ingest refuses it at once.
//
// config/archive-cams.json is a generated copy for scripts/cam_seaweed.py,
// which reads plain JSON and cannot import TypeScript.
// `buildArchiveManifestJson()` makes it; lib/camFrames/manifest.test.ts fails
// when the file drifts from locations.ts. Regenerate with
//   npx vite-node -c vitest.config.ts scripts/gen_archive_cams.ts

import { listLocations } from "@/config/locations";
import type { CamConfig, Location } from "@/lib/types";

export type ArchiveSourceKind = "feed" | "direct";

export interface ArchiveCam {
  slug: string;
  camId: string;
  name: string;
  /** Credit line shown with every stored frame; copied into each row at ingest. */
  attribution: string | null;
  /** The beach's IANA timezone (local date and hour come from it). */
  timezone: string;
  /** "feed": a video-monitoring.com latest.json feed. "direct": a still URL (courier-fed cams). */
  sourceKind: ArchiveSourceKind;
}

export type CamLookup =
  | { status: "ok"; cam: ArchiveCam }
  | { status: "unknown" }
  | { status: "disabled" };

/** A cam id, if the cam has a proxied still we could archive. */
function sourceKindOf(cam: CamConfig): ArchiveSourceKind | null {
  if (!cam.id) return null;
  if (cam.snapshotFeed) return "feed";
  if (cam.snapshotUrl) return "direct";
  return null;
}

function toArchiveCam(loc: Location, cam: CamConfig, kind: ArchiveSourceKind): ArchiveCam {
  return {
    slug: loc.slug,
    camId: cam.id as string,
    name: cam.name,
    attribution: cam.attribution ?? null,
    timezone: loc.timezone,
    sourceKind: kind,
  };
}

/** Every cam the archive keeps, in config order. */
export function archiveCams(): ArchiveCam[] {
  const out: ArchiveCam[] = [];
  for (const loc of listLocations()) {
    for (const cam of loc.cams ?? []) {
      const kind = sourceKindOf(cam);
      if (!kind || cam.archive === false) continue;
      out.push(toArchiveCam(loc, cam, kind));
    }
  }
  return out;
}

/**
 * Look one cam up for ingest and delivery. "unknown" = no such slug or cam, or
 * a cam with no proxied still (404). "disabled" = the cam exists but is set to
 * `archive: false` (403).
 */
export function lookupCam(slug: string, camId: string): CamLookup {
  const loc = listLocations().find((l) => l.slug === slug);
  const cam = loc?.cams?.find((c) => c.id === camId);
  if (!loc || !cam) return { status: "unknown" };
  const kind = sourceKindOf(cam);
  if (!kind) return { status: "unknown" };
  if (cam.archive === false) return { status: "disabled" };
  return { status: "ok", cam: toArchiveCam(loc, cam, kind) };
}

// --- config/archive-cams.json ----------------------------------------------

export interface ArchiveManifestCamJson {
  slug: string;
  id: string;
  name: string;
  attribution: string | null;
  timezone: string;
  source:
    | { kind: "feed"; base: string; view: string }
    | { kind: "direct"; url: string; meta: string | null };
}

export interface ArchiveManifestJson {
  $comment: string;
  version: 1;
  cams: ArchiveManifestCamJson[];
}

const MANIFEST_COMMENT =
  "GENERATED from config/locations.ts by scripts/gen_archive_cams.ts - do not edit by hand. " +
  "scripts/cam_seaweed.py reads this to know which cams to archive; " +
  "lib/camFrames/manifest.test.ts fails if it drifts from locations.ts. " +
  "A cam with archive:false in locations.ts is left out.";

/** The exact contents of config/archive-cams.json. */
export function buildArchiveManifestJson(): ArchiveManifestJson {
  const cams: ArchiveManifestCamJson[] = [];
  for (const loc of listLocations()) {
    for (const cam of loc.cams ?? []) {
      const kind = sourceKindOf(cam);
      if (!kind || cam.archive === false) continue;
      const source: ArchiveManifestCamJson["source"] =
        kind === "feed" && cam.snapshotFeed
          ? { kind: "feed", base: cam.snapshotFeed.base, view: cam.snapshotFeed.view }
          : { kind: "direct", url: cam.snapshotUrl as string, meta: cam.snapshotMetaUrl ?? null };
      cams.push({
        slug: loc.slug,
        id: cam.id as string,
        name: cam.name,
        attribution: cam.attribution ?? null,
        timezone: loc.timezone,
        source,
      });
    }
  }
  return { $comment: MANIFEST_COMMENT, version: 1, cams };
}
