/**
 * "Next cam read" — when the rolling beach-cam feed is likely to produce its
 * next reading. The cron that drives it is irregular (sometimes every 10 min,
 * sometimes multi-hour gaps, and it never runs overnight), so there is no
 * fixed schedule to quote. Instead this learns from the last two weeks of
 * actual reads: for each of those days, how long after this same time of day
 * did a read actually land? The median of those delays, added to now, is the
 * estimate. Pure + timezone-aware (DST-safe, both the gap and overlap cases);
 * no network, no Date.now() by default — callers pass `now` explicitly for
 * determinism. Refuses to guess off a dead feed — see MAX_FEED_AGE_MS.
 */

const LOOKBACK_DAYS = 14;
const MIN_BASIS_DAYS = 5;
const LOOKAHEAD_MS = 24 * 60 * 60_000;
const FIVE_MIN_MS = 5 * 60_000;
/** Beyond this age, the newest read is a stale/dead feed, not a cron gap — an
 *  estimate learned from it would be a stale guess dressed up as a live one. */
const MAX_FEED_AGE_MS = 36 * 60 * 60_000;
/** Sampling offset far enough from any target instant that it always lands
 *  outside a DST transition window (transitions are months apart). */
const OFFSET_PROBE_MS = 36 * 60 * 60_000;

export interface ExpectedNextCamRead {
  /** Estimated instant of the next cam read (ISO), rounded up to the next 5 min. */
  iso: string;
  /** How many of the last 14 local days actually had a matching read — the
   *  sample size behind the median. Always >= 5 (else the function returns null). */
  basisDays: number;
}

/** Zero-padded local calendar/clock fields of `date` in `tz`. */
function zonedParts(
  date: Date,
  tz: string,
): { dateStr: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const dateStr = `${get("year")}-${get("month")}-${get("day")}`;
  return { dateStr, hour: Number(get("hour")), minute: Number(get("minute")) };
}

/** The tz's UTC offset (minutes, UTC − local) in effect at `date`. */
function tzOffsetMinutes(date: Date, tz: string): number {
  const { dateStr, hour, minute } = zonedParts(date, tz);
  const [y, m, d] = dateStr.split("-").map(Number);
  const asIfUtc = Date.UTC(y, m - 1, d, hour, minute, 0);
  return Math.round((asIfUtc - date.getTime()) / 60_000);
}

/**
 * Convert a local wall-clock (calendar date + hour:minute) in `tz` to the
 * absolute UTC instant it names.
 *
 * DST-safe by construction rather than by iterative refinement: sample the
 * tz's offset a day and a half BEFORE and AFTER the naive target (far enough
 * that a real DST transition — always months apart) can't be straddled by
 * both samples at once), then check which candidate instant actually round-
 * trips back to the requested wall time:
 *  - same offset both sides -> no transition nearby, one obvious answer.
 *  - both candidates round-trip -> an AMBIGUOUS fall-back hour (it occurs
 *    twice) -> the EARLIER of the two instants.
 *  - neither round-trips -> a nonexistent spring-forward hour (the clock
 *    skipped over it) -> the FIRST VALID instant after it, i.e. the LATER
 *    of the two candidates.
 *  - exactly one round-trips -> that one.
 */
function zonedTimeToUtc(dateStr: string, hour: number, minute: number, tz: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  const naiveUtc = Date.UTC(y, m - 1, d, hour, minute, 0);

  const offsetBefore = tzOffsetMinutes(new Date(naiveUtc - OFFSET_PROBE_MS), tz);
  const offsetAfter = tzOffsetMinutes(new Date(naiveUtc + OFFSET_PROBE_MS), tz);
  if (offsetBefore === offsetAfter) {
    return naiveUtc - offsetBefore * 60_000;
  }

  const candA = naiveUtc - offsetBefore * 60_000;
  const candB = naiveUtc - offsetAfter * 60_000;
  const roundTrips = (utcMs: number): boolean => {
    const p = zonedParts(new Date(utcMs), tz);
    return p.dateStr === dateStr && p.hour === hour && p.minute === minute;
  };
  const aOk = roundTrips(candA);
  const bOk = roundTrips(candB);
  if (aOk && bOk) return Math.min(candA, candB); // ambiguous -> earlier instant
  if (aOk) return candA;
  if (bOk) return candB;
  return Math.max(candA, candB); // nonexistent -> first valid instant after it
}

/** `dateStr` (YYYY-MM-DD) shifted by `delta` CALENDAR days — pure date-field
 *  arithmetic, no timezone or DST involved (it never represents an instant). */
function shiftDateStr(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Estimate when the next cam read will land, learned from history rather than
 * a fixed schedule.
 *
 * Method: look at the last 14 local calendar days before today (walked
 * directly as calendar dates, not by subtracting 24h*k — immune to DST by
 * construction). For each of those days, find the first actual read at or
 * after that day's version of `now`'s time-of-day (looking up to 24h ahead,
 * which may land the next morning — the overnight-gap case). The gap between
 * "that day's target time" and "the read that answered it" is one sample.
 * Requires at least 5 such days (else too little signal — returns null). The
 * estimate is `now` + the MEDIAN of those delays, rounded up to the next 5
 * minutes.
 *
 * Returns null outright when the newest read is more than 36h old — a dead
 * or long-stalled feed, not an ordinary overnight gap; an estimate learned
 * from it would just be a stale guess wearing a live one's clothes.
 */
export function expectedNextCamRead(
  readTimesIso: string[],
  now: Date,
  tz: string,
): ExpectedNextCamRead | null {
  const nowParts = zonedParts(now, tz);

  const reads = readTimesIso
    .map((iso) => {
      const ms = new Date(iso).getTime();
      return Number.isFinite(ms) ? ms : null;
    })
    .filter((ms): ms is number => ms !== null)
    .sort((a, b) => a - b);
  if (!reads.length) return null;
  if (now.getTime() - reads[reads.length - 1] > MAX_FEED_AGE_MS) return null;

  // The last LOOKBACK_DAYS distinct local calendar dates strictly before today.
  const days: string[] = [];
  for (let k = 1; k <= LOOKBACK_DAYS; k++) {
    days.push(shiftDateStr(nowParts.dateStr, -k));
  }

  const delaysMin: number[] = [];
  for (const day of days) {
    const targetMs = zonedTimeToUtc(day, nowParts.hour, nowParts.minute, tz);
    const candidate = reads.find((ms) => ms >= targetMs && ms <= targetMs + LOOKAHEAD_MS);
    if (candidate !== undefined) {
      delaysMin.push(Math.round((candidate - targetMs) / 60_000));
    }
  }

  if (delaysMin.length < MIN_BASIS_DAYS) return null;

  const delayMin = median(delaysMin);
  const targetMs = now.getTime() + delayMin * 60_000;
  const roundedMs = Math.ceil(targetMs / FIVE_MIN_MS) * FIVE_MIN_MS;
  return { iso: new Date(roundedMs).toISOString(), basisDays: delaysMin.length };
}
