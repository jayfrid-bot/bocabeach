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
  cov?: number; // 0-100 seaweed coverage % (finer than the category, when present)
}

// Representative coverage % for each category, so reads that predate the numeric
// `cov` field still contribute a sensible amount (aligned with the vision prompt:
// none=clean, low=thin wrack line, moderate=clear bands, high=heavy mats).
const CAT_COVERAGE: Record<string, number> = { none: 0, low: 5, moderate: 30, high: 70 };

/** Best coverage % for one read: the measured `cov`, else its category proxy. */
function readCoverage(e: HistoryEntry): number | undefined {
  if (typeof e.cov === "number" && Number.isFinite(e.cov)) {
    return Math.max(0, Math.min(100, e.cov));
  }
  if (typeof e.seaweed === "string" && e.seaweed in CAT_COVERAGE) {
    return CAT_COVERAGE[e.seaweed];
  }
  return undefined;
}

/** Map an average coverage % back to a category band (for the bar colour). */
function bandFor(coverage: number): SargassumRisk {
  if (coverage >= 60) return "high";
  if (coverage >= 30) return "moderate";
  if (coverage >= 5) return "low";
  return "none";
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
 * Accumulate each day's seaweed from the rolling history: the bar height is the
 * CUMULATIVE coverage (sum of every read's %), so a day that was heavy all day
 * reads higher than one with a single spike — and days actually differ instead
 * of all pinning to "high". Colour comes from the day's average band.
 */
function byDayFromHistory(history: HistoryEntry[]): SargassumByDay[] | undefined {
  const byDate = new Map<string, { total: number; n: number; worstRank: number }>();
  for (const e of history) {
    if (typeof e.t !== "string") continue;
    const cov = readCoverage(e);
    if (cov === undefined) continue;
    const date = e.t.slice(0, 10);
    if (!DATE_RE.test(date)) continue;
    const b = byDate.get(date) ?? { total: 0, n: 0, worstRank: 0 };
    b.total += cov;
    b.n += 1;
    if (typeof e.seaweed === "string" && e.seaweed in RANK) {
      b.worstRank = Math.max(b.worstRank, RANK[e.seaweed]);
    }
    byDate.set(date, b);
  }
  if (!byDate.size) return undefined;
  return [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, b]) => ({
      date,
      total: Math.round(b.total),
      samples: b.n,
      level: bandFor(b.total / b.n), // average intensity -> colour
      worst: LEVELS[b.worstRank],
    }));
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
