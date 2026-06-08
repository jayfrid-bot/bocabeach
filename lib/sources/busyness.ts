import type {
  BusynessByDay,
  BusynessByHour,
  BusynessData,
  BusynessLevel,
  Location,
  Wrapped,
} from "@/lib/types";
import { fetchWithTimeout, nowIso } from "@/lib/util";

const ATTRIBUTION = "Beach cams + Gemini vision";

/** Same off-Netlify cam-vision job publishes per-cam crowd reads here. */
const CAM_FEED_URL =
  process.env.CAM_SEAWEED_FEED_URL ??
  "https://raw.githubusercontent.com/jayfrid-bot/bocabeach/sargassum-data/cam_seaweed.json";

const RANK: Record<string, number> = {
  empty: 0,
  quiet: 1,
  moderate: 2,
  busy: 3,
  packed: 4,
};

interface CamReading {
  name: string;
  crowd?: string;
  people?: number;
  crowdNote?: string;
}
interface CamGroup {
  capturedAtLocal?: string;
  cams?: CamReading[];
}
interface HistoryEntry {
  t?: string; // local capture time, ISO (the date prefix drives the by-day chart)
  hour?: number;
  level?: string; // busiest crowd at this capture
  people?: number;
}
export interface CamFeed {
  latest?: CamGroup | null;
  morning?: CamGroup | null;
  history?: HistoryEntry[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const LEVELS: BusynessLevel[] = ["empty", "quiet", "moderate", "busy", "packed"];

/** Average the rolling history into a typical busyness per local hour. */
function byHourFromHistory(history: HistoryEntry[]): BusynessByHour[] | undefined {
  const buckets = new Map<number, { rank: number; people: number; pN: number; n: number }>();
  for (const e of history) {
    if (typeof e.hour !== "number" || typeof e.level !== "string" || !(e.level in RANK)) {
      continue;
    }
    const b = buckets.get(e.hour) ?? { rank: 0, people: 0, pN: 0, n: 0 };
    b.rank += RANK[e.level];
    b.n += 1;
    if (typeof e.people === "number") {
      b.people += e.people;
      b.pN += 1;
    }
    buckets.set(e.hour, b);
  }
  if (!buckets.size) return undefined;
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hour, b]) => ({
      hour,
      level: LEVELS[Math.round(b.rank / b.n)],
      people: b.pN ? Math.round(b.people / b.pN) : undefined,
      samples: b.n,
    }));
}

/** Take each day's PEAK (busiest) crowd from the rolling history. */
function byDayFromHistory(history: HistoryEntry[]): BusynessByDay[] | undefined {
  const byDate = new Map<string, { rank: number; level: BusynessLevel; people?: number }>();
  for (const e of history) {
    if (typeof e.t !== "string" || typeof e.level !== "string" || !(e.level in RANK)) {
      continue;
    }
    const date = e.t.slice(0, 10);
    if (!DATE_RE.test(date)) continue;
    const rank = RANK[e.level];
    const cur = byDate.get(date);
    if (!cur || rank > cur.rank) {
      byDate.set(date, {
        rank,
        level: e.level as BusynessLevel,
        people: typeof e.people === "number" ? e.people : undefined,
      });
    }
  }
  if (!byDate.size) return undefined;
  return [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, b]) => ({ date, level: b.level, people: b.people }));
}

/**
 * Roll up the per-cam crowd reads into one busyness level. Uses the LATEST
 * capture (busyness is time-of-day dependent, unlike seaweed) and takes the
 * busiest cam as the headline. Pure (unit-tested).
 */
export function summarizeBusyness(feed: CamFeed): BusynessData {
  const byHour = byHourFromHistory(feed?.history ?? []);
  const byDay = byDayFromHistory(feed?.history ?? []);
  const group = feed?.latest ?? feed?.morning ?? undefined;
  const cams = (group?.cams ?? []).filter(
    (c): c is CamReading & { crowd: BusynessLevel } =>
      !!c && typeof c.crowd === "string" && c.crowd in RANK,
  );
  if (!cams.length) {
    return { level: "unknown", capturedAtLocal: group?.capturedAtLocal, byHour, byDay };
  }
  const busiest = cams.reduce((a, b) => (RANK[b.crowd] > RANK[a.crowd] ? b : a));
  return {
    level: busiest.crowd,
    peopleEstimate: typeof busiest.people === "number" ? busiest.people : undefined,
    note: busiest.crowdNote,
    capturedAtLocal: group?.capturedAtLocal,
    cams: cams.map((c) => ({ name: c.name, crowd: c.crowd, people: c.people })),
    byHour,
    byDay,
  };
}

export async function fetchBusyness(
  _loc: Location,
): Promise<Wrapped<BusynessData>> {
  const fetchedAt = nowIso();
  try {
    const res = await fetchWithTimeout(CAM_FEED_URL, {
      timeoutMs: 6000,
      next: { revalidate: 3600 }, // 1h — the cam-vision job runs a few times/day
    });
    if (res.status === 404) {
      return {
        source: ATTRIBUTION,
        status: "best-effort",
        fetchedAt,
        attribution: ATTRIBUTION,
        data: null,
        note: "cam feed not published yet",
      };
    }
    if (!res.ok) throw new Error(`cam feed -> ${res.status}`);
    const data = summarizeBusyness((await res.json()) as CamFeed);
    return {
      source: ATTRIBUTION,
      status: data.level === "unknown" ? "best-effort" : "ok",
      fetchedAt,
      attribution: ATTRIBUTION,
      data,
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
