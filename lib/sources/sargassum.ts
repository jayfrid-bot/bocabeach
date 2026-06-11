import type {
  CamSeaweedReading,
  Location,
  SargassumByDay,
  SargassumByHour,
  SargassumData,
  SargassumRisk,
  Wrapped,
} from "@/lib/types";
import { fetchedAtOf, fetchWithTimeout, nowIso } from "@/lib/util";

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
  cov?: number; // 0-100 seaweed coverage % (finer than the category, when present)
}

// Map a measured coverage % (0-100) to a continuous 0-3 seaweed rank, using the
// same band boundaries as the category scale (none<5, low<30, moderate<60, high).
function covToRank(cov: number): number {
  const c = Math.max(0, Math.min(100, cov));
  if (c < 5) return c / 5; // none -> low
  if (c < 30) return 1 + (c - 5) / 25; // low -> moderate
  if (c < 60) return 2 + (c - 30) / 30; // moderate -> high
  return 3;
}

/** One read's seaweed rank (0-3): the measured coverage when present, else category. */
function readRank(e: HistoryEntry): number | undefined {
  if (typeof e.cov === "number" && Number.isFinite(e.cov)) return covToRank(e.cov);
  if (typeof e.seaweed === "string" && e.seaweed in RANK) return RANK[e.seaweed];
  return undefined;
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

/**
 * Average each day's seaweed from the rolling history (not the single worst), so
 * busy-sampled days compare fairly and days actually differ instead of all
 * pinning to "high". Each read uses its measured coverage % when present, else
 * its category; the bar height is the day's AVERAGE level and the colour is that
 * average rounded to a band. Also tracks the worst single read for the tooltip.
 */
function byDayFromHistory(history: HistoryEntry[]): SargassumByDay[] | undefined {
  const byDate = new Map<string, { sum: number; n: number; worst: number }>();
  for (const e of history) {
    if (typeof e.t !== "string") continue;
    const r = readRank(e);
    if (r === undefined) continue;
    const date = e.t.slice(0, 10);
    if (!DATE_RE.test(date)) continue;
    const b = byDate.get(date) ?? { sum: 0, n: 0, worst: 0 };
    b.sum += r;
    b.n += 1;
    const cat = typeof e.seaweed === "string" && e.seaweed in RANK ? RANK[e.seaweed] : Math.round(r);
    b.worst = Math.max(b.worst, cat);
    byDate.set(date, b);
  }
  if (!byDate.size) return undefined;
  return [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, b]) => {
      const avg = b.sum / b.n;
      return {
        date,
        avg: Math.round(avg * 100) / 100,
        level: LEVELS[Math.round(avg)],
        samples: b.n,
        worst: LEVELS[b.worst],
      };
    });
}

/**
 * Roll the per-cam seaweed reads into one level (the worst cam), preferring the
 * early-morning, pre-tractor reading; falls back to the latest. Also surfaces the
 * by-hour and by-day history from the rolling cam reads. Pure + tested.
 *
 * When no morning read exists (GitHub cron ticks get skipped), the level holds
 * the WORST read of the local day so far rather than just the latest frame —
 * otherwise one post-cleaning afternoon read erases a heavy-seaweed morning.
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

  // Day-worst fallback: with no authoritative morning read, scan today's
  // earlier history reads and keep the heaviest one when it outranks "latest".
  let level = worst.level;
  let coveragePct = worst.coveragePct;
  let note = worst.note;
  const today = group?.capturedAtLocal?.slice(0, 10);
  if (!morning && today) {
    const dayWorst = (feed?.history ?? [])
      .filter(
        (e) =>
          e.t?.slice(0, 10) === today &&
          typeof e.seaweed === "string" &&
          e.seaweed in RANK,
      )
      .reduce<HistoryEntry | null>((a, b) => {
        if (!a) return b;
        const ra = RANK[a.seaweed as string];
        const rb = RANK[b.seaweed as string];
        if (rb !== ra) return rb > ra ? b : a;
        return (b.cov ?? -1) > (a.cov ?? -1) ? b : a;
      }, null);
    if (
      dayWorst &&
      (RANK[dayWorst.seaweed as string] > RANK[level] ||
        (RANK[dayWorst.seaweed as string] === RANK[level] &&
          (dayWorst.cov ?? -1) > (coveragePct ?? -1)))
    ) {
      level = dayWorst.seaweed as SargassumRisk;
      coveragePct = dayWorst.cov;
      note = `worst read today (${String(dayWorst.hour ?? "?")}:00 capture)`;
    }
  }

  return {
    level,
    coveragePct,
    note,
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
  let fetchedAt = nowIso();
  try {
    const res = await fetchWithTimeout(CAM_FEED_URL, {
      timeoutMs: 7000,
      next: { revalidate: 3600 }, // 1h — the cam-vision job runs a few times/day
    });
    fetchedAt = fetchedAtOf(res);
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
