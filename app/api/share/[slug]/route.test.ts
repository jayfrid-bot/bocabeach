// Handler-level tests for GET /api/share/[slug]. The conditions pipeline
// (lib/conditions.ts) does ~18 real network fetches, so it's stubbed here —
// this suite only exercises the route's own contract: format validation,
// the 404/400 paths, and that a real ConditionsResponse renders to a PNG for
// both formats.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConditionsResponse, ScoreResult, Wrapped } from "@/lib/types";

vi.mock("@/lib/conditions", () => ({
  getConditions: vi.fn(),
}));

import { GET } from "@/app/api/share/[slug]/route";
import { getConditions } from "@/lib/conditions";

function wrap<T>(data: T | null): Wrapped<T> {
  return { data, source: "test", status: data ? "ok" : "error", fetchedAt: "2026-09-14T00:00:00.000Z", attribution: "test" };
}

function score(overrides: Partial<ScoreResult> = {}): ScoreResult {
  return {
    score: 88,
    rawScore: 88,
    rating: "Good",
    subScores: [
      { key: "waterTemp", label: "Water temperature", score: 90, weight: 0.09, display: "82.4°F" },
      { key: "waves", label: "Sea state (swim calmness)", score: 80, weight: 0.14, display: "1.4 ft · gentle" },
      { key: "wind", label: "Wind (sea breeze)", score: 85, weight: 0.13, display: "10 mph SE" },
    ],
    caps: [],
    dataAvailable: true,
    ...overrides,
  };
}

// Built as a plain object (not contextually typed against ConditionsSnapshot)
// and cast at the end — fighting each Wrapped<T>'s exact T for a fixture that's
// mostly null buys nothing.
function fixture(): ConditionsResponse {
  const snapshot = {
    location: {
      slug: "boca-raton",
      name: "Boca Raton",
      region: "Palm Beach County, FL",
      lat: 26.35,
      lon: -80.07,
      timezone: "America/New_York",
    },
    generatedAt: "2026-09-14T20:00:00.000Z",
    tides: wrap(null),
    buoy: wrap(null),
    weather: wrap(null),
    marine: wrap(null),
    cityOfficial: wrap({ flags: ["yellow"] }),
    waterQuality: wrap(null),
    nowcast: wrap(null),
    nws: wrap(null),
    airQuality: wrap(null),
    metno: wrap(null),
    gfs: wrap(null),
    lightning: wrap(null),
    goesCloud: wrap(null),
    precipRadar: wrap(null),
    sargassum: wrap(null),
    busyness: wrap({ level: "moderate" }),
    clarity: wrap(null),
    traffic: wrap(null),
    forecast: wrap(null),
    sun: wrap(null),
    hourly: wrap(null),
  } as unknown as ConditionsResponse["snapshot"];
  return {
    snapshot,
    score: score(),
    hourlyScores: [],
    multiDayWindows: [],
    cams: [],
  };
}

function req(slug: string, qs = ""): [Request, { params: Promise<{ slug: string }> }] {
  return [
    new Request(`https://x/api/share/${slug}${qs}`),
    { params: Promise.resolve({ slug }) },
  ];
}

afterEach(() => {
  vi.mocked(getConditions).mockReset();
});

describe("GET /api/share/[slug]", () => {
  it("200s with a PNG for the default (story) format", async () => {
    vi.mocked(getConditions).mockResolvedValue(fixture());
    const res = await GET(...req("boca-raton"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.byteLength).toBeGreaterThan(0);
  });

  it("200s with a PNG for format=story", async () => {
    vi.mocked(getConditions).mockResolvedValue(fixture());
    const res = await GET(...req("boca-raton", "?format=story"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("200s with a PNG for format=square", async () => {
    vi.mocked(getConditions).mockResolvedValue(fixture());
    const res = await GET(...req("boca-raton", "?format=square"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  // 15 minutes, not the original 2: rendering a 1080x1920 PNG through satori
  // costs seconds of CPU, and the card only changes as fast as the conditions
  // do (commit 2d78363). `stale-while-revalidate` keeps the next viewer on the
  // cached card while a fresh one renders behind them.
  it("caches the rendered card at the edge for 15 minutes", async () => {
    vi.mocked(getConditions).mockResolvedValue(fixture());
    const res = await GET(...req("boca-raton"));
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=900, s-maxage=900, stale-while-revalidate=600",
    );
  });

  it("404s for an unknown slug", async () => {
    vi.mocked(getConditions).mockResolvedValue(null);
    const res = await GET(...req("not-a-real-beach"));
    expect(res.status).toBe(404);
  });

  it("400s for a bad format", async () => {
    vi.mocked(getConditions).mockResolvedValue(fixture());
    const res = await GET(...req("boca-raton", "?format=poster"));
    expect(res.status).toBe(400);
  });

  // Codex round 2: the edge-cache lookup moved BEFORE getConditions() so a
  // cache hit skips the conditions build entirely, not just the satori
  // render — this route is warmed proactively on every page view.
  describe("edge cache lookup runs before the conditions build", () => {
    const originalCaches = (globalThis as { caches?: unknown }).caches;
    afterEach(() => {
      (globalThis as { caches?: unknown }).caches = originalCaches;
    });

    it("a cache hit never calls getConditions", async () => {
      const cached = new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png" },
      });
      const match = vi.fn().mockResolvedValue(cached);
      const put = vi.fn();
      (globalThis as { caches?: unknown }).caches = { default: { match, put } };

      const res = await GET(...req("boca-raton"));

      expect(res).toBe(cached);
      expect(match).toHaveBeenCalledTimes(1);
      expect(getConditions).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
    });

    it("a cache miss still builds conditions and populates the cache", async () => {
      vi.mocked(getConditions).mockResolvedValue(fixture());
      const match = vi.fn().mockResolvedValue(undefined);
      const put = vi.fn().mockResolvedValue(undefined);
      (globalThis as { caches?: unknown }).caches = { default: { match, put } };

      const res = await GET(...req("boca-raton"));

      expect(res.status).toBe(200);
      expect(match).toHaveBeenCalledTimes(1);
      expect(getConditions).toHaveBeenCalledTimes(1);
      expect(put).toHaveBeenCalledTimes(1);
    });
  });
});
