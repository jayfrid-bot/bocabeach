import type {
  CamSeaweedReading,
  Location,
  SargassumByDay,
  SargassumByHour,
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
const LEVELS: SargassumRisk[] = ["none", "low", "moderate", "high"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface CamGroup {
  capturedAtLocal?: string;
  cams?: CamSeaweedReading[];
}
/** A rolling raw cam read; the `seaweed` field drives the seaweed charts. */
interface HistoryEntry {
  t?: string; // local capture time, ISO (date prefix -> by-day chart)
  hour?: number;
  seaweed?: string; // worst seaweed across the cams at this capture
}
export interface CamSeaweedFeed {
  morning?: CamGroup | null;
  latest?: CamGroup | null;
  /** Rolling raw cam reads, shared with busyness; we read the `seaweed` field. */
  history?: HistoryEntry[];
}

/** Average the rolling history into a typical seaweed level per local hour. */
function byHourFromHistory(history: HistoryEntry[]): SargassumByHour[] | undefined {
  const buckets = new Map<number, { rank: number; n: number }>();
  for (const e of history) {
    if (typeof e.hour !== "number" || typeof e.seaweed !== "string" || !(e.seaweed in RANK)) {
      continue;
    }
    const b = buckets.get(e.hour) ?? { rank: 0, n: 0 };
    b.rank += RANK[e.seaweed];
    b.n += 1;
    buckets.set(e.hour, b);
  }
  if (!buckets.size) return undefined;
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hour, b]) => ({ hour, level: LEVELS[Math.round(b.rank / b.n)], samples: b.n }));
}

/** Take each day's WORST seaweed from the rolling history. */
function byDayFromHistory(history: HistoryEntry[]): SargassumByDay[] | undefined {
  const byDate = new Map<string, { rank: number; level: SargassumRisk }>();
  for (const e of history) {
    if (typeof e.t !== "string" || typeof e.seaweed !== "string" || !(e.seaweed in RANK)) {
      continue;
    }
    const date = e.t.slice(0, 10);
    if (!DATE_RE.test(date)) continue;
    const rank = RANK[e.seaweed];
    const cur = byDate.get(date);
    if (!cur || rank > cur.rank) byDate.set(date, { rank, level: e.seaweed as SargassumRisk });
  }
  if (!byDate.size) return undefined;
  return [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, b]) => ({ date, level: b.level }));
}

/**
 * Roll the per-cam seaweed reads into one level (the worst cam), preferring the
 * early-morning, pre-tractor reading; falls back to the latest. Also surfaces the
 * by-hour and by-day history from the rolling cam reads. Pure + tested.
 */
export function summarizeSeaweed(feed: CamSeaweedFeed): SargassumData | null {
  const byHour = byHourFromHistory(feed?.history ?? []);
  const byDay = byDayFromHistory(feed?.history ?? []);
  const morning = feed?.morning ?? null;
  const group = morning ?? feed?.latest ?? null;
  const cams = (group?.cams ?? []).filter(
    (c): c is CamSeaweedReading =>
      !!c && typeof c.level === "string" && c.level in RANK,
  );
  if (!cams.length) {
    // No current reading, but still surface the historical charts if we have any.
    return byHour || byDay
      ? { level: "unknown", isMorning: false, cams: [], byHour, byDay }
      : null;
  }
  // Worst by category rank; tie-broken by the finer coverage % when present.
  const worst = cams.reduce((a, b) => {
    if (RANK[b.level] !== RANK[a.level]) return RANK[b.level] > RANK[a.level] ? b : a;
    return (b.coveragePct ?? -1) > (a.coveragePct ?? -1) ? b : a;
  });
  return {
    level: worst.level,
    coveragePct: worst.coveragePct,
    note: worst.note,
    isMorning: !!morning && group === morning,
    capturedAtLocal: group?.capturedAtLocal,
    cams,
    byHour,
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
