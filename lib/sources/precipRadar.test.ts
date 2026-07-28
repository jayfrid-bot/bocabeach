import { afterEach, describe, it, expect, vi } from "vitest";
import { PRECIP_RADAR_STALE_MINUTES, fetchPrecipRadar } from "@/lib/sources/precipRadar";
import type { Location } from "@/lib/types";

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

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

/** A feed shaped exactly like scripts/mrms_precip.py's output. Defaults mirror
 *  the REAL 2026-07-28T19:32Z run captured while building this (a shower over
 *  Boca: 2.8 mm/hr, 14.1% box coverage, motion 55.7 km/h toward 049). */
function feed(beach: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
  return {
    version: 1,
    generatedAt: minutesAgo(1),
    product: "CONUS/PrecipRate_00.00",
    frames: [minutesAgo(21), minutesAgo(11), minutesAgo(1)],
    beaches: {
      "boca-raton": {
        rainNowMmHr: 2.8,
        nearestRainKm: 0,
        nearestBearingDeg: null,
        coveragePct: 14.1,
        motion: { speedKmh: 55.7, dirDeg: 49, corr: 0.523, baselineMin: 20 },
        etaMinutes: 1,
        frameIso: minutesAgo(1),
        framesUsed: 3,
        ...beach,
      },
    },
    ...top,
  };
}

function stub(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(typeof body === "string" ? body : JSON.stringify(body), {
          status,
          headers: { date: new Date().toUTCString() },
        }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PRECIP_RADAR_STALE_MINUTES", () => {
  it("is much tighter than the satellite cloud gate — this feed makes a short-fuse claim", () => {
    // The whole value of an ETA is that it's current. Anything near GOES's
    // 45 min would let a "rain in ~20 min" line outlive its own window.
    expect(PRECIP_RADAR_STALE_MINUTES).toBeLessThan(45);
    // But loose enough to survive GitHub throttling a couple of 10-min crons.
    expect(PRECIP_RADAR_STALE_MINUTES).toBeGreaterThanOrEqual(20);
  });
});

describe("fetchPrecipRadar", () => {
  it("parses a real-shaped fresh feed", async () => {
    stub(feed());
    const r = await fetchPrecipRadar(loc);
    expect(r.status).toBe("ok");
    expect(r.data?.rainNowMmHr).toBe(2.8);
    expect(r.data?.coveragePct).toBe(14.1);
    expect(r.data?.motion?.speedKmh).toBe(55.7);
    expect(r.data?.motion?.dirDeg).toBe(49);
    expect(r.data?.etaMinutes).toBe(1);
    expect(r.data?.framesUsed).toBe(3);
    expect(r.data?.frameAgeMinutes).toBeLessThanOrEqual(2);
    expect(r.attribution).toBe("NOAA MRMS (radar observation)");
  });

  it("marks a feed stale on the FRAME's age, not the job's run time", async () => {
    // generatedAt is seconds old (the job just ran) but the radar frame it
    // published is ancient — that's still an old observation.
    stub(
      feed(
        { frameIso: minutesAgo(PRECIP_RADAR_STALE_MINUTES + 10) },
        { generatedAt: new Date().toISOString() },
      ),
    );
    const r = await fetchPrecipRadar(loc);
    expect(r.status).toBe("stale");
    // Data is still returned so the source list can show it.
    expect(r.data?.rainNowMmHr).toBe(2.8);
    expect(r.note).toMatch(/min old/);
  });

  it("keeps a frame right at the threshold fresh", async () => {
    stub(feed({ frameIso: minutesAgo(PRECIP_RADAR_STALE_MINUTES - 1) }));
    expect((await fetchPrecipRadar(loc)).status).toBe("ok");
  });

  it("returns null data (not an all-null reading) when the job published its fail-soft nulls", async () => {
    stub(
      feed(
        {
          rainNowMmHr: null,
          nearestRainKm: null,
          coveragePct: null,
          motion: null,
          etaMinutes: null,
          frameIso: null,
          framesUsed: 0,
          note: "no MRMS frames available",
        },
        { frames: [], note: "no MRMS frames available" },
      ),
    );
    const r = await fetchPrecipRadar(loc);
    expect(r.data).toBeNull();
    expect(r.status).toBe("stale");
    expect(r.note).toBe("no MRMS frames available");
  });

  it("distinguishes an observed dry beach (0 mm/hr) from an unknown one (null)", async () => {
    stub(feed({ rainNowMmHr: 0, coveragePct: 0, nearestRainKm: null }));
    const dry = await fetchPrecipRadar(loc);
    // 0 is a real observation — it must NOT normalize to null.
    expect(dry.data?.rainNowMmHr).toBe(0);
    expect(dry.data?.coveragePct).toBe(0);
    expect(dry.data?.nearestRainKm).toBeNull();
  });

  it("degrades quietly when the feed branch does not exist yet", async () => {
    stub("", 404);
    const r = await fetchPrecipRadar(loc);
    expect(r.status).toBe("best-effort");
    expect(r.data).toBeNull();
    expect(r.note).toMatch(/not published yet/);
  });

  it("reports best-effort when this beach isn't in the feed", async () => {
    stub({ version: 1, generatedAt: minutesAgo(1), beaches: { "some-other-beach": {} } });
    const r = await fetchPrecipRadar(loc);
    expect(r.status).toBe("best-effort");
    expect(r.data).toBeNull();
    expect(r.note).toMatch(/not in radar feed/);
  });

  it("errors (never throws) on a malformed payload", async () => {
    stub({ nope: true });
    const r = await fetchPrecipRadar(loc);
    expect(r.status).toBe("error");
    expect(r.data).toBeNull();
  });

  it("errors (never throws) when the fetch itself fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const r = await fetchPrecipRadar(loc);
    expect(r.status).toBe("error");
    expect(r.data).toBeNull();
  });

  it("drops a half-built motion vector rather than reporting half a direction", async () => {
    stub(feed({ motion: { speedKmh: 40 } }));
    expect((await fetchPrecipRadar(loc)).data?.motion).toBeNull();
  });

  it("normalizes non-finite / wrong-typed numbers to null, never to 0", async () => {
    stub(feed({ rainNowMmHr: "3.0", coveragePct: null, etaMinutes: undefined }));
    const r = await fetchPrecipRadar(loc);
    expect(r.data?.rainNowMmHr).toBeNull();
    expect(r.data?.coveragePct).toBeNull();
    expect(r.data?.etaMinutes).toBeNull();
  });
});
