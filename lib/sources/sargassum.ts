import type {
  CamSeaweedReading,
  Location,
  SargassumData,
  Wrapped,
} from "@/lib/types";
import { fetchWithTimeout, nowIso } from "@/lib/util";

const ATTRIBUTION = "Beach cams + Gemini vision";

/** The off-Netlify cam-vision job publishes per-cam seaweed reads here. */
const CAM_FEED_URL =
  process.env.CAM_SEAWEED_FEED_URL ??
  "https://raw.githubusercontent.com/jayfrid-bot/bocabeach/sargassum-data/cam_seaweed.json";

const RANK: Record<string, number> = { none: 0, low: 1, moderate: 2, high: 3 };

interface CamGroup {
  capturedAtLocal?: string;
  cams?: CamSeaweedReading[];
}
export interface CamSeaweedFeed {
  morning?: CamGroup | null;
  latest?: CamGroup | null;
}

/**
 * Roll the per-cam seaweed reads into one level (the worst cam), preferring the
 * early-morning, pre-tractor reading; falls back to the latest. Pure + tested.
 */
export function summarizeSeaweed(feed: CamSeaweedFeed): SargassumData | null {
  const morning = feed?.morning ?? null;
  const group = morning ?? feed?.latest ?? null;
  const cams = (group?.cams ?? []).filter(
    (c): c is CamSeaweedReading =>
      !!c && typeof c.level === "string" && c.level in RANK,
  );
  if (!cams.length) return null;
  const worst = cams.reduce((a, b) => (RANK[b.level] > RANK[a.level] ? b : a));
  return {
    level: worst.level,
    note: worst.note,
    isMorning: !!morning && group === morning,
    capturedAtLocal: group?.capturedAtLocal,
    cams,
  };
}

export async function fetchSargassum(
  _loc: Location,
): Promise<Wrapped<SargassumData>> {
  const fetchedAt = nowIso();
  try {
    const res = await fetchWithTimeout(CAM_FEED_URL, {
      timeoutMs: 7000,
      next: { revalidate: 3600 }, // 1h — the cam-vision job runs a few times/day
    });
    if (res.status === 404) {
      return {
        source: ATTRIBUTION,
        status: "best-effort",
        fetchedAt,
        attribution: ATTRIBUTION,
        data: null,
        note: "cam seaweed feed not published yet",
      };
    }
    if (!res.ok) throw new Error(`cam seaweed feed -> ${res.status}`);
    const data = summarizeSeaweed((await res.json()) as CamSeaweedFeed);
    return {
      source: ATTRIBUTION,
      status: data ? "ok" : "best-effort",
      fetchedAt,
      attribution: ATTRIBUTION,
      data,
      note: data ? undefined : "no seaweed reading available yet",
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
