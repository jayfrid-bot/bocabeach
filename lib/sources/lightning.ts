import type { LightningData, Location, Wrapped } from "@/lib/types";
import { fetchWithTimeout, haversineMiles, nowIso, round } from "@/lib/util";

const ATTRIBUTION = "NOAA GOES-19 GLM (lightning)";

/**
 * Where the precomputed GLM strike feed lives. The heavy netCDF processing runs
 * OFF Netlify (a GitHub Action writes a small JSON to the `lightning-data`
 * branch); we just read that tiny file here. Override with LIGHTNING_FEED_URL.
 */
const FEED_URL =
  process.env.LIGHTNING_FEED_URL ??
  "https://raw.githubusercontent.com/jayfrid-bot/bocabeach/lightning-data/lightning.json";

export interface LightningFeed {
  generatedAt: string;
  windowMinutes: number;
  bbox?: number[];
  count?: number;
  /** [epochSeconds, lat, lon] per strike, most-recent first. */
  strikes: [number, number, number][];
}

/**
 * Reduce the raw strike feed to per-beach nearest-strike distance, recency, and
 * radius-band counts. Pure (so it's unit-tested); `nowMs` is injected.
 */
export function summarizeStrikes(
  feed: LightningFeed,
  lat: number,
  lon: number,
  nowMs: number,
): LightningData {
  const nowSec = nowMs / 1000;
  const minAgo = (epoch: number) => Math.max(0, round((nowSec - epoch) / 60));

  let nearestMi = Infinity;
  let nearestEpoch = 0;
  let lastEpoch = 0;
  let lastMi = Infinity;
  let within10 = 0;
  let within25 = 0;
  let within50 = 0;

  for (const [epoch, slat, slon] of feed.strikes) {
    const mi = haversineMiles(lat, lon, slat, slon);
    if (mi < nearestMi) {
      nearestMi = mi;
      nearestEpoch = epoch;
    }
    if (epoch > lastEpoch) {
      lastEpoch = epoch;
      lastMi = mi;
    }
    if (mi <= 10) within10++;
    if (mi <= 25) within25++;
    if (mi <= 50) within50++;
  }

  const has = feed.strikes.length > 0;
  return {
    windowMinutes: feed.windowMinutes,
    nearestMi: has ? round(nearestMi, 1) : undefined,
    nearestMinutesAgo: has ? minAgo(nearestEpoch) : undefined,
    lastMinutesAgo: has ? minAgo(lastEpoch) : undefined,
    lastMi: has ? round(lastMi, 1) : undefined,
    within10mi: within10,
    within25mi: within25,
    within50mi: within50,
    totalInArea: feed.strikes.length,
    dataAgeMinutes: feed.generatedAt
      ? Math.max(0, round((nowMs - Date.parse(feed.generatedAt)) / 60000))
      : undefined,
  };
}

export async function fetchLightning(
  loc: Location,
): Promise<Wrapped<LightningData>> {
  const fetchedAt = nowIso();
  try {
    const res = await fetchWithTimeout(FEED_URL, {
      timeoutMs: 7000,
      next: { revalidate: 300 }, // 5m — the upstream job refreshes every ~10m
    });
    // The feed branch may not exist yet (first deploy) — degrade quietly.
    if (res.status === 404) {
      return {
        source: ATTRIBUTION,
        status: "best-effort",
        fetchedAt,
        attribution: ATTRIBUTION,
        data: null,
        note: "lightning feed not published yet",
      };
    }
    if (!res.ok) throw new Error(`lightning feed -> ${res.status}`);
    const feed = (await res.json()) as LightningFeed;
    if (!Array.isArray(feed?.strikes)) throw new Error("malformed lightning feed");

    const data = summarizeStrikes(feed, loc.lat, loc.lon, Date.now());
    // If the upstream snapshot is much older than its own window, flag it stale.
    const stale = (data.dataAgeMinutes ?? 0) > feed.windowMinutes + 30;
    return {
      source: ATTRIBUTION,
      status: stale ? "stale" : "ok",
      fetchedAt,
      attribution: ATTRIBUTION,
      data,
      note: stale ? "lightning feed is stale" : undefined,
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
