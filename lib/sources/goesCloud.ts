import type { GoesCloudData, Location, Wrapped } from "@/lib/types";
import { fetchedAtOf, fetchWithTimeout, nowIso, oldestIso } from "@/lib/util";

const ATTRIBUTION = "NOAA GOES-19 ABI Clear Sky Mask (satellite-observed cloud)";

/**
 * Where the precomputed satellite cloud feed lives. The heavy netCDF/pixel
 * work runs OFF Netlify (a GitHub Action writes a small JSON to the
 * `cloud-data` branch, mirroring lightning-data); we just read that tiny file
 * here. Override with GOES_CLOUD_FEED_URL.
 */
const FEED_URL =
  process.env.GOES_CLOUD_FEED_URL ??
  "https://raw.githubusercontent.com/jayfrid-bot/bocabeach/cloud-data/goes_cloud.json";

/**
 * How stale the satellite GRANULE itself may be (its own scan start time —
 * NOT when the upstream job ran) before we stop trusting it as "right now".
 *
 * The ABI Clear Sky Mask feed genuinely gaps: on 2026-07-15 the newest
 * available granule was measured live at 83 minutes old. A tight threshold
 * (like the ~1-2 min the GLM lightning feed can hold to) would make this
 * source flicker to "stale" constantly and never actually help. 45 minutes
 * absorbs one normal gap in the ~5-min cadence while still refusing a read
 * that's old enough the sky has plausibly changed since (e.g. an anvil that
 * has since moved off the beach) — degrade honestly rather than pretend an
 * hour-old satellite snapshot is current truth.
 */
export const GOES_CLOUD_STALE_MINUTES = 45;

interface GoesCloudFeedBeach {
  cloudPct: number | null;
  validPixels: number;
  totalPixels: number;
}

interface GoesCloudFeed {
  generatedAt: string;
  granuleStartIso: string;
  satellite: string;
  beaches: Record<string, GoesCloudFeedBeach>;
}

export async function fetchGoesCloud(loc: Location): Promise<Wrapped<GoesCloudData>> {
  let fetchedAt = nowIso();
  try {
    const res = await fetchWithTimeout(FEED_URL, {
      timeoutMs: 7000,
      next: { revalidate: 60 }, // the upstream job refreshes on a ~15 min cadence
    });
    fetchedAt = fetchedAtOf(res);
    // The feed branch may not exist yet (first deploy) — degrade quietly.
    if (res.status === 404) {
      return {
        source: ATTRIBUTION,
        status: "best-effort",
        fetchedAt,
        attribution: ATTRIBUTION,
        data: null,
        note: "satellite cloud feed not published yet",
      };
    }
    if (!res.ok) throw new Error(`goes cloud feed -> ${res.status}`);
    const feed = (await res.json()) as GoesCloudFeed;
    if (!feed?.beaches || typeof feed.beaches !== "object") {
      throw new Error("malformed goes cloud feed");
    }

    // The GitHub CDN's Date header is serve-time, not generation-time — report
    // the older of the two so RelativeTime matches reality (same as lightning.ts).
    fetchedAt = oldestIso(feed.generatedAt, fetchedAtOf(res));

    const granuleAgeMinutes = feed.granuleStartIso
      ? Math.max(0, Math.round((Date.now() - Date.parse(feed.granuleStartIso)) / 60000))
      : Infinity;
    const stale = !Number.isFinite(granuleAgeMinutes) || granuleAgeMinutes > GOES_CLOUD_STALE_MINUTES;

    const b = feed.beaches[loc.slug];
    // No reading for this beach (out of the CONUS grid, or too few
    // good-quality pixels in its neighborhood this pass) — never fabricate.
    if (!b || b.cloudPct == null) {
      return {
        source: ATTRIBUTION,
        status: stale ? "stale" : "best-effort",
        fetchedAt,
        attribution: ATTRIBUTION,
        data: null,
        note: !b ? "beach not in satellite feed" : "insufficient valid satellite pixels for this beach",
      };
    }

    const data: GoesCloudData = {
      cloudPct: b.cloudPct,
      validPixels: b.validPixels,
      totalPixels: b.totalPixels,
      granuleAgeMinutes,
      granuleStartIso: feed.granuleStartIso,
    };
    return {
      source: ATTRIBUTION,
      status: stale ? "stale" : "ok",
      fetchedAt,
      attribution: ATTRIBUTION,
      data,
      // Data still returned even when stale — callers decide whether to use
      // it (deriveMetrics only trusts status "ok"), but it's still worth
      // surfacing in the UI/source list as a best-effort/stale reading.
      note: stale ? `satellite granule is ${granuleAgeMinutes} min old` : undefined,
    };
  } catch (e) {
    return {
      source: ATTRIBUTION,
      status: "error",
      fetchedAt,
      attribution: ATTRIBUTION,
      data: null,
      note: String(e),
    };
  }
}
