import type { CamConfig, CamView, Location } from "@/lib/types";
import { pickFeedTimestamp } from "@/lib/camSnapshots";
import { fetchSpotWeather } from "@/lib/sources/spotWeather";
import { fetchWithTimeout } from "@/lib/util";

/** Exact capture time of a feed cam's current frame (from its latest.json), or undefined. */
async function feedCapturedAt(cam: CamConfig): Promise<string | undefined> {
  const feed = cam.snapshotFeed;
  if (!feed) return undefined;
  try {
    const res = await fetchWithTimeout(`${feed.base}/latest.json`, {
      timeoutMs: 6000,
      next: { revalidate: 60 },
    });
    if (!res.ok) return undefined;
    return pickFeedTimestamp(await res.json(), feed.view);
  } catch {
    return undefined;
  }
}

/**
 * Build the cam list for a location, attaching the live weather/wind at each
 * cam's own coordinates (falling back to the town's lat/lon). Fetches run in
 * parallel; cams sharing a rounded coordinate (or a latest.json feed) reuse the
 * same cached request.
 */
export async function buildCamViews(loc: Location): Promise<CamView[]> {
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
