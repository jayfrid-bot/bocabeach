import type {
  CamSeaweedReading,
  Location,
  SargassumByDay,
  SargassumData,
  SargassumRisk,
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
interface SeaweedDayEntry {
  date?: string;
  level?: string;
  isMorning?: boolean;
}
export interface CamSeaweedFeed {
  morning?: CamGroup | null;
  latest?: CamGroup | null;
  /** One authoritative seaweed reading per local day (for the by-day chart). */
  seaweedHistory?: SeaweedDayEntry[];
}

/** Sanitize the rolling per-day history: drop junk, de-dupe by date, sort ascending. */
function byDayFromHistory(history: SeaweedDayEntry[]): SargassumByDay[] | undefined {
  const byDate = new Map<string, SargassumByDay>();
  for (const e of history) {
    if (!e || typeof e.date !== "string" || typeof e.level !== "string" || !(e.level in RANK)) {
      continue;
    }
    byDate.set(e.date, {
      date: e.date,
      level: e.level as SargassumRisk,
      isMorning: e.isMorning,
    });
  }
  if (!byDate.size) return undefined;
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Roll the per-cam seaweed reads into one level (the worst cam), preferring the
 * early-morning, pre-tractor reading; falls back to the latest. Also surfaces the
 * recent per-day history for the by-day chart. Pure + tested.
 */
export function summarizeSeaweed(feed: CamSeaweedFeed): SargassumData | null {
  const byDay = byDayFromHistory(feed?.seaweedHistory ?? []);
  const morning = feed?.morning ?? null;
  const group = morning ?? feed?.latest ?? null;
  const cams = (group?.cams ?? []).filter(
    (c): c is CamSeaweedReading =>
      !!c && typeof c.level === "string" && c.level in RANK,
  );
  if (!cams.length) {
    // No current reading, but still surface the historical chart if we have one.
    return byDay ? { level: "unknown", isMorning: false, cams: [], byDay } : null;
  }
  const worst = cams.reduce((a, b) => (RANK[b.level] > RANK[a.level] ? b : a));
  return {
    level: worst.level,
    note: worst.note,
    isMorning: !!morning && group === morning,
    capturedAtLocal: group?.capturedAtLocal,
    cams,
    byDay,
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
