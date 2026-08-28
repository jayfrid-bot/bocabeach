import type { CamConfig, CamView, Location } from "@/lib/types";
import { pickFeedTimestamp } from "@/lib/camSnapshots";
import { fetchSpotWeather } from "@/lib/sources/spotWeather";
import { fetchWithTimeout } from "@/lib/util";

// --- Resolving a feed cam's capture time -----------------------------------
//
// The provider (video-monitoring.com) drops requests in short bursts. A single
// miss used to cost the cam card its capture time — the card then said "capture
// time unknown", and the freshness logic had nothing to verify the frame
// against. One retry after a brief pause recovers nearly all of those.
//
// This runs inside the conditions snapshot assembly, so both attempts plus the
// pause have to fit in one modest budget: 3.5s + 0.8s + 3.5s = 7.8s worst case.

/** Timeout for a single latest.json attempt. */
const ATTEMPT_TIMEOUT_MS = 3500;
/** Pause before the one retry — long enough to miss a burst, short enough to pay for. */
const RETRY_DELAY_MS = 800;
/** Hard ceiling across both attempts, so a slow provider can't blow the request. */
const TOTAL_BUDGET_MS = 8000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One feed's latest.json, fetched with a single retry. Returns the parsed JSON,
 * or undefined when both attempts fail — the caller then reports an honest
 * unknown capture time rather than inventing one.
 */
async function fetchFeedLatest(base: string): Promise<unknown | undefined> {
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      // Don't start a retry we have no budget to finish.
      if (Date.now() + RETRY_DELAY_MS >= deadline) break;
      await sleep(RETRY_DELAY_MS);
    }
    const timeoutMs = Math.min(ATTEMPT_TIMEOUT_MS, deadline - Date.now());
    if (timeoutMs <= 0) break;
    try {
      const res = await fetchWithTimeout(`${base}/latest.json`, {
        timeoutMs,
        next: { revalidate: 60 },
      });
      if (res.ok) return await res.json();
    } catch {
      // Timed out or refused — fall through to the retry (or give up after it).
    }
  }
  return undefined;
}

/**
 * Build the cam list for a location, attaching the live weather/wind at each
 * cam's own coordinates (falling back to the town's lat/lon). Fetches run in
 * parallel; cams sharing a rounded coordinate (or a latest.json feed) reuse the
 * same request.
 */
export async function buildCamViews(loc: Location): Promise<CamView[]> {
  // Cams that share a latest.json share ONE fetch AND its retry: every view
  // lives inside that same document, so a second request would only repeat it
  // (and would double the retry cost of a provider outage).
  const feeds = new Map<string, Promise<unknown | undefined>>();
  const latestFor = (base: string): Promise<unknown | undefined> => {
    let pending = feeds.get(base);
    if (!pending) {
      pending = fetchFeedLatest(base);
      feeds.set(base, pending);
    }
    return pending;
  };

  /** Exact capture time of a feed cam's current frame, or undefined. */
  const feedCapturedAt = async (cam: CamConfig): Promise<string | undefined> => {
    const feed = cam.snapshotFeed;
    if (!feed) return undefined;
    const json = await latestFor(feed.base);
    return json === undefined ? undefined : pickFeedTimestamp(json, feed.view);
  };

  return Promise.all(
    loc.cams.map(async (cam): Promise<CamView> => {
      const [weather, capturedAt] = await Promise.all([
        fetchSpotWeather(cam.lat ?? loc.lat, cam.lon ?? loc.lon),
        feedCapturedAt(cam),
      ]);
      return {
        id: cam.id,
        name: cam.name,
        provider: cam.provider,
        embedType: cam.embedType,
        url: cam.url,
        // Proxy the live still same-origin (https) when this cam has one
        // (a fixed snapshot URL or a resolved latest.json feed).
        imageUrl:
          cam.id && (cam.snapshotUrl || cam.snapshotFeed)
            ? `/api/cam/${cam.id}`
            : undefined,
        capturedAt,
        attribution: cam.attribution,
        weather,
      };
    }),
  );
}
