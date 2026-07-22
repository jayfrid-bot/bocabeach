// ---------------------------------------------------------------------------
// "Compared to average" readouts for the cam-derived signals (busyness + seaweed).
//
// Both signals come from ONE rolling cam feed (cam_seaweed.json). This module
// answers "how does TODAY compare to a typical day?" honestly, which is trickier
// than it looks because both signals have a strong time-of-day shape: crowds
// build through the afternoon; seaweed is heaviest at dawn and gets cleaned
// during the day. So at 10 AM, today only has morning reads, and comparing them
// against a full-day baseline (packed afternoons / cleaned sand) would lie.
//
// The core honesty rule is HOUR-MATCHING, done by DAY-HOUR CELLS. The cam cadence
// jumped from a handful of reads/day to one every ~10 min in daylight, so pooling
// raw reads would let a dense recent day swamp a dozen sparse older ones. Instead
// we collapse each (localDate, hour) to ONE cell = the mean of that cell's valid
// reads, so every day gets equal say at a given hour regardless of how many times
// the cam fired. Today's side is today's cells; the baseline side is prior-day
// cells within the lookback (and the same weekday when matchWeekday). We keep only
// the hours today covers AND that have at least one baseline cell — a today-hour
// with no baseline support is dropped from BOTH sides so it can't skew todayMean.
// Per supported hour, baselineHourMean = mean of that hour's baseline cells (one
// per day); the final means average those per-hour numbers with EQUAL WEIGHT per
// hour, not per read. Busyness additionally matches the weekday (a Saturday crowd
// is nothing like a Tuesday's); seaweed does not (no work-week rhythm).
//
// Reads outside local hours 6–20 (HOUR_MIN..HOUR_MAX, inclusive) are ignored on
// both sides — stray night captures carry no beach signal.
//
// Pure + unit-tested. No timezone conversion: each entry's `t` is already a
// local ISO string with offset, so its YYYY-MM-DD prefix IS the local calendar
// date — we read it verbatim and never re-timezone it.
// ---------------------------------------------------------------------------

/** A rolling cam read. Only the local timestamp + hour are needed structurally;
 *  the compared field (e.g. "crowdPct", "cov") is read by name at runtime. */
export interface VsAverageEntry {
  /** Local capture time, ISO with offset — its YYYY-MM-DD prefix is the local date. */
  t?: string;
  /** Local hour 0-23 of the read. */
  hour?: number;
}

export interface VsAverageOptions {
  /** Restrict the baseline to the same local weekday as today (true for crowds). */
  matchWeekday: boolean;
  /** How many prior days back the baseline may reach. */
  lookbackDays?: number;
  /** Minimum distinct baseline days before we'll speak (else deltaPct = null). */
  minBaselineDays?: number;
  /** Minimum baseline reads before we'll speak (else deltaPct = null). */
  minBaselineSamples?: number;
}

export interface VsAverageResult {
  /** Signed % difference (today − baseline)/baseline. Null = honest no-answer
   *  (no reads today, too little baseline, or a near-zero baseline). */
  deltaPct: number | null;
  /** Only set in the near-zero-baseline case (baselineMean < NEAR_ZERO_BASELINE):
   *  today − baseline in raw points, so the UI can say "+12 pts vs usual" instead
   *  of a meaningless ratio over almost nothing. */
  deltaPts?: number | null;
  todayMean: number | null;
  baselineMean: number | null;
  /** Distinct calendar days whose cells fed the baseline. */
  baselineDays: number;
  /** Number of baseline day-hour CELLS feeding the comparison (one cell = one
   *  day's mean at one supported hour), NOT the raw read count. */
  baselineSamples: number;
}

/** Tunable defaults — named exports so callers/tests can reference them. */
export const DEFAULT_LOOKBACK_DAYS = 56; // ~8 weeks
export const DEFAULT_MIN_BASELINE_DAYS = 3;
/** Minimum baseline day-hour cells before we'll speak. */
export const DEFAULT_MIN_BASELINE_SAMPLES = 8;
/** Below this baseline mean a ratio is meaningless (e.g. a mean of 4 → "200%
 *  busier" over almost nothing); we fall back to a raw points delta instead. */
export const NEAR_ZERO_BASELINE = 10;
/** Local hour window the cams carry real signal in (inclusive). Reads outside
 *  it — stray night captures — are ignored on both the today and baseline sides. */
export const HOUR_MIN = 6;
export const HOUR_MAX = 20;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** Local calendar date (YYYY-MM-DD) of a read, verbatim from `t`'s prefix. */
function localDate(e: VsAverageEntry): string | null {
  const d = e.t?.slice(0, 10);
  return d && DATE_RE.test(d) ? d : null;
}

/** Full weekday name for a local YYYY-MM-DD date, computed in UTC so it's
 *  independent of the runtime timezone (the date carries no time-of-day). */
export function weekdayName(dateStr: string): string | null {
  if (!DATE_RE.test(dateStr)) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  const idx = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return WEEKDAYS[idx] ?? null;
}

/** Whole-day difference a − b (both YYYY-MM-DD), in UTC to avoid DST drift. */
function dayDiff(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86_400_000);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
}

/** Push `v` onto the array stored at `key`, creating it on first use. */
function pushInto<K>(map: Map<K, number[]>, key: K, v: number): void {
  const arr = map.get(key);
  if (arr) arr.push(v);
  else map.set(key, [v]);
}

/**
 * Compare today's reads of `field` against a hour-matched baseline of prior days,
 * counting by DAY-HOUR CELLS (one cell per day per hour) so a dense day can't
 * out-vote a sparse one. See the file header for the honesty rules. `nowLocalDate`
 * is today's local calendar date (YYYY-MM-DD) — the caller derives it from the
 * beach's timezone (or the latest capture's own local date).
 */
export function vsAverage(
  history: readonly VsAverageEntry[],
  nowLocalDate: string,
  opts: VsAverageOptions,
  field: string,
): VsAverageResult {
  const {
    matchWeekday,
    lookbackDays = DEFAULT_LOOKBACK_DAYS,
    minBaselineDays = DEFAULT_MIN_BASELINE_DAYS,
    minBaselineSamples = DEFAULT_MIN_BASELINE_SAMPLES,
  } = opts;

  const todayWeekday = weekdayName(nowLocalDate);
  const read = (e: VsAverageEntry) => num((e as Record<string, unknown>)[field]);
  const inWindow = (h: number) => h >= HOUR_MIN && h <= HOUR_MAX;

  // Pass 1 — today's reads, bucketed by hour: hour -> the valid values seen this
  // hour today. A read counts only with a valid in-window hour AND field value.
  const todayByHour = new Map<number, number[]>();
  for (const e of history) {
    if (localDate(e) !== nowLocalDate) continue;
    if (typeof e.hour !== "number" || !inWindow(e.hour)) continue;
    const v = read(e);
    if (v == null) continue;
    pushInto(todayByHour, e.hour, v);
  }

  // Pass 2 — the baseline, bucketed by hour then by day: hour -> (date -> values).
  // Restricted to today's hours (and today's weekday when matchWeekday), prior
  // days within the lookback, excluding today. Each (hour, date) becomes one cell.
  const baselineByHour = new Map<number, Map<string, number[]>>();
  if (todayByHour.size) {
    for (const e of history) {
      if (typeof e.hour !== "number" || !inWindow(e.hour) || !todayByHour.has(e.hour)) continue;
      const d = localDate(e);
      if (!d || d === nowLocalDate) continue;
      const age = dayDiff(nowLocalDate, d);
      if (age < 1 || age > lookbackDays) continue; // prior days only, within window
      if (matchWeekday && todayWeekday && weekdayName(d) !== todayWeekday) continue;
      const v = read(e);
      if (v == null) continue;
      let byDate = baselineByHour.get(e.hour);
      if (!byDate) {
        byDate = new Map<string, number[]>();
        baselineByHour.set(e.hour, byDate);
      }
      pushInto(byDate, d, v);
    }
  }

  // Combine, EQUAL WEIGHT PER SUPPORTED HOUR. A supported hour is one today covers
  // that also has ≥1 baseline cell; hours with no baseline support are dropped
  // from BOTH sides. Per hour: today's cell (mean of today's reads) on one side;
  // the mean of that hour's baseline cells (each cell = one day's mean) on the
  // other. baselineSamples counts cells; baselineDays counts distinct dates.
  const todayHourMeans: number[] = [];
  const baselineHourMeans: number[] = [];
  const baselineDates = new Set<string>();
  let baselineSamples = 0;
  for (const [hour, todayVals] of todayByHour) {
    const byDate = baselineByHour.get(hour);
    if (!byDate || byDate.size === 0) continue; // no baseline support -> drop
    const cellMeans: number[] = [];
    for (const [d, vals] of byDate) {
      const m = mean(vals);
      if (m == null) continue;
      cellMeans.push(m);
      baselineDates.add(d);
      baselineSamples += 1;
    }
    if (!cellMeans.length) continue;
    const todayCell = mean(todayVals);
    if (todayCell == null) continue;
    todayHourMeans.push(todayCell);
    baselineHourMeans.push(mean(cellMeans)!);
  }

  const todayMean = mean(todayHourMeans);
  const baselineMean = mean(baselineHourMeans);
  const baselineDays = baselineDates.size;

  const result: VsAverageResult = {
    deltaPct: null,
    todayMean,
    baselineMean,
    baselineDays,
    baselineSamples,
  };

  // Guards — stay silent (deltaPct null) unless we have today's reads and a
  // baseline that's actually worth comparing against.
  if (
    todayMean == null ||
    baselineMean == null ||
    baselineDays < minBaselineDays ||
    baselineSamples < minBaselineSamples
  ) {
    return result;
  }

  if (baselineMean < NEAR_ZERO_BASELINE) {
    // Near-zero baseline: a ratio is meaningless, hand back a raw points delta.
    result.deltaPts = todayMean - baselineMean;
    return result;
  }

  result.deltaPct = ((todayMean - baselineMean) / baselineMean) * 100;
  return result;
}
