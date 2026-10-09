// Pure summarizer for the Plus "Last N days" history feature
// (docs/HISTORY_AND_IMAGERY_PLAN.md Part A). Turns the flat hourly rows
// `DeviceStore.hourlyHistory` returns into per-day summaries. No I/O, no
// Date.now() — every date/hour comes straight off the row's own
// `local_date`/`local_hour` fields, exactly as the archiver stored them
// (never recomputed from `hour_utc`, which would silently misplace an hour
// across a DST boundary the row's own fields already resolved correctly at
// write time — see lib/history/archive.ts `localHourParts`).
//
// Records (best day, hottest sand, biggest surf, quietest) are NOT computed
// here — they are a LIFETIME read across the whole archive, independent of
// whatever `days` window a caller asked `hourlyHistory` for, so they come
// from a separate store method (`DeviceStore.historyRecords`, one UNION ALL
// SQL query in d1Store.ts). `recordsFromRows` below only maps that store
// row shape into the API's friendlier shape — still pure, still no I/O.

import type { BeachHourlyRow, HistoryRecordRow } from "@/lib/history/types";
import { compareEngineVersions, findScoringVersion, SCORING_VERSIONS } from "@/lib/scoringVersions";

/** A day needs at least this many SCORED hours to count as a full day —
 *  fewer and `partial: true` warns the UI the number is thin (e.g. the
 *  first day archiving ever ran, or a day with an outage). */
const MIN_SCORED_HOURS_FOR_FULL_DAY = 6;

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WEEKDAY_LABELS_LONG = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
] as const;
/** "Sept", not Intl's 3-letter "Sep" — matches this app's existing changelog/
 *  copy voice ("Records since Sept 22"). Every other month is the ordinary
 *  3-letter abbreviation. */
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"] as const;

function ymd(localDate: string): [number, number, number] | null {
  const [y, m, d] = localDate.split("-").map(Number);
  return y && m && d ? [y, m, d] : null;
}

/** Short weekday label ("Mon") for a YYYY-MM-DD calendar date. Pure calendar
 *  math (Date.UTC on the parsed y/m/d) — `localDate` is already the beach's
 *  own local calendar day, so there is no timezone left to apply. */
export function weekdayOf(localDate: string): string {
  const parts = ymd(localDate);
  if (!parts) return "";
  const [y, m, d] = parts;
  return WEEKDAY_LABELS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** Full weekday name ("Monday") — for accessible names, where the visible
 *  cell only has room for the 3-letter form. */
export function weekdayLongOf(localDate: string): string {
  const parts = ymd(localDate);
  if (!parts) return "";
  const [y, m, d] = parts;
  return WEEKDAY_LABELS_LONG[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** "2026-09-22" -> "Sept 22". */
export function shortMonthDay(localDate: string): string {
  const parts = ymd(localDate);
  if (!parts) return localDate;
  const [, m, d] = parts;
  return `${SHORT_MONTHS[m - 1]} ${d}`;
}

/** `localDate` shifted by `deltaDays` (negative = earlier), as a new
 *  YYYY-MM-DD string. Pure calendar arithmetic — used by the history API
 *  route to turn a `days` window (7/14/30) into the `sinceLocalDate` bound
 *  `DeviceStore.hourlyHistory` queries on. */
export function shiftLocalDate(localDate: string, deltaDays: number): string {
  const parts = ymd(localDate);
  if (!parts) return localDate;
  const [y, m, d] = parts;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  const yy = String(dt.getUTCFullYear()).padStart(4, "0");
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** Whole calendar days between two YYYY-MM-DD strings (`b` minus `a`),
 *  positive when `b` is later. Pure Date.UTC diff — both inputs are already
 *  bare calendar dates, never instants. Used client-side to decide whether
 *  the 30-day chip should unlock: `daysBetweenLocalDates(archiveStartedAt,
 *  today) >= 14` — a SPAN check, not a row/day COUNT (a beach with gaps in
 *  its archive can still have earned the 30-day window on the calendar). */
export function daysBetweenLocalDates(a: string, b: string): number {
  const pa = ymd(a);
  const pb = ymd(b);
  if (!pa || !pb) return 0;
  const ua = Date.UTC(pa[0], pa[1] - 1, pa[2]);
  const ub = Date.UTC(pb[0], pb[1] - 1, pb[2]);
  return Math.round((ub - ua) / 86_400_000);
}

export interface DaySummary {
  date: string;
  weekday: string;
  /** Count of rows this day with a non-null score — NOT the raw row count. */
  hours: number;
  best: { score: number; localHour: number } | null;
  worst: { score: number; localHour: number } | null;
  /** Rounded mean of the day's scored hours, or null with none. */
  avg: number | null;
  airHighF: number | null;
  /** Mean water temp for the day, rounded — unlike the other fields below,
   *  water temperature barely moves hour to hour, so a representative
   *  average reads truer than a peak would (there's no "up to" framing for
   *  this one in the UI, unlike sand/surf/crowds/seaweed). */
  waterF: number | null;
  sandMaxF: number | null;
  /** Estimated SURF (breaking) height, from `surf_ft` ONLY — never
   *  `wave_ft` (the raw significant wave height). `surf_ft` is null on
   *  every row archived before migration 0010, so a day whose rows are all
   *  that old contributes nothing here (null), not a wave_ft stand-in —
   *  mixing the two columns would silently misreport what "biggest surf"
   *  means depending on which rows happened to be old or new. */
  surfMaxFt: number | null;
  crowdPeakPct: number | null;
  seaweedMaxPct: number | null;
  /** Distinct cap strings active at any hour this day, alphabetical. */
  caps: string[];
  /** Fewer than MIN_SCORED_HOURS_FOR_FULL_DAY scored hours this day. */
  partial: boolean;
  /** Every scored hour this day, ascending by localHour. `hourUtc` (not just
   *  `localHour`) is what callers key React lists on — a fall-back DST day
   *  has TWO hours that both read as local_hour 1, and only hour_utc tells
   *  them apart (see lib/history/archive.ts). */
  hourly: { localHour: number; hourUtc: string; score: number }[];
  /** Distinct engine (scoring formula) versions among this day's rows, oldest
   *  first. Usually one; two when a formula change landed during the day. */
  engineVersions: string[];
  /** More than one formula scored this day's rows. */
  mixedVersions: boolean;
}

/** One formula change inside the shown range. */
export interface HistoryVersionBoundary {
  /** First day the newer formula scored rows (YYYY-MM-DD). */
  date: string;
  version: string;
  /** One plain sentence on what changed (lib/scoringVersions.ts). */
  note: string;
}

/** Which formulas scored the days in a response, so the UI can say when a
 *  drop in score is a formula change and not weather. */
export interface HistoryVersions {
  /** SCORING_ENGINE_VERSION of the running build. */
  current: string;
  /** Distinct versions among the returned days, oldest first. */
  inRange: string[];
  /** The returned range mixes more than one version. */
  mixed: boolean;
  /** Formula changes that fall inside the range, oldest first. */
  boundaries: HistoryVersionBoundary[];
}

/** The API's friendly shape for one lifetime record — `recordsFromRows`
 *  below maps `DeviceStore.historyRecords`'s raw kind-tagged rows into this. */
export interface HistoryRecords {
  /** Ranked within ONE formula version (`engineVersion`) — scores from
   *  different formulas are not comparable. */
  bestDay: { date: string; score: number; localHour: number; engineVersion: string } | null;
  hottestSand: { date: string; sandTempF: number; localHour: number } | null;
  biggestSurf: { date: string; surfFt: number; localHour: number } | null;
  /** The single least-crowded midday (10 AM-6 PM local) reading on file —
   *  not a per-day peak-crowd minimum (see docs/HISTORY_AND_IMAGERY_PLAN.md
   *  Part A / the Codex review that set this rule: a day-level aggregate
   *  can't be expressed as one row in the UNION ALL query this comes from). */
  quietestDay: { date: string; crowdPct: number; localHour: number } | null;
}

/** The API's shape for the cross-beach "Best day ever" record
 *  (`DeviceStore.historyBestEver`) — the one record that is NOT about the
 *  beach the request is for. `isThisBeach` lets the UI say "This beach!". */
export interface HistoryBestEver {
  slug: string;
  name: string;
  date: string;
  score: number;
  localHour: number;
  isThisBeach: boolean;
  /** The formula that scored it — same one-version rule as `bestDay`. */
  engineVersion: string;
}

function round(v: number): number {
  return Math.round(v);
}

/** The largest finite value of a numeric column across `rows`, or null. */
function maxOf(rows: BeachHourlyRow[], key: keyof BeachHourlyRow): number | null {
  let best: number | null = null;
  for (const r of rows) {
    const v = r[key];
    if (typeof v === "number" && Number.isFinite(v) && (best === null || v > best)) best = v;
  }
  return best;
}

/** The mean of a numeric column across `rows` (rows missing it are skipped
 *  entirely, not treated as 0), or null when no row has a value. */
function avgOf(rows: BeachHourlyRow[], key: keyof BeachHourlyRow): number | null {
  let sum = 0;
  let n = 0;
  for (const r of rows) {
    const v = r[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      sum += v;
      n += 1;
    }
  }
  return n ? sum / n : null;
}

function parseCaps(json: string | null): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json) as unknown;
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function summarizeDay(date: string, rowsForDate: BeachHourlyRow[]): DaySummary {
  // Stable ascending order by local_hour — defensive against the store ever
  // handing back rows out of hour_utc order; on a genuine tie (identical
  // score at two hours), iterating in ascending-hour order below makes the
  // EARLIER hour win, deterministically.
  const sorted = [...rowsForDate].sort((a, b) => a.local_hour - b.local_hour);
  const scored = sorted.filter((r): r is BeachHourlyRow & { score: number } => typeof r.score === "number");

  let best: { score: number; localHour: number } | null = null;
  let worst: { score: number; localHour: number } | null = null;
  for (const r of scored) {
    if (!best || r.score > best.score) best = { score: r.score, localHour: r.local_hour };
    if (!worst || r.score < worst.score) worst = { score: r.score, localHour: r.local_hour };
  }

  // On a day a formula change landed, best/worst/avg still combine both formulas' hours.
  const avgScore = scored.length ? scored.reduce((sum, r) => sum + r.score, 0) / scored.length : null;
  const waterAvg = avgOf(sorted, "water_temp_f");

  const capsSet = new Set<string>();
  for (const r of sorted) for (const c of parseCaps(r.caps_json)) capsSet.add(c);

  const engineVersions = [...new Set(sorted.map((r) => r.engine_version))].sort(compareEngineVersions);

  return {
    date,
    weekday: weekdayOf(date),
    hours: scored.length,
    best,
    worst,
    avg: avgScore === null ? null : round(avgScore),
    airHighF: maxOf(sorted, "air_temp_f"),
    waterF: waterAvg === null ? null : round(waterAvg),
    sandMaxF: maxOf(sorted, "sand_temp_f"),
    surfMaxFt: maxOf(sorted, "surf_ft"),
    crowdPeakPct: maxOf(sorted, "crowd_pct"),
    seaweedMaxPct: maxOf(sorted, "seaweed_pct"),
    caps: [...capsSet].sort(),
    partial: scored.length < MIN_SCORED_HOURS_FOR_FULL_DAY,
    hourly: scored.map((r) => ({ localHour: r.local_hour, hourUtc: r.hour_utc, score: r.score })),
    engineVersions,
    mixedVersions: engineVersions.length > 1,
  };
}

/**
 * Group `rows` (already filtered to one beach/one row_kind by the store) by
 * `local_date` and summarize each day. Rows need not arrive pre-sorted; the
 * output is always date-ascending (oldest first) — callers that want
 * newest-first (the UI strip) reverse it themselves, since "chronological"
 * is the more natural order for a pure data function to hand back.
 */
export function summarizeHistory(rows: BeachHourlyRow[]): DaySummary[] {
  const byDate = new Map<string, BeachHourlyRow[]>();
  for (const r of rows) {
    const list = byDate.get(r.local_date);
    if (list) list.push(r);
    else byDate.set(r.local_date, [r]);
  }
  return [...byDate.keys()].sort().map((date) => summarizeDay(date, byDate.get(date) ?? []));
}

/**
 * Map `DeviceStore.historyRecords`'s raw kind-tagged rows (already the
 * winning row per kind, per the UNION ALL query's own ORDER BY/LIMIT 1) into
 * the API's friendly shape. A kind simply absent from `rows` (e.g. no beach
 * has ever had a 'quietest' reading if it has no cam) maps to `null`, never
 * a fabricated zero.
 */
export function recordsFromRows(rows: HistoryRecordRow[]): HistoryRecords {
  const byKind = new Map(rows.map((r) => [r.kind, r]));
  const best = byKind.get("best");
  const sand = byKind.get("hottest_sand");
  const surf = byKind.get("biggest_surf");
  const quiet = byKind.get("quietest");
  return {
    bestDay: best
      ? { date: best.local_date, score: best.value, localHour: best.local_hour, engineVersion: best.engine_version }
      : null,
    hottestSand: sand ? { date: sand.local_date, sandTempF: sand.value, localHour: sand.local_hour } : null,
    biggestSurf: surf ? { date: surf.local_date, surfFt: surf.value, localHour: surf.local_hour } : null,
    quietestDay: quiet ? { date: quiet.local_date, crowdPct: quiet.value, localHour: quiet.local_hour } : null,
  };
}

/**
 * Which formulas scored `days`, and where the formula changed inside them.
 * A change counts as "inside" only when the days really hold a version older
 * than it AND a version at or after it — so a range that starts after a
 * change, or ends before one, names nothing. Pure; `current` is passed in
 * (the route passes SCORING_ENGINE_VERSION) so tests need no real version.
 */
export function summarizeVersions(days: DaySummary[], current: string): HistoryVersions {
  const inRange = [...new Set(days.flatMap((d) => d.engineVersions))].sort(compareEngineVersions);
  const boundaries: HistoryVersionBoundary[] = [];
  SCORING_VERSIONS.forEach((entry, i) => {
    if (i === 0) return; // the first version has no change before it
    const hasOlder = inRange.some((v) => compareEngineVersions(v, entry.version) < 0);
    const hasSame = inRange.some((v) => compareEngineVersions(v, entry.version) >= 0);
    if (hasOlder && hasSame) boundaries.push({ date: entry.since, version: entry.version, note: entry.note });
  });
  return { current, inRange, mixed: inRange.length > 1, boundaries };
}

/**
 * What the record tiles need to label themselves: the day the CURRENT formula
 * started (`recordsSince`, null when the version is not listed) and whether a
 * score record had to come from an earlier formula because no row carries the
 * current one yet (`recordsFromEarlierFormula`, right after a version bump).
 */
export function recordsFormulaInfo(
  records: HistoryRecords,
  bestEver: HistoryBestEver | null,
  current: string,
): { recordsSince: string | null; recordsFromEarlierFormula: boolean } {
  const earlier =
    (records.bestDay !== null && records.bestDay.engineVersion !== current) ||
    (bestEver !== null && bestEver.engineVersion !== current);
  return { recordsSince: findScoringVersion(current)?.since ?? null, recordsFromEarlierFormula: earlier };
}
