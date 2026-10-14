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
import { camReadAsOf, parseCapturedAtLocal, pickCamGroup, type CamGroupSource } from "@/lib/camGroup";

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
/** Seaweed readers' fallback chain (see lib/camGroup.ts). */
const SEAWEED_SOURCES: readonly CamGroupSource[] = ["latest", "lastSeaweed", "morning"];
/** The City's beach-cleaning tractor works ~7-9 AM; a `morning` capture is "pre-clean" before this hour. */
const MORNING_PRE_CLEAN_END_HOUR = 10;

/** Local hour (0-23) of a "YYYY-MM-DDTHH:mm±hh:mm" capture stamp; undefined when it
 *  is missing or malformed (callers then fail closed). */
function localHour(capturedAtLocal: string | undefined): number | undefined {
  return parseCapturedAtLocal(capturedAtLocal)?.hour;
}

/** One entry of the feed's top-level `pendingClaims` map (see scripts/cam_seaweed.py). */
interface PendingClaim {
  level?: string;
  /** When the reader scored the claim, UTC ISO. */
  claimedAt?: string;
  /** True once the claim was confirmed and published (a marker, not an open question). */
  confirmed?: boolean;
}

/**
 * Is any HELD moderate/high seaweed claim still unresolved? Read from the feed's
 * `pendingClaims`, so it does not depend on which capture group the card shows: a
 * held read publishes no seaweed, which can send the card to an earlier clean group
 * (or to "unknown") while the claim is still open. Confirmed markers are not open
 * questions. A held claim stays open until the end of the beach-local date it was
 * scored on, with no minute limit (a slow courier cam's next frame can come hours
 * later; the reader clears the claim as soon as a fresh read of that cam is below
 * moderate). Needs the beach's local date and timezone to judge the date; without
 * them (callers that cannot say what day it is) a claim scored in the last 24 hours
 * counts. Pure.
 */
export function hasOpenClaim(
  pending: Record<string, PendingClaim> | null | undefined,
  nowMs: number,
  nowLocalDate?: string,
  tz?: string,
): boolean {
  if (!pending || typeof pending !== "object") return false;
  for (const c of Object.values(pending)) {
    if (!c || c.confirmed === true) continue;
    const at = Date.parse(c.claimedAt ?? "");
    if (!Number.isFinite(at)) continue;
    if (nowLocalDate && tz) {
      try {
        if (new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(at)) !== nowLocalDate) continue;
      } catch {
        continue;
      }
    } else if (nowMs - at > 24 * 3_600_000 || nowMs - at < -5 * 60_000) {
      continue;
    }
    return true;
  }
  return false;
}

/** A cam reading that carries a published seaweed level (the reader nulls it at
 *  low sun and for a jump still being confirmed). */
function hasSeaweedLevel(c: unknown): c is CamSeaweedReading {
  const r = c as CamSeaweedReading | null | undefined;
  return !!r && typeof r.level === "string" && r.level in RANK;
}
export interface CamSeaweedFeed {
  /** When the off-Netlify job generated this snapshot (ISO) — the real freshness. */
  generatedAt?: string;
  morning?: CamGroup | null;
  latest?: CamGroup | null;
  /** Today's newest capture with a published seaweed level. `latest` can be a
   *  low-sun capture whose cams publish none; this keeps the last real reading
   *  through the evening (the reader drops it at the next local date). */
  lastSeaweed?: CamGroup | null;
  /** Held (and just-confirmed) moderate/high seaweed claims by cam id. */
  pendingClaims?: Record<string, PendingClaim> | null;
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

/**
 * "as of 5:30 PM" for a seaweed reading that should say when it was taken, in the
 * beach's own timezone: a fallback group (the dusk captures are too dark to grade,
 * so the card keeps the last real read into the evening, or the morning one), and
 * also ANY group captured more than 30 minutes before `nowMs`, which covers a
 * `latest` the producer retained because no cam had a new frame (the card header
 * may be hours later). Undefined for a recent live reading, or when the capture
 * time is unknown. Pure.
 */
export function seaweedAsOf(
  sg: Pick<SargassumData, "source" | "capturedAtLocal">,
  tz: string,
  nowMs?: number,
): string | undefined {
  return camReadAsOf(sg.capturedAtLocal, tz, sg.source !== undefined && sg.source !== "latest", nowMs);
}

/** The Seaweed tile's supporting line: where the read came from, the coverage, and
 *  (for a fallback read) when it was taken. Deterministic facts only. Pure. */
export function seaweedTileSub(sg: SargassumData, tz: string, nowMs?: number): string {
  return [
    `📷 ${sg.isMorning ? "AM cams (pre-clean)" : "cams"}` +
      (sg.coveragePct != null ? ` · ~${sg.coveragePct}% covered` : ""),
    seaweedAsOf(sg, tz, nowMs),
  ]
    .filter(Boolean)
    .join(" · ");
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
  // The newest group with a usable seaweed level: `latest`, else today's
  // `lastSeaweed`, else `morning` (see lib/camGroup.ts). A low-sun `latest`
  // publishes none, so the card keeps showing the last real read, labelled with
  // that read's own time (`source` tells the UI it is not the newest capture).
  // The producer idles overnight, so with the beach's local date known a group from
  // another date (yesterday's `latest` included) is not today's seaweed: the card
  // falls to the existing "unknown" state with the charts until the first dawn run.
  const picked = pickCamGroup(feed, SEAWEED_SOURCES, (g) => (g.cams ?? []).some(hasSeaweedLevel), {
    nowLocalDate,
    dateGateLatest: true,
  });
  const group = picked?.group ?? null;
  // A held claim is open independent of the group shown (see hasOpenClaim); the
  // shown capture's own unconfirmed cams count too.
  const pendingConfirmation =
    hasOpenClaim(feed?.pendingClaims, (nextRead?.now ?? new Date()).getTime(), nowLocalDate, nextRead?.timezone) ||
    (group?.cams ?? []).some((c) => c.unconfirmed === true) ||
    undefined;
  // Learned from the last two weeks of actual read times — every camera
  // reading (fresh or the "no current reading" case below) gets this line.
  const nextReadIso = nextRead?.timezone
    ? expectedNextCamRead(
        history.map((e) => e.t).filter((t): t is string => typeof t === "string"),
        nextRead?.now ?? new Date(),
        nextRead.timezone,
      )?.iso
    : undefined;
  const cams = (group?.cams ?? []).filter(hasSeaweedLevel);
  if (!cams.length) {
    // No current reading, but still surface the historical charts if we have any.
    // An open claim alone is enough to answer (a first-ever held observation has no
    // group with a level and no history yet): the alerts need to see "pending".
    return byHour || byDay || pendingConfirmation
      ? { level: "unknown", isMorning: false, cams: [], byHour, byDay, vsAvg, nextReadIso, pendingConfirmation }
      : null;
  }
  // Worst by category rank; tie-broken by the finer coverage % when present.
  const worst = cams.reduce((a, b) => {
    if (RANK[b.level] !== RANK[a.level]) return RANK[b.level] > RANK[a.level] ? b : a;
    return (b.coveragePct ?? -1) > (a.coveragePct ?? -1) ? b : a;
  });

  // Today's reads, in capture order, for point-in-time scoring of past hours.
  const today = nowLocalDate ?? group?.capturedAtLocal?.slice(0, 10);
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
    // "AM cams (pre-clean)" only means something before the City's cleaning
    // tractor, so a morning capture from 10 AM on (a courier beach's first usable
    // winter frame) is a plain fallback read, labelled with its time instead.
    isMorning: picked?.source === "morning" && (localHour(group?.capturedAtLocal) ?? 99) < MORNING_PRE_CLEAN_END_HOUR,
    source: picked?.source as SargassumData["source"],
    pendingConfirmation,
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
