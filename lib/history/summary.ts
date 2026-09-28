// Pure summarizer for the Plus "Last 7 days" history feature
// (docs/HISTORY_AND_IMAGERY_PLAN.md Part A). Turns the flat hourly rows
// `DeviceStore.hourlyHistory` returns into per-day summaries plus a handful
// of records. No I/O, no Date.now() — every date/hour comes straight off
// the row's own `local_date`/`local_hour` fields, exactly as the archiver
// stored them (never recomputed from `hour_utc`, which would silently
// misplace an hour across a DST boundary the row's own fields already
// resolved correctly at write time — see lib/history/archive.ts
// `localHourParts`).

import type { BeachHourlyRow } from "@/lib/history/types";

/** A day needs at least this many SCORED hours to count as a full day —
 *  fewer and `partial: true` warns the UI the number is thin (e.g. the
 *  first day archiving ever ran, or a day with an outage). */
const MIN_SCORED_HOURS_FOR_FULL_DAY = 6;

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Short weekday label ("Mon") for a YYYY-MM-DD calendar date. Pure calendar
 *  math (Date.UTC on the parsed y/m/d) — `localDate` is already the beach's
 *  own local calendar day, so there is no timezone left to apply. */
export function weekdayOf(localDate: string): string {
  const [y, m, d] = localDate.split("-").map(Number);
  if (!y || !m || !d) return "";
  return WEEKDAY_LABELS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** `localDate` shifted by `deltaDays` (negative = earlier), as a new
 *  YYYY-MM-DD string. Pure calendar arithmetic — used by the history API
 *  route to turn a `days` window (7/14/30) into the `sinceLocalDate` bound
 *  `DeviceStore.hourlyHistory` queries on. */
export function shiftLocalDate(localDate: string, deltaDays: number): string {
  const [y, m, d] = localDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  const yy = String(dt.getUTCFullYear()).padStart(4, "0");
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
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
   *  this one in the UI, unlike sand/waves/crowds/seaweed). */
  waterF: number | null;
  sandMaxF: number | null;
  waveMaxFt: number | null;
  crowdPeakPct: number | null;
  seaweedMaxPct: number | null;
  /** Distinct cap strings active at any hour this day, alphabetical. */
  caps: string[];
  /** Fewer than MIN_SCORED_HOURS_FOR_FULL_DAY scored hours this day. */
  partial: boolean;
  /** Every scored hour this day, ascending by localHour — compact enough to
   *  ship in the day summary itself (at most 24 pairs) rather than a second
   *  round trip, and what the UI's tap-to-expand hourly bar row draws
   *  directly (components/plus/HistorySection.tsx). */
  hourly: { localHour: number; score: number }[];
}

export interface HistoryRecords {
  bestDay: { date: string; score: number } | null;
  hottestSand: { date: string; sandTempF: number; localHour: number } | null;
  biggestWaves: { date: string; waveFt: number; localHour: number } | null;
  /** Lowest daily PEAK crowd — "quietest" means the calmest the busiest
   *  moment of that day ever got, not the lowest single reading. Only
   *  considers days with at least one crowd reading (cam beaches only). */
  quietestDay: { date: string; crowdPct: number } | null;
}

export interface HistorySummary {
  days: DaySummary[];
  records: HistoryRecords;
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

  const avgScore = scored.length ? scored.reduce((sum, r) => sum + r.score, 0) / scored.length : null;
  const waterAvg = avgOf(sorted, "water_temp_f");

  const capsSet = new Set<string>();
  for (const r of sorted) for (const c of parseCaps(r.caps_json)) capsSet.add(c);

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
    waveMaxFt: maxOf(sorted, "wave_ft"),
    crowdPeakPct: maxOf(sorted, "crowd_pct"),
    seaweedMaxPct: maxOf(sorted, "seaweed_pct"),
    caps: [...capsSet].sort(),
    partial: scored.length < MIN_SCORED_HOURS_FOR_FULL_DAY,
    hourly: scored.map((r) => ({ localHour: r.local_hour, score: r.score })),
  };
}

/**
 * Group `rows` (already filtered to one beach/one row_kind by the store) by
 * `local_date`, summarize each day, and compute records across the whole
 * set. Rows need not arrive pre-sorted; the output `days` is always
 * date-ascending. On every tie (a record shared by two+ days/hours) the
 * EARLIEST date/hour wins — deterministic, and matches how a person reading
 * "records since" would expect the first time something happened to be the
 * one that's named.
 */
export function summarizeHistory(rows: BeachHourlyRow[]): HistorySummary {
  const byDate = new Map<string, BeachHourlyRow[]>();
  for (const r of rows) {
    const list = byDate.get(r.local_date);
    if (list) list.push(r);
    else byDate.set(r.local_date, [r]);
  }
  const days = [...byDate.keys()].sort().map((date) => summarizeDay(date, byDate.get(date) ?? []));

  let bestDay: HistoryRecords["bestDay"] = null;
  for (const d of days) {
    if (!d.best) continue;
    if (!bestDay || d.best.score > bestDay.score) bestDay = { date: d.date, score: d.best.score };
  }

  // Hottest sand / biggest waves are single-READING records, not per-day
  // maxes of a max — scanned across every row directly so the exact hour is
  // nameable, not just the day. Sorted chronologically first (not just left
  // in whatever order the caller passed `rows`) so a tie's "first found"
  // really is the EARLIEST date/hour, matching the doc above and
  // `summarizeDay`'s own tie rule for best/worst.
  const chronological = [...rows].sort((a, b) =>
    a.local_date === b.local_date ? a.local_hour - b.local_hour : a.local_date < b.local_date ? -1 : 1,
  );
  let hottestSand: HistoryRecords["hottestSand"] = null;
  let biggestWaves: HistoryRecords["biggestWaves"] = null;
  for (const r of chronological) {
    if (typeof r.sand_temp_f === "number" && (!hottestSand || r.sand_temp_f > hottestSand.sandTempF)) {
      hottestSand = { date: r.local_date, sandTempF: r.sand_temp_f, localHour: r.local_hour };
    }
    if (typeof r.wave_ft === "number" && (!biggestWaves || r.wave_ft > biggestWaves.waveFt)) {
      biggestWaves = { date: r.local_date, waveFt: r.wave_ft, localHour: r.local_hour };
    }
  }

  let quietestDay: HistoryRecords["quietestDay"] = null;
  for (const d of days) {
    if (d.crowdPeakPct == null) continue;
    if (!quietestDay || d.crowdPeakPct < quietestDay.crowdPct) {
      quietestDay = { date: d.date, crowdPct: d.crowdPeakPct };
    }
  }

  return { days, records: { bestDay, hottestSand, biggestWaves, quietestDay } };
}
