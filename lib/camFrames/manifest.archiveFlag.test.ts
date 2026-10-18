// `archive: false` removes a cam from the manifest and makes lookup refuse it.
// listLocations is mocked so one real cam is flipped without touching config.

import { describe, it, expect, vi } from "vitest";

vi.mock("@/config/locations", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/config/locations")>();
  const flipped = structuredClone(real.LOCATIONS);
  const cam = flipped.find((l) => l.slug === "boca-raton")?.cams?.find((c) => c.id === "boca-inlet-jetty");
  if (cam) cam.archive = false;
  return { ...real, LOCATIONS: flipped, listLocations: () => flipped };
});

import { archiveCams, buildArchiveManifestJson, lookupCam } from "@/lib/camFrames/manifest";

describe("archive: false", () => {
  it("drops the cam from the archive set and the generated JSON", () => {
    expect(archiveCams().map((c) => c.camId)).not.toContain("boca-inlet-jetty");
    expect(archiveCams()).toHaveLength(39);
    expect(buildArchiveManifestJson().cams.map((c) => c.id)).not.toContain("boca-inlet-jetty");
  });

  it("lookup says disabled (403), not unknown (404)", () => {
    expect(lookupCam("boca-raton", "boca-inlet-jetty").status).toBe("disabled");
    expect(lookupCam("boca-raton", "boca-south").status).toBe("ok");
  });
});
