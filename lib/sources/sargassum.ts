import type {
  CamSeaweedReading,
  Location,
  SargassumData,
  SargassumRisk,
  Wrapped,
} from "@/lib/types";
import { fetchWithTimeout, haversineMiles, nowIso, round } from "@/lib/util";

const ATTRIBUTION = "NOAA Sargassum Inundation Risk (SIR)";

/** Off-Netlify job publishes the parsed SIR coastline here. Override with SARGASSUM_FEED_URL. */
const FEED_URL =
  process.env.SARGASSUM_FEED_URL ??
  "https://raw.githubusercontent.com/jayfrid-bot/bocabeach/sargassum-data/sargassum.json";

/** Same off-Netlify job publishes the cam-vision seaweed reading here. */
const CAM_FEED_URL =
  process.env.CAM_SEAWEED_FEED_URL ??
  "https://raw.githubusercontent.com/jayfrid-bot/bocabeach/sargassum-data/cam_seaweed.json";

const RANK: Record<string, number> = { none: 0, low: 1, moderate: 2, high: 3 };

interface CamGroup {
  capturedAtLocal?: string;
  hour?: number;
  cams?: CamSeaweedReading[];
}
interface CamFeed {
  morning?: CamGroup | null;
  latest?: CamGroup | null;
}

/**
 * Read the cam-vision seaweed feed and roll it up (worst cam wins). Prefers the
 * early-morning (pre-tractor) reading — the City clears seaweed ~7-9 AM, so a
 * later photo understates the wash-up. Best-effort.
 */
async function fetchObserved(): Promise<SargassumData["observed"]> {
  try {
    const res = await fetchWithTimeout(CAM_FEED_URL, {
      timeoutMs: 6000,
      next: { revalidate: 3600 }, // 1h — cam-vision job runs a few times/day
    });
    if (!res.ok) return undefined;
    const feed = (await res.json()) as CamFeed;
    const group = feed?.morning ?? feed?.latest ?? undefined;
    const cams = (group?.cams ?? []).filter((c) => c && c.level in RANK);
    if (!cams.length) return undefined;
    const worst = cams.reduce((a, b) => (RANK[b.level] > RANK[a.level] ? b : a));
    return {
      level: worst.level,
      note: worst.note,
      cams,
      isMorning: !!feed?.morning && group === feed.morning,
      capturedAtLocal: group?.capturedAtLocal,
    };
  } catch {
    return undefined;
  }
}

const LEVELS: SargassumRisk[] = ["none", "low", "moderate", "high"];
/** Only trust a coastline segment within this distance of the beach. */
const MAX_MATCH_MI = 30;

export interface SargassumFeed {
  generatedAt: string;
  sourceDate?: string; // yyyymmdd
  /** [lat, lon, risk 0-3] per coastline segment. */
  segments: [number, number, number][];
}

/** "20260602" -> whole days since that UTC date, or undefined. */
function ageDays(yyyymmdd: string | undefined, nowMs: number): number | undefined {
  if (!yyyymmdd || !/^\d{8}$/.test(yyyymmdd)) return undefined;
  const t = Date.UTC(
    Number(yyyymmdd.slice(0, 4)),
    Number(yyyymmdd.slice(4, 6)) - 1,
    Number(yyyymmdd.slice(6, 8)),
  );
  return Math.max(0, Math.floor((nowMs - t) / 86_400_000));
}

/** Find the nearest scored coastline segment to a beach and map it to a risk. Pure + tested. */
export function summarizeSargassum(
  feed: SargassumFeed,
  lat: number,
  lon: number,
  nowMs: number,
): SargassumData {
  let nearest = Infinity;
  let nearestRisk = -1;
  for (const [slat, slon, risk] of feed.segments) {
    const mi = haversineMiles(lat, lon, slat, slon);
    if (mi < nearest) {
      nearest = mi;
      nearestRisk = risk;
    }
  }
  const known = nearestRisk >= 0 && nearestRisk <= 3 && nearest <= MAX_MATCH_MI;
  return {
    risk: known ? LEVELS[nearestRisk] : "unknown",
    riskLevel: known ? nearestRisk : -1,
    nearestMi: Number.isFinite(nearest) ? round(nearest, 1) : undefined,
    sourceDate: feed.sourceDate,
    dataAgeDays: ageDays(feed.sourceDate, nowMs),
  };
}

export async function fetchSargassum(
  loc: Location,
): Promise<Wrapped<SargassumData>> {
  const fetchedAt = nowIso();
  try {
    const res = await fetchWithTimeout(FEED_URL, {
      timeoutMs: 7000,
      next: { revalidate: 21600 }, // 6h — the SIR product is daily
    });
    if (res.status === 404) {
      return {
        source: ATTRIBUTION,
        status: "best-effort",
        fetchedAt,
        attribution: ATTRIBUTION,
        data: null,
        note: "sargassum feed not published yet",
      };
    }
    if (!res.ok) throw new Error(`sargassum feed -> ${res.status}`);
    const feed = (await res.json()) as SargassumFeed;
    if (!Array.isArray(feed?.segments)) throw new Error("malformed sargassum feed");

    const data = summarizeSargassum(feed, loc.lat, loc.lon, Date.now());
    data.observed = await fetchObserved(); // on-the-ground cam reading, if available
    // The SIR product updates daily; flag it if the feed has gone several days stale.
    const stale = (data.dataAgeDays ?? 0) > 3;
    return {
      source: ATTRIBUTION,
      status: data.riskLevel < 0 ? "best-effort" : stale ? "stale" : "ok",
      fetchedAt,
      attribution: ATTRIBUTION,
      data,
      note: stale ? "sargassum feed is several days old" : undefined,
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
