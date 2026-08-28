import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCamViews } from "@/lib/cams";
import type { Location } from "@/lib/types";

// video-monitoring.com drops requests in bursts, and a single miss used to cost
// the cam card its capture time ("capture time unknown"). These cover the one
// retry that recovers it, the shared-feed dedupe, and the honest give-up.

const FEED_BASE = "http://video-monitoring.com/beachcams/bocainlet";
const CAPTURED_UNIX = 1_787_000_000; // the latest.json `timestamp`, in seconds

const LOCATION: Location = {
  slug: "test-beach",
  name: "Test Beach",
  region: "Test County, FL",
  lat: 26.35,
  lon: -80.07,
  timezone: "America/New_York",
  noaaTideStationId: "8722670",
  ndbcBuoyId: "41114",
  cams: [
    {
      id: "cam-s4",
      name: "South",
      provider: "Test",
      embedType: "image",
      url: "https://example.test/south",
      snapshotFeed: { base: FEED_BASE, view: "s4" },
    },
    // Same latest.json, different view — must ride on ONE fetch + retry.
    {
      id: "cam-s5",
      name: "North",
      provider: "Test",
      embedType: "image",
      url: "https://example.test/north",
      snapshotFeed: { base: FEED_BASE, view: "s5" },
    },
  ],
};

function latestJson(): Response {
  return new Response(
    JSON.stringify({
      s4: { mr: "s4/frame.jpg", timestamp: CAPTURED_UNIX },
      s5: { mr: "s5/frame.jpg", timestamp: CAPTURED_UNIX + 30 },
    }),
    { status: 200, headers: { date: new Date().toUTCString() } },
  );
}

/** A fetch stub: latest.json is driven by `latest`, every other URL (the
 *  per-cam spot weather) gets a harmless empty payload. */
function stubFetch(latest: () => Promise<Response>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("latest.json")) {
        calls.push(url);
        return latest();
      }
      return new Response("{}", { status: 200, headers: { date: new Date().toUTCString() } });
    }),
  );
  return calls;
}

/** Drive `buildCamViews` past the retry backoff without waiting for real time. */
async function runWithTimers<T>(work: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(5000);
  return work;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("buildCamViews — resolving each cam's capture time", () => {
  it("retries once after a failed latest.json and recovers capturedAt", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const calls = stubFetch(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("ECONNRESET");
      return latestJson();
    });

    const cams = await runWithTimers(buildCamViews(LOCATION));

    expect(attempts).toBe(2); // one failure, one retry
    expect(calls).toHaveLength(2);
    expect(cams[0].capturedAt).toBe(new Date(CAPTURED_UNIX * 1000).toISOString());
    expect(cams[1].capturedAt).toBe(new Date((CAPTURED_UNIX + 30) * 1000).toISOString());
  });

  it("shares ONE fetch and one retry across cams on the same feed", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    stubFetch(async () => {
      attempts += 1;
      if (attempts === 1) return new Response("nope", { status: 503 });
      return latestJson();
    });

    const cams = await runWithTimers(buildCamViews(LOCATION));

    // Two cams, two views, but only the two attempts of a single resolution.
    expect(attempts).toBe(2);
    expect(cams).toHaveLength(2);
    expect(cams.every((c) => c.capturedAt)).toBe(true);
  });

  it("gives up honestly (capturedAt undefined) when both attempts fail", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    stubFetch(async () => {
      attempts += 1;
      throw new Error("ETIMEDOUT");
    });

    const cams = await runWithTimers(buildCamViews(LOCATION));

    expect(attempts).toBe(2); // exactly one retry — never a third try
    expect(cams[0].capturedAt).toBeUndefined();
    expect(cams[1].capturedAt).toBeUndefined();
    // The card still renders: the proxied still and the cam's identity survive.
    expect(cams[0].imageUrl).toBe("/api/cam/cam-s4");
  });
});
