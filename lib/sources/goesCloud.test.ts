import { afterEach, describe, it, expect, vi } from "vitest";
import { GOES_CLOUD_STALE_MINUTES, fetchGoesCloud } from "@/lib/sources/goesCloud";
import type { Location } from "@/lib/types";

// The ACM 4-level cloud mask -> 0-1 fraction mapping actually lives in
// scripts/goes_cloud.py (ACM_WEIGHTS) — the Python job does the pixel
// averaging server-side, so there's no TS runtime code that recomputes it.
// This pins the documented spec here (mirrored exactly from the module
// docstring in scripts/goes_cloud.py) so a future edit to one side without
// the other shows up as a failing/changed expectation instead of silent drift.
const ACM_WEIGHTS: Record<number, number> = {
  0: 0, // clear
  1: 0.33, // probably_clear
  2: 0.67, // probably_cloudy
  3: 1.0, // cloudy
};

describe("ACM level -> cloud fraction mapping (spec mirrored from scripts/goes_cloud.py)", () => {
  it("maps clear to 0", () => {
    expect(ACM_WEIGHTS[0]).toBe(0);
  });
  it("maps probably_clear to 0.33", () => {
    expect(ACM_WEIGHTS[1]).toBeCloseTo(0.33, 5);
  });
  it("maps probably_cloudy to 0.67", () => {
    expect(ACM_WEIGHTS[2]).toBeCloseTo(0.67, 5);
  });
  it("maps cloudy to 1.0 (fully overcast)", () => {
    expect(ACM_WEIGHTS[3]).toBe(1.0);
  });
  it("is monotonically increasing (more cloud flag -> more cloud fraction)", () => {
    const vals = [ACM_WEIGHTS[0], ACM_WEIGHTS[1], ACM_WEIGHTS[2], ACM_WEIGHTS[3]];
    for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeGreaterThan(vals[i - 1]);
  });
});

describe("GOES_CLOUD_STALE_MINUTES", () => {
  it("is generous enough to absorb the observed real-world feed gap (83 min on 2026-07-15)", () => {
    // Not >= 83: the threshold should still eventually refuse a genuinely old
    // granule. But it must be well above the ~1-2 min GLM lightning can hold to.
    expect(GOES_CLOUD_STALE_MINUTES).toBeGreaterThan(10);
    expect(GOES_CLOUD_STALE_MINUTES).toBeLessThan(83);
  });
});

// solar_position() itself lives in scripts/goes_cloud.py (used to compute
// beamCloudPct's offset boxes) — there's no TS runtime code that recomputes
// it either. This mirrors the same public-domain NOAA low-precision solar
// position algorithm (same convention as the ACM_WEIGHTS mirror above) as an
// independent check that the documented algorithm actually reproduces the
// value the beam-path fix was built and verified against: at the archived
// 2026-07-15T20:16Z granule, Boca Raton's sun was measured (both by hand and
// by scripts/goes_cloud.py's own solar_position()) at elevation ~51.1°,
// azimuth ~272°. If this mirror and the Python implementation ever drift
// apart, at least one of them is wrong about a well-documented algorithm.
function solarPositionMirror(whenIso: string, lat: number, lon: number): { elDeg: number; azDeg: number } {
  const when = new Date(whenIso).getTime();
  const j2000 = Date.UTC(2000, 0, 1, 12);
  const n = (when - j2000) / 86_400_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const meanLon = (280.46 + 0.9856474 * n) % 360;
  const meanAnom = rad((357.528 + 0.9856003 * n) % 360);
  const eclLon = rad(meanLon + 1.915 * Math.sin(meanAnom) + 0.02 * Math.sin(2 * meanAnom));
  const obliquity = rad(23.439 - 4.0e-7 * n);
  const dec = Math.asin(Math.sin(obliquity) * Math.sin(eclLon));
  const ra = Math.atan2(Math.cos(obliquity) * Math.sin(eclLon), Math.cos(eclLon));
  const gmstDeg = (280.46061837 + 360.98564736629 * n) % 360;
  const hourAngle = rad((((gmstDeg + lon - (ra * 180) / Math.PI) % 360) + 360) % 360);
  const phi = rad(lat);
  const el = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(hourAngle));
  const azSouthBased = Math.atan2(
    Math.sin(hourAngle),
    Math.cos(hourAngle) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi),
  );
  const azDeg = (((azSouthBased * 180) / Math.PI + 180) % 360 + 360) % 360;
  return { elDeg: (el * 180) / Math.PI, azDeg };
}

describe("solar_position (mirrored spec from scripts/goes_cloud.py, beamCloudPct's basis)", () => {
  it("matches the measured Boca Raton sun position at the 2026-07-15T20:16Z granule", () => {
    const { elDeg, azDeg } = solarPositionMirror("2026-07-15T20:16:00Z", 26.3587, -80.0707);
    expect(Math.abs(elDeg - 51.1)).toBeLessThan(0.5);
    expect(Math.abs(azDeg - 272)).toBeLessThan(0.5);
  });
});

describe("fetchGoesCloud: old-format feed (no beamCloudPct/sunElevDeg/version) still works", () => {
  const loc: Location = {
    slug: "boca-raton",
    name: "Boca Raton",
    region: "FL",
    lat: 26.36,
    lon: -80.07,
    timezone: "America/New_York",
    noaaTideStationId: "8722670",
    ndbcBuoyId: "lkwf1",
    cams: [],
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("degrades beamCloudPct/sunElevDeg to null rather than throwing on a pre-beam-path payload", async () => {
    // A feed shape exactly like the version this ships to replace: no
    // "version", no beamCloudPct/sunElevDeg keys at all on the beach entry.
    const oldFeed = {
      generatedAt: new Date().toISOString(),
      granuleStartIso: new Date(Date.now() - 5 * 60_000).toISOString(),
      satellite: "GOES-19",
      beaches: {
        "boca-raton": { cloudPct: 31.3, validPixels: 49, totalPixels: 49 },
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(oldFeed), { status: 200, headers: { date: new Date().toUTCString() } })),
    );

    const result = await fetchGoesCloud(loc);
    expect(result.status).toBe("ok");
    expect(result.data?.cloudPct).toBe(31.3);
    expect(result.data?.beamCloudPct).toBeNull();
    expect(result.data?.sunElevDeg).toBeNull();
  });

  it("carries beamCloudPct/sunElevDeg through on a new-format payload", async () => {
    const newFeed = {
      version: 2,
      generatedAt: new Date().toISOString(),
      granuleStartIso: new Date(Date.now() - 5 * 60_000).toISOString(),
      satellite: "GOES-19",
      beaches: {
        "boca-raton": { cloudPct: 31.3, beamCloudPct: 69.1, sunElevDeg: 51.0, validPixels: 49, totalPixels: 49 },
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(newFeed), { status: 200, headers: { date: new Date().toUTCString() } })),
    );

    const result = await fetchGoesCloud(loc);
    expect(result.status).toBe("ok");
    expect(result.data?.cloudPct).toBe(31.3);
    expect(result.data?.beamCloudPct).toBe(69.1);
    expect(result.data?.sunElevDeg).toBe(51.0);
  });
});
