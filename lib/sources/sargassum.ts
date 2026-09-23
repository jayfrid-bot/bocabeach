import type {
  CamSeaweedReading,
  Location,
  SargassumByDay,
  SargassumByHour,
  SargassumData,
  SargassumRisk,
  Wrapped,
} from "@/lib/types";
import { fetchedAtOf, fetchWithTimeout, nowIso, oldestIso } from "@/lib/util";
import { vsAverage, type VsAverageEntry } from "@/lib/vsAverage";
import { camFeedUrlCandidates } from "@/lib/sources/camFeed";
import { expectedNextCamRead } from "@/lib/camNextRead";
import { capCamHistory } from "@/lib/camHistory";

const ATTRIBUTION = "Beach cams + Gemini vision";

const RANK: Record<string, number> = { none: 0, low: 1, moderate: 2, high: 3 };
const LEVELS: SargassumRisk[] = ["none", "low", "moderate", "high"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Cap the serving-path by-day chart to the most recent N days. The raw feed
 *  stays unlimited; this only bounds what we hand the UI (matches the vs-average
 *  ~8-week lookback). */
const BY_DAY_CAP_DAYS = 56;

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
  /** When the off-Netlify job generated this snapshot (ISO) — the real freshness. */
  generatedAt?: string;
  morning?: CamGroup | null;
  latest?: CamGroup | null;
  /** Rolling raw cam reads, shared with busyness; we read the `seaweed` field. */
  history?: HistoryEntry[];
}

/** Average the rolling history into a typical seaweed level per local hour. */
function byHourFromHistory(history: HistoryEntry[]): SargassumByHour[] | undefined {
  const buckets = new Map<number, { rank: number; n: number }>();
  for (const e of history) {
    if (typeof e.hour !== "number") continue;
    const r = readRank(e); // continuous 0-3, coverage-aware (falls back to the category)
    if (r == null) continue;
    const b = buckets.get(e.hour) ?? { rank: 0, n: 0 };
    b.rank += r;
    b.n += 1;
    buckets.set(e.hour, b);
  }
  if (!buckets.size) return undefined;
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hour, b]) => {
      const avg = b.rank / b.n;
      return { hour, level: LEVELS[Math.round(avg)], avg: Math.round(avg * 100) / 100, samples: b.n };
    });
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
    .slice(-BY_DAY_CAP_DAYS) // most recent 56 days only (serving-path bound)
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
 * Roll the per-cam seaweed reads into one level: the worst cam of the MOST
 * RECENT capture. Seaweed is scored point-in-time — the beach gets credit for
 * a cleaning and the penalty when seaweed washes back in; no read outranks a
 * newer one. Today's reads are also surfaced in capture order so past hours
 * can score with the read that was in effect at that time. Pure + tested.
 */
/**
 * "≈20% more seaweed than average" — today's coverage vs a hour-matched rolling
 * baseline, all weekdays (seaweed doesn't follow a work-week rhythm). Returns
 * undefined when the caller didn't supply today's local date. See lib/vsAverage.ts.
 */
function seaweedVsAvg(
  history: readonly VsAverageEntry[],
  nowLocalDate?: string,
): SargassumData["vsAvg"] {
  if (!nowLocalDate) return undefined;
  const r = vsAverage(history, nowLocalDate, { matchWeekday: false, minBaselineDays: 10 }, "cov");
  return { deltaPct: r.deltaPct, deltaPts: r.deltaPts, baselineDays: r.baselineDays };
}

export interface SeaweedNextReadOptions {
  /** Instant to estimate the next cam read from. Defaults to real now — pass
   *  an explicit value in tests for determinism. */
  now?: Date;
  /** IANA timezone for the learned "next cam read" estimate (see
   *  lib/camNextRead.ts). Omit to leave the estimate off. */
  timezone?: string;
}

export function summarizeSeaweed(
  feed: CamSeaweedFeed,
  nowLocalDate?: string,
  nextRead?: SeaweedNextReadOptions,
): SargassumData | null {
  const history = capCamHistory(feed?.history);
  const byHour = byHourFromHistory(history);
  const byDay = byDayFromHistory(history);
  const vsAvg = seaweedVsAvg(history, nowLocalDate);
  const morning = feed?.morning ?? null;
  const group = feed?.latest ?? morning ?? null;
  // Learned from the last two weeks of actual read times — every camera
  // reading (fresh or the "no current reading" case below) gets this line.
  const nextReadIso = nextRead?.timezone
    ? expectedNextCamRead(
        history.map((e) => e.t).filter((t): t is string => typeof t === "string"),
        nextRead?.now ?? new Date(),
        nextRead.timezone,
      )?.iso
    : undefined;
  const cams = (group?.cams ?? []).filter(
    (c): c is CamSeaweedReading =>
      !!c && typeof c.level === "string" && c.level in RANK,
  );
  if (!cams.length) {
    // No current reading, but still surface the historical charts if we have any.
    return byHour || byDay
      ? { level: "unknown", isMorning: false, cams: [], byHour, byDay, vsAvg, nextReadIso }
      : null;
  }
  // Worst by category rank; tie-broken by the finer coverage % when present.
  const worst = cams.reduce((a, b) => {
    if (RANK[b.level] !== RANK[a.level]) return RANK[b.level] > RANK[a.level] ? b : a;
    return (b.coveragePct ?? -1) > (a.coveragePct ?? -1) ? b : a;
  });

  // Today's reads, in capture order, for point-in-time scoring of past hours.
  const today = group?.capturedAtLocal?.slice(0, 10);
  const todayReads = today
    ? history
        .filter(
          (e) =>
            e.t?.slice(0, 10) === today &&
            typeof e.hour === "number" &&
            typeof e.seaweed === "string" &&
            e.seaweed in RANK,
        )
        .map((e) => ({
          hour: e.hour as number,
          level: e.seaweed as SargassumRisk,
          coveragePct: typeof e.cov === "number" ? e.cov : undefined,
        }))
    : undefined;

  return {
    level: worst.level,
    coveragePct: worst.coveragePct,
    note: worst.note,
    isMorning: !!morning && group === morning,
    capturedAtLocal: group?.capturedAtLocal,
    cams,
    todayReads: todayReads?.length ? todayReads : undefined,
    byHour,
    byDay,
    vsAvg,
    nextReadIso,
  };
}

export async function fetchSargassum(
  loc: Location,
): Promise<Wrapped<SargassumData>> {
  // Seaweed is read from the cam-vision job, which only covers beaches with
  // configured cams (currently just Boca). For a cam-less beach there is no
  // seaweed source here — don't serve another beach's reading. Return no data
  // so the UI hides the card entirely (honest > a misleading global number).
  if (!loc.cams?.length) {
    return {
      source: ATTRIBUTION,
      status: "best-effort",
      fetchedAt: nowIso(),
      attribution: ATTRIBUTION,
      data: null,
      note: "no beach cams here — seaweed isn't tracked for this beach",
    };
  }
  let fetchedAt = nowIso();
  try {
    // Try the beach's own per-beach file first; boca-raton (the only beach
    // that had cams before the per-beach split) falls through to the legacy
    // single-file feed if its own file isn't published yet. Any other beach
    // with no registry entry just 404s here — see camFeedUrlCandidates.
    let res: Response | undefined;
    for (const url of camFeedUrlCandidates(loc.slug)) {
      res = await fetchWithTimeout(url, {
        timeoutMs: 7000,
        next: { revalidate: 600 }, // 10 min — the cam job now runs every 10 min during daylight
      });
      fetchedAt = fetchedAtOf(res);
      if (res.status !== 404) break;
    }
    if (!res || res.status === 404) {
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
    const feed = (await res.json()) as CamSeaweedFeed;
    // The GitHub CDN's Date header is serve-time, not when the job generated the
    // snapshot — report the older of the two so RelativeTime matches the card.
    fetchedAt = oldestIso(feed.generatedAt, fetchedAtOf(res));
    // Today's local calendar date at the beach — anchors the vs-average baseline
    // to "today" in the beach's own timezone (not the server's).
    const nowLocalDate = new Intl.DateTimeFormat("en-CA", { timeZone: loc.timezone }).format(
      new Date(),
    );
    const data = summarizeSeaweed(feed, nowLocalDate, { timezone: loc.timezone });
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
