import type {
  BusynessByDay,
  BusynessByHour,
  BusynessData,
  BusynessDaySummary,
  BusynessLevel,
  CamDayLabel,
  Location,
  Wrapped,
} from "@/lib/types";
import { clamp, fetchedAtOf, fetchWithTimeout, nowIso, oldestIso } from "@/lib/util";
import { fetchSun } from "@/lib/sources/sun";
import { vsAverage, weekdayName, type VsAverageEntry } from "@/lib/vsAverage";

const ATTRIBUTION = "Beach cams + Gemini vision";

/** How far past sunset / before sunrise the cams are still considered readable.
 *  Also the margin on the "next cam read" estimate — lib/sources/clarity.ts
 *  imports it so both cards quote the same moment. */
export const DAYLIGHT_BUFFER_MS = 30 * 60_000;
/** Beyond this age, even a daytime capture is too stale to call "current". */
const STALE_CAPTURE_MS = 3 * 60 * 60_000;

const NIGHT_NOTE =
  "cams can't read the beach in the dark — no live busyness reading overnight";
const STALE_NOTE =
  "latest cam capture is a few hours old — busyness reading paused until a fresher shot comes in";

export interface BusynessGateOptions {
  /** Instant to evaluate daylight/freshness against. Defaults to real now — pass
   * an explicit value in tests for determinism. */
  now?: Date;
  /** Today's sunrise/sunset instants (ISO). Omit to skip the daylight gate
   * (e.g. sun data unavailable) — the stale-capture check still applies. */
  sunriseIso?: string;
  sunsetIso?: string;
  /** Tomorrow's sunrise (ISO) — used for the "next cam read" line once today's
   * sunrise has already passed. Omit to skip that line. */
  tomorrowSunriseIso?: string;
}

/**
 * Why the current cam capture can't be trusted as a live busyness reading right
 * now, if any. Night (outside sunrise/sunset ± a buffer) always wins over a
 * stale-capture read, since a dark-frame read is nonsense regardless of age.
 */
function unreadableReason(
  capturedAtLocal: string | undefined,
  opts: BusynessGateOptions,
): string | undefined {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();

  if (opts.sunriseIso && opts.sunsetIso) {
    const sunriseMs = new Date(opts.sunriseIso).getTime();
    const sunsetMs = new Date(opts.sunsetIso).getTime();
    if (Number.isFinite(sunriseMs) && Number.isFinite(sunsetMs)) {
      if (nowMs < sunriseMs - DAYLIGHT_BUFFER_MS || nowMs > sunsetMs + DAYLIGHT_BUFFER_MS) {
        return NIGHT_NOTE;
      }
    }
  }

  if (capturedAtLocal) {
    const capturedMs = new Date(capturedAtLocal).getTime();
    if (Number.isFinite(capturedMs) && nowMs - capturedMs > STALE_CAPTURE_MS) {
      return STALE_NOTE;
    }
  }

  return undefined;
}

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
  crowdPct?: number;
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
  crowdPct?: number; // 0-100 fullness at the busiest cam
}
export interface CamFeed {
  /** When the off-Netlify job generated this snapshot (ISO) — the real freshness. */
  generatedAt?: string;
  latest?: CamGroup | null;
  morning?: CamGroup | null;
  history?: HistoryEntry[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Cap the serving-path by-day chart to the most recent N days. The raw feed
 *  stays unlimited; this only bounds what we hand the UI (matches the vs-average
 *  ~8-week lookback). */
const BY_DAY_CAP_DAYS = 56;

const LEVELS: BusynessLevel[] = ["empty", "quiet", "moderate", "busy", "packed"];

/** Average the rolling history into a typical busyness per local hour. */
function byHourFromHistory(history: HistoryEntry[]): BusynessByHour[] | undefined {
  const buckets = new Map<
    number,
    { rank: number; people: number; pN: number; pct: number; cN: number; n: number }
  >();
  for (const e of history) {
    if (typeof e.hour !== "number" || typeof e.level !== "string" || !(e.level in RANK)) {
      continue;
    }
    const b = buckets.get(e.hour) ?? { rank: 0, people: 0, pN: 0, pct: 0, cN: 0, n: 0 };
    b.rank += RANK[e.level];
    b.n += 1;
    if (typeof e.people === "number") {
      b.people += e.people;
      b.pN += 1;
    }
    if (typeof e.crowdPct === "number") {
      b.pct += e.crowdPct;
      b.cN += 1;
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
      crowdPct: b.cN ? Math.round(b.pct / b.cN) : undefined,
      // Granular height: fullness-aware when we have a crowd %, else the level rank.
      avg: Math.round((b.cN ? pctToRank(b.pct / b.cN) : b.rank / b.n) * 100) / 100,
      samples: b.n,
    }));
}

// Map a measured fullness % (0-100) to a continuous 0-4 crowd rank, using the
// crowd band boundaries (empty<10, quiet<30, moderate<55, busy<80, packed).
function pctToRank(pct: number): number {
  const c = Math.max(0, Math.min(100, pct));
  if (c < 10) return c / 10; // empty -> quiet
  if (c < 30) return 1 + (c - 10) / 20; // quiet -> moderate
  if (c < 55) return 2 + (c - 30) / 25; // moderate -> busy
  if (c < 80) return 3 + (c - 55) / 25; // busy -> packed
  return 4;
}

/**
 * A fullness % straight to its crowd BAND — the same boundaries the vision
 * model grades against (empty<10, quiet<30, moderate<55, busy<80, packed), so a
 * 75%-full read is called "busy" exactly as the cam read called it. Distinct
 * from rounding pctToRank, which blurs across a boundary (75% → "packed").
 */
function pctToLevel(pct: number): BusynessLevel {
  const c = clamp(pct, 0, 100);
  if (c < 10) return "empty";
  if (c < 30) return "quiet";
  if (c < 55) return "moderate";
  if (c < 80) return "busy";
  return "packed";
}

/** One read's crowd rank (0-4): the measured fullness when present, else category. */
function readRank(e: HistoryEntry): number | undefined {
  if (typeof e.crowdPct === "number" && Number.isFinite(e.crowdPct)) return pctToRank(e.crowdPct);
  if (typeof e.level === "string" && e.level in RANK) return RANK[e.level];
  return undefined;
}

/**
 * Average each day's busyness from the rolling history (not the single peak), so
 * days compare fairly regardless of how many reads they got. Each read uses its
 * measured fullness % when present, else its category; the bar height is the
 * day's AVERAGE level, the colour is that average rounded to a band, plus the
 * day's average people estimate for the tooltip.
 */
function byDayFromHistory(history: HistoryEntry[]): BusynessByDay[] | undefined {
  const byDate = new Map<string, { sum: number; n: number; people: number; pN: number }>();
  for (const e of history) {
    if (typeof e.t !== "string") continue;
    const r = readRank(e);
    if (r === undefined) continue;
    const date = e.t.slice(0, 10);
    if (!DATE_RE.test(date)) continue;
    const b = byDate.get(date) ?? { sum: 0, n: 0, people: 0, pN: 0 };
    b.sum += r;
    b.n += 1;
    if (typeof e.people === "number") {
      b.people += e.people;
      b.pN += 1;
    }
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
        people: b.pN ? Math.round(b.people / b.pN) : undefined,
        samples: b.n,
      };
    });
}

// --- Overnight fallback: what the cams saw on the last readable day ---------
//
// After dark the live read is honestly "unknown" (and stays out of the score),
// but silence isn't the friendliest answer — the card can still say what the
// beach DID on the last day the cams could see it, and when they'll see it
// again. Everything below is pure and display-only.

/** Local hours a cam read counts as "daylight" — a coarse window that holds all
 *  year at the latitudes we serve, and matches lib/sources/clarity.ts's gate.
 *  Reads outside it (a stray dark frame) never define a day's summary. */
const DAY_START_HOUR = 6;
const DAY_END_HOUR = 20;
/** Fewer reads than this is a scrap of a day, not a summary of one. */
const MIN_DAY_READS = 3;

/**
 * How far back a cam-day summary may reach: today, yesterday, or the day before
 * that. Past three days the beach has simply moved on, and a remembered day
 * shown as a headline reads as a broken card ("Wednesday: Quiet" on a Friday),
 * so the cards say plainly that there's been no recent read instead.
 */
export const MAX_CAM_SUMMARY_DAYS_BACK = 2;

/** The calendar day before `dateLocal` (YYYY-MM-DD), via UTC to dodge DST. */
function previousLocalDay(dateLocal: string): string {
  const [y, m, d] = dateLocal.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

const SHORT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Abbreviated weekday for a local date ("2026-08-26" → "Wed"), computed in UTC
 *  so it never drifts with the server's own timezone. */
export function shortWeekday(dateLocal: string): string | undefined {
  if (!DATE_RE.test(dateLocal)) return undefined;
  const [y, m, d] = dateLocal.split("-").map(Number);
  return SHORT_WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** Whole calendar days from `dateLocal` back to `todayLocal` (0 = today). */
function daysBackFrom(dateLocal: string, todayLocal: string): number | undefined {
  if (!DATE_RE.test(dateLocal) || !DATE_RE.test(todayLocal)) return undefined;
  const [ty, tm, td] = todayLocal.split("-").map(Number);
  const [dy, dm, dd] = dateLocal.split("-").map(Number);
  return Math.round(
    (Date.UTC(ty, tm - 1, td) - Date.UTC(dy, dm - 1, dd)) / 86_400_000,
  );
}

/** True when a readable day is recent enough to summarize. A day of unknown
 *  distance (the caller passed no "today") keeps the old unbounded behaviour. */
function withinSummaryWindow(day: { daysBack?: number }): boolean {
  return day.daysBack == null || day.daysBack <= MAX_CAM_SUMMARY_DAYS_BACK;
}

/**
 * How to name the day a summary describes, relative to the beach's own today:
 * "today" once the sun has set but today's reads are still the freshest,
 * "yesterday" for the day that just ended (the 1 AM case), else the weekday.
 * Exported so lib/sources/clarity.ts names days identically.
 */
export function camDayLabel(dateLocal: string, todayLocal?: string): CamDayLabel {
  if (todayLocal) {
    if (dateLocal === todayLocal) return "today";
    if (dateLocal === previousLocalDay(todayLocal)) return "yesterday";
  }
  return weekdayName(dateLocal) ?? "the last cam day";
}

const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * The card headline for a day summary: "Today", "Yesterday", or — for the
 * oldest day still inside the summary window — "Last read (Sun)". The
 * parenthetical makes a two-day-old reading unmistakably historical; the bare
 * "Sunday: Quiet" it replaces read as a broken card. Exported so the busyness
 * card and the clarity tile name the day identically.
 */
export function camDayHeadline(day: {
  dateLocal: string;
  dayLabel: CamDayLabel;
  daysBack?: number;
}): string {
  if (day.daysBack != null && day.daysBack >= MAX_CAM_SUMMARY_DAYS_BACK) {
    const w = shortWeekday(day.dateLocal);
    return w ? `Last read (${w})` : "Last read";
  }
  return cap(day.dayLabel);
}

/**
 * The one honest line a card shows when its newest readable day is older than
 * the summary window: "No recent cam reads — last clear read Wed". The weekday
 * is dropped when no day is readable at any distance.
 */
export function noRecentCamReadsCopy(lastReadWeekday?: string): string {
  return lastReadWeekday
    ? `No recent cam reads — last clear read ${lastReadWeekday}`
    : "No recent cam reads";
}

/**
 * The most recent local day (at or before `todayLocal`) with at least
 * MIN_DAY_READS usable daylight reads, plus those reads and how many calendar
 * days back it sits. Walks backwards, so a rained-out or feed-less day falls
 * through to the one before it; the walk itself is UNBOUNDED so callers can
 * still name a long-stale day, and they apply MAX_CAM_SUMMARY_DAYS_BACK to
 * decide whether it may be summarized. Exported for lib/sources/clarity.ts,
 * which needs the same day selection over its own history shape.
 */
export function mostRecentReadableDay<T extends { t?: string; hour?: number }>(
  history: readonly T[],
  todayLocal: string | undefined,
  usable: (entry: T) => boolean,
): { dateLocal: string; entries: T[]; daysBack?: number } | undefined {
  const byDate = new Map<string, T[]>();
  for (const e of history) {
    if (typeof e.t !== "string") continue;
    const date = e.t.slice(0, 10);
    if (!DATE_RE.test(date)) continue;
    if (todayLocal && date > todayLocal) continue; // never summarize the future
    if (typeof e.hour !== "number" || e.hour < DAY_START_HOUR || e.hour >= DAY_END_HOUR) {
      continue;
    }
    if (!usable(e)) continue;
    const bucket = byDate.get(date);
    if (bucket) bucket.push(e);
    else byDate.set(date, [e]);
  }
  const dates = [...byDate.keys()].sort();
  for (let i = dates.length - 1; i >= 0; i--) {
    const entries = byDate.get(dates[i]) as T[];
    if (entries.length >= MIN_DAY_READS) {
      return {
        dateLocal: dates[i],
        entries,
        daysBack: todayLocal ? daysBackFrom(dates[i], todayLocal) : undefined,
      };
    }
  }
  return undefined;
}

/**
 * Abbreviated weekday of the newest readable day when that day is TOO OLD to
 * summarize — the "last clear read Wed" the cards fall back to. Undefined when
 * a summary is available, or when no day is readable at any distance (the card
 * then keeps its plain "cams can't see" note). Exported for clarity.ts.
 */
export function staleCamReadWeekday<T extends { t?: string; hour?: number }>(
  history: readonly T[],
  todayLocal: string | undefined,
  usable: (entry: T) => boolean,
): string | undefined {
  const day = mostRecentReadableDay(history, todayLocal, usable);
  if (!day || withinSummaryWindow(day)) return undefined;
  return shortWeekday(day.dateLocal);
}

/**
 * When the cams can see the beach again: the next sunrise minus the same
 * DAYLIGHT_BUFFER_MS the gate already allows, so the promised time is the
 * moment the gate actually opens. Today's sunrise when it's still ahead (the
 * 1 AM case), else tomorrow's. Undefined when sun times are missing — the UI
 * then simply omits the line rather than guessing. Exported for clarity.ts.
 */
export function nextCamReadIso(
  now: Date,
  sunriseIso?: string,
  tomorrowSunriseIso?: string,
): string | undefined {
  for (const iso of [sunriseIso, tomorrowSunriseIso]) {
    if (!iso) continue;
    const opensAt = new Date(iso).getTime() - DAYLIGHT_BUFFER_MS;
    if (Number.isFinite(opensAt) && opensAt > now.getTime()) {
      return new Date(opensAt).toISOString();
    }
  }
  return undefined;
}

/** A history entry usable as a crowd read (it carries a real fullness %). */
const USABLE_CROWD = (e: HistoryEntry): boolean =>
  typeof e.crowdPct === "number" && Number.isFinite(e.crowdPct);

/**
 * The last readable day's crowd, as one line the card can say at night: the
 * day's overall level (mean fullness → band), its peak and when that peak hit.
 * Null when no day in the history carries enough daylight reads, OR when the
 * newest such day is further back than MAX_CAM_SUMMARY_DAYS_BACK — a day older
 * than that isn't a stand-in for "right now", so the card says there's been no
 * recent read instead of headlining a stale weekday. Pure + tested.
 */
export function busynessDaySummary(
  history: readonly HistoryEntry[],
  todayLocal?: string,
): BusynessDaySummary | null {
  const day = mostRecentReadableDay(history, todayLocal, USABLE_CROWD);
  if (!day || !withinSummaryWindow(day)) return null;

  const reads = day.entries.map((e) => ({
    hour: e.hour as number,
    pct: clamp(e.crowdPct as number, 0, 100),
  }));
  const avg = reads.reduce((sum, r) => sum + r.pct, 0) / reads.length;
  // Ties go to the earlier read, so "peaked ~2 PM" names when it FIRST filled up.
  const peak = reads.reduce((a, b) => (b.pct > a.pct ? b : a));

  return {
    dateLocal: day.dateLocal,
    dayLabel: camDayLabel(day.dateLocal, todayLocal),
    daysBack: day.daysBack,
    level: pctToLevel(avg),
    peakLevel: pctToLevel(peak.pct),
    peakHourLocal: peak.hour,
    avgCrowdPct: Math.round(avg),
    reads: reads.length,
  };
}

/**
 * Roll up the per-cam crowd reads into one busyness level. Uses the LATEST
 * capture (busyness is time-of-day dependent, unlike seaweed) and takes the
 * busiest cam as the headline. Pure (unit-tested); `gate` is how the caller
 * (fetchBusyness) tells it whether "now" is outside daylight or the capture
 * is stale — both cases degrade the CURRENT reading to "unknown" (no
 * level/people/crowdPct headline) while leaving the historical byHour/byDay
 * charts untouched, since those are daytime aggregates that stay valid.
 */
/**
 * "≈20% busier than the average Tuesday" — today's crowd vs a hour-matched,
 * same-weekday rolling baseline. Computed even when the current read is gated to
 * "unknown" (night/stale): the live headline is unavailable but the historical
 * comparison is still honest, drawn from today's daylight reads. Returns
 * undefined when the caller didn't supply today's local date (unit tests that
 * only exercise cam-selection). See lib/vsAverage.ts.
 */
function busynessVsAvg(
  history: readonly VsAverageEntry[],
  nowLocalDate?: string,
): BusynessData["vsAvg"] {
  if (!nowLocalDate) return undefined;
  const r = vsAverage(history, nowLocalDate, { matchWeekday: true, minBaselineDays: 5 }, "crowdPct");
  return {
    deltaPct: r.deltaPct,
    deltaPts: r.deltaPts,
    weekday: weekdayName(nowLocalDate) ?? "day",
    baselineDays: r.baselineDays,
  };
}

export function summarizeBusyness(
  feed: CamFeed,
  gate?: BusynessGateOptions,
  nowLocalDate?: string,
): BusynessData {
  const history = feed?.history ?? [];
  const byHour = byHourFromHistory(history);
  const byDay = byDayFromHistory(history);
  const vsAvg = busynessVsAvg(history, nowLocalDate);
  const group = feed?.latest ?? feed?.morning ?? undefined;

  // No gate passed at all -> caller isn't opting into the daylight/freshness
  // check (e.g. tests exercising cam-selection logic in isolation); only
  // fetchBusyness's real callers pass one.
  const note = gate ? unreadableReason(group?.capturedAtLocal, gate) : undefined;
  if (note) {
    // Gated: the LIVE reading stays "unknown" (so it still drops out of the
    // score), but we hand the card the last readable day and the next read time
    // so it can say something useful instead of "no read".
    const yesterday = busynessDaySummary(history, nowLocalDate);
    return {
      level: "unknown",
      capturedAtLocal: group?.capturedAtLocal,
      note,
      byHour,
      byDay,
      vsAvg,
      yesterday,
      // Only when the newest readable day was too old to summarize: the card
      // then says "No recent cam reads — last clear read Wed".
      lastReadWeekday: yesterday
        ? undefined
        : staleCamReadWeekday(history, nowLocalDate, USABLE_CROWD),
      // Only darkness has a knowable end. A stale DAYTIME capture keeps its own
      // note instead: the gate is already open, so the next read is whenever the
      // job recovers — promising "6:26 AM tomorrow" would be worse than silence.
      nextReadIso:
        note === NIGHT_NOTE
          ? nextCamReadIso(gate?.now ?? new Date(), gate?.sunriseIso, gate?.tomorrowSunriseIso)
          : undefined,
    };
  }

  const cams = (group?.cams ?? []).filter(
    (c): c is CamReading & { crowd: BusynessLevel } =>
      !!c && typeof c.crowd === "string" && c.crowd in RANK,
  );
  if (!cams.length) {
    return { level: "unknown", capturedAtLocal: group?.capturedAtLocal, byHour, byDay, vsAvg };
  }
  const busiest = cams.reduce((a, b) => {
    if (RANK[b.crowd] !== RANK[a.crowd]) return RANK[b.crowd] > RANK[a.crowd] ? b : a;
    return (b.crowdPct ?? -1) > (a.crowdPct ?? -1) ? b : a;
  });
  return {
    level: busiest.crowd,
    peopleEstimate: typeof busiest.people === "number" ? busiest.people : undefined,
    crowdPct: typeof busiest.crowdPct === "number" ? busiest.crowdPct : undefined,
    note: busiest.crowdNote,
    capturedAtLocal: group?.capturedAtLocal,
    cams: cams.map((c) => ({ name: c.name, crowd: c.crowd, people: c.people })),
    byHour,
    byDay,
    vsAvg,
  };
}

export async function fetchBusyness(
  loc: Location,
): Promise<Wrapped<BusynessData>> {
  // Crowd/busyness comes from the same cam-vision job — cam beaches only.
  // Without cams there is no crowd source here; return no data so the UI hides
  // it instead of showing another beach's (Boca's) crowd reading.
  if (!loc.cams?.length) {
    return {
      source: ATTRIBUTION,
      status: "best-effort",
      fetchedAt: nowIso(),
      attribution: ATTRIBUTION,
      data: null,
      note: "no beach cams here — crowd isn't tracked for this beach",
    };
  }
  let fetchedAt = nowIso();
  try {
    const res = await fetchWithTimeout(CAM_FEED_URL, {
      timeoutMs: 6000,
      next: { revalidate: 600 }, // 10 min — the cam job now runs every 10 min during daylight
    });
    fetchedAt = fetchedAtOf(res);
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
    const feed = (await res.json()) as CamFeed;
    // The GitHub CDN's Date header is serve-time, not when the job generated the
    // snapshot — report the older of the two so RelativeTime matches the card.
    fetchedAt = oldestIso(feed.generatedAt, fetchedAtOf(res));
    // Sun times are a pure local computation (no network) — cheap to derive here
    // so summarizeBusyness can gate the current reading to the beach's own
    // daylight window without depending on lib/conditions.ts's fetch ordering.
    const sun = fetchSun(loc).data;
    // Today's local calendar date at the beach — anchors the vs-average baseline
    // to "today" in the beach's own timezone (not the server's).
    const nowLocalDate = new Intl.DateTimeFormat("en-CA", { timeZone: loc.timezone }).format(
      new Date(),
    );
    const data = summarizeBusyness(
      feed,
      {
        sunriseIso: sun?.sunrise,
        sunsetIso: sun?.sunset,
        // Tomorrow's sunrise answers "when does the next read come in?" once
        // today's has already passed (the evening case).
        tomorrowSunriseIso: sun?.tomorrowSunrise,
      },
      nowLocalDate,
    );
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
