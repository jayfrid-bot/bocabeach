import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { LOCATIONS } from "@/config/locations";
import visionCams from "@/config/vision-cams.json";
import { archiveCams, buildArchiveManifestJson, lookupCam } from "@/lib/camFrames/manifest";

/** The eleven cams the owner chose to archive (2026-10-11), by id. */
const EXPECTED_IDS = [
  "boca-inlet",
  "boca-inlet-jetty",
  "boca-inlet-north",
  "boca-inlet-surf",
  "boca-south",
  "boca-south-surf",
  "deerfield-beach-cam",
  "deerfield-pier-cam",
  "deerfield-spinner-uw",
  "deerfield-surf-cam",
  "ftl-elbo-beach-cam",
];

describe("archive manifest", () => {
  it("is exactly the 11 configured cams", () => {
    const ids = archiveCams().map((c) => c.camId).sort();
    expect(ids).toEqual(EXPECTED_IDS);
    expect(ids).toHaveLength(11);
  });

  it("covers every cam in locations.ts that has a proxied still", () => {
    const fromConfig = LOCATIONS.flatMap((l) =>
      (l.cams ?? []).filter((c) => c.id && (c.snapshotFeed || c.snapshotUrl) && c.archive !== false).map((c) => `${l.slug}/${c.id}`),
    ).sort();
    const fromManifest = archiveCams().map((c) => `${c.slug}/${c.camId}`).sort();
    expect(fromManifest).toEqual(fromConfig);
  });

  it("includes the cams the vision reader never fetches", () => {
    const visionIds = new Set(
      Object.values(visionCams as Record<string, { cams: { id: string }[] }>).flatMap((e) => e.cams.map((c) => c.id)),
    );
    const archiveOnly = archiveCams().map((c) => c.camId).filter((id) => !visionIds.has(id)).sort();
    expect(archiveOnly).toEqual(["boca-inlet", "boca-inlet-jetty", "boca-inlet-north", "deerfield-spinner-uw"]);
  });

  it("carries the attribution, timezone and source kind each row will store", () => {
    const south = archiveCams().find((c) => c.camId === "boca-south");
    expect(south).toMatchObject({
      slug: "boca-raton",
      timezone: "America/New_York",
      sourceKind: "feed",
      attribution: "Live still courtesy Palm Beach County ERM / video-monitoring.com",
    });
    const elbo = archiveCams().find((c) => c.camId === "ftl-elbo-beach-cam");
    expect(elbo).toMatchObject({ slug: "fort-lauderdale", sourceKind: "direct" });
    expect(elbo?.attribution).toMatch(/Elbo Room/);
  });
});

describe("lookupCam", () => {
  it("finds an archived cam", () => {
    const r = lookupCam("boca-raton", "boca-south");
    expect(r.status).toBe("ok");
  });

  it("is unknown for a missing slug, a missing cam, or a cam under the wrong beach", () => {
    expect(lookupCam("nowhere", "boca-south").status).toBe("unknown");
    expect(lookupCam("boca-raton", "nope").status).toBe("unknown");
    expect(lookupCam("deerfield-beach", "boca-south").status).toBe("unknown");
    expect(lookupCam("", "").status).toBe("unknown");
  });

  it("does not match inherited object keys", () => {
    expect(lookupCam("__proto__", "constructor").status).toBe("unknown");
  });
});

describe("config/archive-cams.json (read by scripts/cam_seaweed.py)", () => {
  it("matches config/locations.ts exactly", () => {
    const onDisk = JSON.parse(readFileSync(path.join(process.cwd(), "config", "archive-cams.json"), "utf8"));
    expect(onDisk).toEqual(buildArchiveManifestJson());
  });

  it("lists the same 11 ids as the manifest, in the same order", () => {
    const onDisk = JSON.parse(readFileSync(path.join(process.cwd(), "config", "archive-cams.json"), "utf8"));
    expect(onDisk.cams.map((c: { id: string }) => c.id)).toEqual(archiveCams().map((c) => c.camId));
  });

  it("gives every cam a usable fetch source", () => {
    for (const c of buildArchiveManifestJson().cams) {
      if (c.source.kind === "feed") {
        expect(c.source.base).toMatch(/^https?:\/\//);
        expect(c.source.view).toMatch(/^s\d+$/);
      } else {
        expect(c.source.url).toMatch(/^https:\/\//);
      }
    }
  });
});
