// Pure scorecard metrics: predictions in, honest numbers out.
//
// Every function takes plain row arrays (the shapes the archive writes) and
// returns plain objects. No I/O, no clock reads (`nowMs` is passed in), no
// imports from the app beyond types. scripts/scorecard.ts fetches the rows;
// lib/scorecard/report.ts turns these results into Markdown.
//
// Honesty rule: every metric has a minimum sample. Below it the result carries
// the counts and a "collecting — N of M ..." string and NO error numbers, so a
// first-week report can never look like a verdict. Counts are in the unit that
// is statistically independent: for sun color that is EVENTS (one sunrise at one
// beach), not forecast rows — one event has dozens of hourly rows that all
// share one observation.

import type { FlagColor } from "@/lib/types";

// --- Minimum samples --------------------------------------------------------

export const MIN_SUN_EVENTS = 10;
export const MIN_RAIN_CALLS = 50;
export const MIN_WINDOW_DAYS = 10;
export const MIN_SAFETY_HOURS = 50;

/** Sun color "Great" (vivid) and "Amazing" (epic) cutoffs — lib/sunQuality.ts bands. */
export const GREAT_CUTOFF = 70;
export const AMAZING_CUTOFF = 90;
/** The sun-color model's design target: about this share of events reach each cutoff. */
export const SUN_DESIGN_TARGET = { great: 0.2, amazing: 0.1 } as const;
/** A "call" is the latest forecast made at least this long before the event. */
export const CALL_MIN_LEAD_MIN = 60;
/** A radar frame older than this (minutes) is not a current observation
 *  (PRECIP_RADAR_STALE_MINUTES in lib/sources/precipRadar.ts). */
export const RADAR_MAX_AGE_MIN = 25;
/** Radar rain rate above this (mm/hr) counts as rain. 0 = any rain at all. */
export const RADAR_RAIN_MM_HR = 0;
/** A beach archiving fewer rows than this per day is listed in data health. */
export const MIN_ROWS_PER_DAY = 12;
/** A cam with no capture for this long is listed in data health. */
export const CAM_STALE_HOURS = 6;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// --- Small helpers ----------------------------------------------------------

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round1 = (v: number | null): number | null => (v == null ? null : Math.round(v * 10) / 10);
const share = (n: number, d: number): number | null => (d > 0 ? n / d : null);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** "collecting — 3 of 10 pairs". */
export function collectingText(have: number, need: number, unit: string): string {
  return `collecting — ${have} of ${need} ${unit}`;
}

// ============================================================================
// 1. Sunrise / sunset color
// ============================================================================

export interface SunPredictionRow {
  slug: string;
  event_kind: "sunrise" | "sunset";
  event_iso: string;
  as_of_hour_utc: string;
  lead_minutes: number;
  score: number | null;
  band: string | null;
  algo_version: string;
  observed_score: number | null;
  observed_source: string | null;
}

/** lib/sunQuality.ts band cutoffs: dud <20, plain 20-44, good 45-69, vivid 70-89, epic 90+. */
export function sunBandOf(score: number): "dud" | "plain" | "good" | "vivid" | "epic" {
  if (score >= 90) return "epic";
  if (score >= 70) return "vivid";
  if (score >= 45) return "good";
  if (score >= 20) return "plain";
  return "dud";
}

export const LEAD_BUCKETS = ["<0", "0–2h", "2–6h", "6–12h", "12–24h", ">24h"] as const;
export type LeadBucket = (typeof LEAD_BUCKETS)[number];

/** `<0` is the post-event golden window; the others are time before the event. */
export function leadBucketOf(leadMinutes: number): LeadBucket {
  if (leadMinutes < 0) return "<0";
  if (leadMinutes < 120) return "0–2h";
  if (leadMinutes < 360) return "2–6h";
  if (leadMinutes < 720) return "6–12h";
  if (leadMinutes < 1440) return "12–24h";
  return ">24h";
}

export interface ErrorGroup {
  key: string;
  /** Distinct events in the group (the unit the minimum applies to). */
  events: number;
  /** Forecast rows in the group. */
  rows: number;
  /** Mean absolute error, points. null while collecting. */
  mae: number | null;
  /** Mean (predicted − observed), points. null while collecting. */
  bias: number | null;
  /** "collecting — N of 10 pairs" while under the minimum, else null. */
  collecting: string | null;
}

export interface CallCell {
  cutoff: number;
  hits: number;
  falseAlarms: number;
  misses: number;
  correctNegatives: number;
  /** Events we called at or above the cutoff. */
  calls: number;
  /** Events that really reached the cutoff. */
  observedAtOrAbove: number;
  /** Of our calls, the share that really reached the cutoff. */
  hitRate: number | null;
  /** Of our calls, the share that did not. */
  falseAlarmRate: number | null;
  /** Of the events that really reached the cutoff, the share we did not call. */
  missRate: number | null;
}

export interface SunDistRow {
  key: string;
  /** Events with a call (any, paired or not). */
  allEvents: number;
  predGreatAll: number | null;
  predAmazingAll: number | null;
  /** Events with a call AND an observation. */
  pairedEvents: number;
  predGreatPaired: number | null;
  predAmazingPaired: number | null;
  obsGreat: number | null;
  obsAmazing: number | null;
}

export interface SunColorResult {
  /** Distinct events that have at least one scored forecast row. */
  events: number;
  /** Events with an observation, and their forecast rows. */
  pairedEvents: number;
  pairedRows: number;
  min: number;
  ready: boolean;
  collecting: string | null;
  overall: ErrorGroup;
  byBand: ErrorGroup[];
  byLead: ErrorGroup[];
  byBeach: ErrorGroup[];
  byAlgo: ErrorGroup[];
  /** By how the cam looked at the sky: toward the sun ("solar") or away
   *  ("antisolar"). The two read different things, so they are kept apart. */
  byView: ErrorGroup[];
  calls: {
    /** Paired events that have a call (a forecast made >= 60 min ahead). */
    events: number;
    ready: boolean;
    collecting: string | null;
    great: CallCell;
    amazing: CallCell;
  };
  distribution: {
    target: { great: number; amazing: number };
    overall: SunDistRow;
    byBeach: SunDistRow[];
  };
}

const eventKey = (r: Pick<SunPredictionRow, "slug" | "event_kind" | "event_iso">) =>
  `${r.slug}|${r.event_kind}|${r.event_iso}`;

function errorGroup(key: string, rows: SunPredictionRow[], min: number): ErrorGroup {
  const events = new Set(rows.map(eventKey)).size;
  const base = { key, events, rows: rows.length };
  if (events < min) {
    return { ...base, mae: null, bias: null, collecting: collectingText(events, min, "pairs") };
  }
  const errs = rows.map((r) => (r.score as number) - (r.observed_score as number));
  return {
    ...base,
    mae: round1(mean(errs.map(Math.abs))),
    bias: round1(mean(errs)),
    collecting: null,
  };
}

function groupBy<T>(rows: T[], keyOf: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = keyOf(r);
    const a = m.get(k);
    if (a) a.push(r);
    else m.set(k, [r]);
  }
  return m;
}

/** An event's call: its latest scored forecast made >= 60 min before it. */
function callOf(eventRows: SunPredictionRow[]): SunPredictionRow | null {
  let best: SunPredictionRow | null = null;
  for (const r of eventRows) {
    if (!finite(r.score) || r.lead_minutes < CALL_MIN_LEAD_MIN) continue;
    if (!best || r.as_of_hour_utc > best.as_of_hour_utc) best = r;
  }
  return best;
}

function observedOf(eventRows: SunPredictionRow[], call: SunPredictionRow | null): number | null {
  if (call && finite(call.observed_score)) return call.observed_score;
  const row = eventRows.find((r) => finite(r.observed_score));
  return row ? (row.observed_score as number) : null;
}

function callCell(cutoff: number, pairs: { pred: number; obs: number }[], ready: boolean): CallCell {
  let hits = 0;
  let falseAlarms = 0;
  let misses = 0;
  let correctNegatives = 0;
  for (const p of pairs) {
    const called = p.pred >= cutoff;
    const real = p.obs >= cutoff;
    if (called && real) hits++;
    else if (called) falseAlarms++;
    else if (real) misses++;
    else correctNegatives++;
  }
  const calls = hits + falseAlarms;
  const observedAtOrAbove = hits + misses;
  return {
    cutoff,
    hits,
    falseAlarms,
    misses,
    correctNegatives,
    calls,
    observedAtOrAbove,
    hitRate: ready ? share(hits, calls) : null,
    falseAlarmRate: ready ? share(falseAlarms, calls) : null,
    missRate: ready ? share(misses, observedAtOrAbove) : null,
  };
}

function distRow(
  key: string,
  events: { pred: number; obs: number | null }[],
  min: number,
): SunDistRow {
  const paired = events.filter((e): e is { pred: number; obs: number } => e.obs != null);
  const allOk = events.length >= min;
  const pairedOk = paired.length >= min;
  const at = (xs: number[], cutoff: number) => share(xs.filter((x) => x >= cutoff).length, xs.length);
  const preds = events.map((e) => e.pred);
  const pairedPreds = paired.map((e) => e.pred);
  const obs = paired.map((e) => e.obs);
  return {
    key,
    allEvents: events.length,
    predGreatAll: allOk ? at(preds, GREAT_CUTOFF) : null,
    predAmazingAll: allOk ? at(preds, AMAZING_CUTOFF) : null,
    pairedEvents: paired.length,
    predGreatPaired: pairedOk ? at(pairedPreds, GREAT_CUTOFF) : null,
    predAmazingPaired: pairedOk ? at(pairedPreds, AMAZING_CUTOFF) : null,
    obsGreat: pairedOk ? at(obs, GREAT_CUTOFF) : null,
    obsAmazing: pairedOk ? at(obs, AMAZING_CUTOFF) : null,
  };
}

/** "sun-cam:ftl-elbo-beach-cam:solar" -> "solar"; anything else -> "other". */
export function sunViewOf(observedSource: string | null): string {
  const m = /^sun-cam:[^:]*:(solar|antisolar)$/.exec(observedSource ?? "");
  return m ? m[1] : "other";
}

/**
 * Sunrise/sunset color: forecast rows against the sky the cams saw.
 * `rows` may mix paired rows (observed_score set) and unpaired ones; the
 * unpaired call rows only feed the predicted-distribution comparison. With
 * `opts.nowMs`, events that have not happened yet are left out of that
 * comparison (their last forecast is not final).
 */
export function sunColorMetrics(
  rows: SunPredictionRow[],
  opts: { min?: number; nowMs?: number } = {},
): SunColorResult {
  const min = opts.min ?? MIN_SUN_EVENTS;
  const scored = rows.filter((r) => finite(r.score));
  const byEvent = groupBy(scored, eventKey);
  const paired = scored.filter((r) => finite(r.observed_score));
  const pairedEvents = new Set(paired.map(eventKey)).size;
  const ready = pairedEvents >= min;

  const bandOf = (r: SunPredictionRow) => r.band ?? sunBandOf(r.score as number);
  const byBandMap = groupBy(paired, bandOf);
  const byBand = (["dud", "plain", "good", "vivid", "epic"] as const)
    .filter((b) => byBandMap.has(b))
    .map((b) => errorGroup(b, byBandMap.get(b)!, min));

  const byLeadMap = groupBy(paired, (r) => leadBucketOf(r.lead_minutes));
  const byLead = LEAD_BUCKETS.filter((b) => byLeadMap.has(b)).map((b) => errorGroup(b, byLeadMap.get(b)!, min));

  const byBeach = [...groupBy(paired, (r) => r.slug)]
    .map(([k, v]) => errorGroup(k, v, min))
    .sort((a, b) => b.events - a.events || (a.key < b.key ? -1 : 1));

  const byAlgo = [...groupBy(paired, (r) => r.algo_version)]
    .map(([k, v]) => errorGroup(k, v, min))
    .sort((a, b) => (a.key < b.key ? -1 : 1));

  const byView = [...groupBy(paired, (r) => sunViewOf(r.observed_source))]
    .map(([k, v]) => errorGroup(k, v, min))
    .sort((a, b) => (a.key < b.key ? -1 : 1));

  // The call analysis and the distribution work per EVENT.
  const perEvent: { slug: string; pred: number; obs: number | null }[] = [];
  for (const evRows of byEvent.values()) {
    const call = callOf(evRows);
    if (!call) continue;
    if (opts.nowMs != null && Date.parse(call.event_iso) > opts.nowMs) continue;
    perEvent.push({ slug: call.slug, pred: call.score as number, obs: observedOf(evRows, call) });
  }
  const pairedCalls = perEvent.filter((e): e is { slug: string; pred: number; obs: number } => e.obs != null);
  const callsReady = pairedCalls.length >= min;

  const beaches = [...new Set(perEvent.map((e) => e.slug))].sort();
  return {
    events: byEvent.size,
    pairedEvents,
    pairedRows: paired.length,
    min,
    ready,
    collecting: ready ? null : collectingText(pairedEvents, min, "pairs"),
    overall: errorGroup("all", paired, min),
    byBand,
    byLead,
    byBeach,
    byAlgo,
    byView,
    calls: {
      events: pairedCalls.length,
      ready: callsReady,
      collecting: callsReady ? null : collectingText(pairedCalls.length, min, "pairs"),
      great: callCell(GREAT_CUTOFF, pairedCalls, callsReady),
      amazing: callCell(AMAZING_CUTOFF, pairedCalls, callsReady),
    },
    distribution: {
      target: { ...SUN_DESIGN_TARGET },
      overall: distRow("all", perEvent, min),
      byBeach: beaches.map((b) =>
        distRow(
          b,
          perEvent.filter((e) => e.slug === b),
          min,
        ),
      ),
    },
  };
}

// ============================================================================
// Hourly archive rows (shared by the rain, window, safety and health metrics)
// ============================================================================

export interface RainBlock {
  nowcast: "dry" | "raining" | null;
  radarMmHr: number | null;
  radarDry: 0 | 1 | null;
  /** Minutes until the nowcast flips; null = no change in the next 2 h. */
  changeInMin?: number | null;
  radarAgeMin?: number | null;
}
export interface WindowBlock {
  startIso: string;
  endIso: string;
  score: number;
}
export interface OutlookBlock {
  days: { date: string; peak: number | null; start?: string | null; end?: string | null; score?: number | null }[];
}
export interface FlagsBlock {
  colors: (FlagColor | string)[];
  status?: string | null;
}
export interface SafetyBlock {
  swim: string;
  surf?: string;
}
export interface RipBlock {
  level?: string;
  source?: string;
  alert?: 0 | 1;
}

/** One `beach_hourly` row with the extra_json blocks the scorecard reads, parsed. */
export interface HourlyRow {
  slug: string;
  hour_utc: string;
  local_date: string;
  local_hour: number;
  score: number | null;
  /** Whether extra_json was non-null. */
  has_extra: boolean;
  window?: WindowBlock | null;
  rain?: RainBlock | null;
  flags?: FlagsBlock | null;
  outlook?: OutlookBlock | null;
  safety?: SafetyBlock | null;
  rip?: RipBlock | null;
}

// ============================================================================
// 2. Rain nowcast vs radar
// ============================================================================

export type RainRow = Pick<HourlyRow, "slug" | "hour_utc" | "rain">;

export interface RainConfusion {
  /** Nowcast "raining" and radar rain followed. */
  hits: number;
  /** Nowcast "raining" and no radar rain followed. */
  falseAlarms: number;
  /** Nowcast "dry" and radar rain followed. */
  misses: number;
  /** Nowcast "dry" and no radar rain followed. */
  correctDry: number;
  rainCalls: number;
  dryCalls: number;
  /** Of the "raining" calls, the share followed by radar rain. */
  hitRate: number | null;
  /** Of the "raining" calls, the share with no radar rain after. */
  falseAlarmRate: number | null;
  /** Of the times radar rain followed, the share the nowcast called dry. */
  missRate: number | null;
  /** Of the "dry" calls, the share that got rained on. */
  dryRainedOnRate: number | null;
}

export interface RainResult {
  /** Rows with a nowcast call. */
  calls: number;
  /** Calls with radar truth at both +1 h and +2 h — the scored set. */
  scored: number;
  min: number;
  ready: boolean;
  collecting: string | null;
  next1h: RainConfusion;
  next2h: RainConfusion;
  /** The user-facing promise: nowcast "dry" with no change expected in 2 h
   *  ("Dry for the next 2+ hrs"). Scored over the next 2 h. */
  dryPromise: { n: number; rainedOn: number; rate: number | null };
}

/** Radar says rain (true), says dry (false), or cannot say (null). */
export function radarRainAt(r: RainBlock | null | undefined, thresholdMmHr = RADAR_RAIN_MM_HR): boolean | null {
  if (!r) return null;
  const ageOk = !finite(r.radarAgeMin) || r.radarAgeMin <= RADAR_MAX_AGE_MIN;
  if (r.radarDry === 0) return true;
  if (finite(r.radarMmHr) && ageOk && r.radarMmHr > thresholdMmHr) return true;
  if (r.radarDry === 1) return false;
  if (finite(r.radarMmHr) && ageOk) return false;
  return null;
}

function confusion(items: { raining: boolean; rain: boolean }[], ready: boolean): RainConfusion {
  let hits = 0;
  let falseAlarms = 0;
  let misses = 0;
  let correctDry = 0;
  for (const i of items) {
    if (i.raining && i.rain) hits++;
    else if (i.raining) falseAlarms++;
    else if (i.rain) misses++;
    else correctDry++;
  }
  const rainCalls = hits + falseAlarms;
  const dryCalls = misses + correctDry;
  return {
    hits,
    falseAlarms,
    misses,
    correctDry,
    rainCalls,
    dryCalls,
    hitRate: ready ? share(hits, rainCalls) : null,
    falseAlarmRate: ready ? share(falseAlarms, rainCalls) : null,
    missRate: ready ? share(misses, hits + misses) : null,
    dryRainedOnRate: ready ? share(misses, dryCalls) : null,
  };
}

/**
 * Score the rain nowcast against the radar one and two hours later. A row is
 * scored when it has a nowcast and the same beach has radar truth at hour+1
 * and hour+2. Radar rain = rate above `thresholdMmHr`, or a fresh frame that is
 * not "confident dry" (see RainBlock.radarDry).
 */
export function rainMetrics(
  rows: RainRow[],
  opts: { min?: number; thresholdMmHr?: number } = {},
): RainResult {
  const min = opts.min ?? MIN_RAIN_CALLS;
  const thr = opts.thresholdMmHr ?? RADAR_RAIN_MM_HR;
  const at = new Map<string, RainBlock>();
  for (const r of rows) {
    const ms = Date.parse(r.hour_utc);
    if (r.rain && Number.isFinite(ms)) at.set(`${r.slug}|${ms}`, r.rain);
  }

  let calls = 0;
  const items1: { raining: boolean; rain: boolean }[] = [];
  const items2: { raining: boolean; rain: boolean }[] = [];
  let promiseN = 0;
  let promiseRainedOn = 0;
  for (const r of rows) {
    const ms = Date.parse(r.hour_utc);
    if (!r.rain?.nowcast || !Number.isFinite(ms)) continue;
    calls++;
    const t1 = radarRainAt(at.get(`${r.slug}|${ms + HOUR_MS}`), thr);
    const t2 = radarRainAt(at.get(`${r.slug}|${ms + 2 * HOUR_MS}`), thr);
    if (t1 == null || t2 == null) continue;
    const raining = r.rain.nowcast === "raining";
    items1.push({ raining, rain: t1 });
    items2.push({ raining, rain: t1 || t2 });
    if (!raining && r.rain.changeInMin === null) {
      promiseN++;
      if (t1 || t2) promiseRainedOn++;
    }
  }

  const scored = items2.length;
  const ready = scored >= min;
  return {
    calls,
    scored,
    min,
    ready,
    collecting: ready ? null : collectingText(scored, min, "scored calls"),
    next1h: confusion(items1, ready),
    next2h: confusion(items2, ready),
    dryPromise: { n: promiseN, rainedOn: promiseRainedOn, rate: ready ? share(promiseRainedOn, promiseN) : null },
  };
}

// ============================================================================
// 3. Best window and the multi-day outlook
// ============================================================================

export type WindowRow = Pick<HourlyRow, "slug" | "local_date" | "local_hour" | "hour_utc" | "score" | "window"> & {
  outlook?: OutlookBlock | null;
};

export interface OutlookLead {
  leadDays: number;
  /** (beach, day) pairs scored at this lead. */
  days: number;
  mae: number | null;
  bias: number | null;
  collecting: string | null;
}

export interface WindowResult {
  /** Finished (beach, day) pairs with >= 8 scored daylight hours. */
  daysWithHours: number;
  /** Of those, the days that also have a window predicted by 10 AM local. */
  daysScored: number;
  min: number;
  ready: boolean;
  collecting: string | null;
  skipped: { incompleteDay: number; tooFewHours: number; noEarlyWindow: number };
  /** Mean length of the predicted windows, hours. */
  meanWindowHours: number | null;
  /** Mean realized score inside the predicted window. */
  realizedInWindow: number | null;
  /** Mean of the realized best contiguous 3-hour stretch each day. */
  realizedBest3h: number | null;
  /** realizedBest3h − realizedInWindow: points left on the table. */
  gapPts: number | null;
  /** Share of days the realized peak hour fell inside the predicted window. */
  peakInWindowShare: number | null;
  /** Share of days the window's predicted score was within 10 points of the
   *  realized mean inside it. */
  within10Share: number | null;
  /** Mean (window score − realized mean inside it), points. */
  windowScoreBias: number | null;
  /** Mean local hour the scored window prediction was made at. */
  meanPredictedAtHour: number | null;
  outlook: OutlookLead[];
}

/** Daylight hours [from, to) for one beach-day. null = unknown (skip the day). */
export type DaylightFn = (slug: string, localDate: string) => { from: number; to: number } | null;
const defaultDaylight: DaylightFn = () => ({ from: 7, to: 19 });

const MIN_DAYLIGHT_HOURS = 8;
const EARLY_HOUR_MAX = 10;

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/** Highest mean of any 3 consecutive local hours; null when no such run. */
function bestContiguous3(byHour: Map<number, number>): number | null {
  let best: number | null = null;
  for (const h of byHour.keys()) {
    const a = byHour.get(h)!;
    const b = byHour.get(h + 1);
    const c = byHour.get(h + 2);
    if (b == null || c == null) continue;
    const m = (a + b + c) / 3;
    if (best == null || m > best) best = m;
  }
  return best;
}

export function windowMetrics(
  rows: WindowRow[],
  opts: { min?: number; daylight?: DaylightFn } = {},
): WindowResult {
  const min = opts.min ?? MIN_WINDOW_DAYS;
  const daylightOf = opts.daylight ?? defaultDaylight;

  // Group by beach, then local date.
  const bySlug = groupBy(rows, (r) => r.slug);
  type Day = { rows: WindowRow[]; scores: Map<number, { score: number; hourMs: number }> };
  const days = new Map<string, Map<string, Day>>(); // slug -> date -> day
  const lastDate = new Map<string, string>();
  for (const [slug, rs] of bySlug) {
    const m = new Map<string, Day>();
    let last = "";
    for (const r of rs) {
      if (r.local_date > last) last = r.local_date;
      let d = m.get(r.local_date);
      if (!d) {
        d = { rows: [], scores: new Map() };
        m.set(r.local_date, d);
      }
      d.rows.push(r);
    }
    for (const [date, d] of m) {
      const dl = daylightOf(slug, date);
      if (!dl) continue;
      for (const r of d.rows.sort((a, b) => (a.hour_utc < b.hour_utc ? -1 : 1))) {
        if (!finite(r.score) || r.local_hour < dl.from || r.local_hour >= dl.to) continue;
        d.scores.set(r.local_hour, { score: r.score, hourMs: Date.parse(r.hour_utc) });
      }
    }
    days.set(slug, m);
    lastDate.set(slug, last);
  }

  const skipped = { incompleteDay: 0, tooFewHours: 0, noEarlyWindow: 0 };
  /** Realized daylight scores per finished (slug, date). */
  const finished = new Map<string, { slug: string; date: string; day: Day }>();
  for (const [slug, m] of days) {
    for (const [date, day] of m) {
      if (date >= (lastDate.get(slug) as string)) {
        skipped.incompleteDay++;
        continue;
      }
      if (day.scores.size < MIN_DAYLIGHT_HOURS) {
        skipped.tooFewHours++;
        continue;
      }
      finished.set(`${slug}|${date}`, { slug, date, day });
    }
  }

  /** The row to read forecasts from: earliest archive hour at or before 10 AM local that has `pick`. */
  const earliestRow = (day: Day, has: (r: WindowRow) => boolean): WindowRow | null => {
    let best: WindowRow | null = null;
    for (const r of day.rows) {
      if (r.local_hour > EARLY_HOUR_MAX || !has(r)) continue;
      if (!best || r.hour_utc < best.hour_utc) best = r;
    }
    return best;
  };

  const inWin: number[] = [];
  const best3: number[] = [];
  const winLen: number[] = [];
  const predAt: number[] = [];
  const bias: number[] = [];
  let peakIn = 0;
  let within10 = 0;
  for (const { day } of finished.values()) {
    const row = earliestRow(day, (r) => r.window != null);
    if (!row || !row.window) {
      skipped.noEarlyWindow++;
      continue;
    }
    const startMs = Date.parse(row.window.startIso);
    const endMs = Date.parse(row.window.endIso);
    const hours = [...day.scores.entries()].map(([h, v]) => ({ h, ...v }));
    const inside = hours.filter((x) => x.hourMs >= startMs && x.hourMs < endMs);
    const b3 = bestContiguous3(new Map(hours.map((x) => [x.h, x.score])));
    if (!inside.length || b3 == null || !finite(row.window.score)) {
      skipped.noEarlyWindow++;
      continue;
    }
    const realized = mean(inside.map((x) => x.score)) as number;
    const peak = Math.max(...hours.map((x) => x.score));
    inWin.push(realized);
    best3.push(b3);
    winLen.push((endMs - startMs) / HOUR_MS);
    predAt.push(row.local_hour);
    bias.push(row.window.score - realized);
    if (inside.some((x) => x.score === peak)) peakIn++;
    if (Math.abs(row.window.score - realized) <= 10) within10++;
  }

  const daysScored = inWin.length;
  const ready = daysScored >= min;

  // Outlook: the peak promised N days ahead vs the realized peak that day.
  const errsByLead = new Map<number, number[]>();
  for (const [slug, m] of days) {
    for (const [date, day] of m) {
      const row = earliestRow(day, (r) => (r.outlook?.days?.length ?? 0) > 0);
      if (!row?.outlook) continue;
      for (const o of row.outlook.days) {
        const lead = daysBetween(date, o.date);
        if (lead < 1 || lead > 6 || !finite(o.peak)) continue;
        const target = finished.get(`${slug}|${o.date}`);
        if (!target) continue;
        const realizedPeak = Math.max(...[...target.day.scores.values()].map((v) => v.score));
        const a = errsByLead.get(lead) ?? [];
        a.push(o.peak - realizedPeak);
        errsByLead.set(lead, a);
      }
    }
  }
  const outlook: OutlookLead[] = [...errsByLead.keys()]
    .sort((a, b) => a - b)
    .map((lead) => {
      const errs = errsByLead.get(lead)!;
      const ok = errs.length >= min;
      return {
        leadDays: lead,
        days: errs.length,
        mae: ok ? round1(mean(errs.map(Math.abs))) : null,
        bias: ok ? round1(mean(errs)) : null,
        collecting: ok ? null : collectingText(errs.length, min, "days"),
      };
    });

  const r1 = (xs: number[]) => (ready ? round1(mean(xs)) : null);
  const realizedInWindow = r1(inWin);
  const realizedBest3h = r1(best3);
  return {
    daysWithHours: finished.size,
    daysScored,
    min,
    ready,
    collecting: ready ? null : collectingText(daysScored, min, "days"),
    skipped,
    meanWindowHours: r1(winLen),
    realizedInWindow,
    realizedBest3h,
    gapPts: realizedInWindow != null && realizedBest3h != null ? round1(realizedBest3h - realizedInWindow) : null,
    peakInWindowShare: ready ? share(peakIn, daysScored) : null,
    within10Share: ready ? share(within10, daysScored) : null,
    windowScoreBias: r1(bias),
    meanPredictedAtHour: r1(predAt),
    outlook,
  };
}

// ============================================================================
// 4. Safety message vs lifeguard flags
// ============================================================================

export type SafetyRow = Pick<HourlyRow, "slug" | "hour_utc" | "safety" | "flags" | "rip">;

export const FLAG_ORDER = ["double-red", "red", "yellow", "green", "purple"] as const;
export type DominantFlag = (typeof FLAG_ORDER)[number] | "unknown";
export const SWIM_LEVELS = ["safe", "caution", "stay-out"] as const;

/** The flag that decides the hour: the most serious of the posted colors. */
export function dominantFlag(colors: readonly string[] | null | undefined): DominantFlag {
  const set = new Set(colors ?? []);
  for (const f of FLAG_ORDER) if (set.has(f)) return f;
  return "unknown";
}

export interface SafetyResult {
  /** Hours with a swim level and a known flag color. */
  hours: number;
  min: number;
  ready: boolean;
  collecting: string | null;
  /** flag -> swim level -> hours. */
  crossTab: Record<string, Record<string, number>>;
  /** Hours with no red or double-red flag and a yellow or green flag. Red
   *  flags directly set "stay-out" (lib/safetyLine.ts), so those hours say
   *  nothing about our own judgement. */
  informative: {
    hours: number;
    ready: boolean;
    collecting: string | null;
    yellowHours: number;
    greenHours: number;
    /** Yellow and we said caution or stay-out, or green and we said safe. */
    agreeHours: number;
    agreementRate: number | null;
    /** A yellow flag flew and we said "safe". */
    yellowWeSaidSafe: number;
    /** A green flag flew and we said caution or stay-out. */
    greenWeCautioned: number;
    /** Why we cautioned on those green hours (from the archived rip block). */
    greenReasons: { reason: string; hours: number }[];
  };
}

function cautionReason(rip: RipBlock | null | undefined): string {
  if (!rip) return "no rip detail archived";
  const active = rip.source === "alert" || rip.source === "model" || rip.source === "forecast";
  if (active && (rip.alert === 1 || rip.source === "alert")) return "rip current warning";
  if (active && rip.level === "high") return "high rip risk";
  if (active && rip.level === "moderate") return "moderate rip risk";
  return "other (waves, thunder or an advisory)";
}

export function safetyMetrics(rows: SafetyRow[], min = MIN_SAFETY_HOURS): SafetyResult {
  const crossTab: Record<string, Record<string, number>> = {};
  for (const f of FLAG_ORDER) crossTab[f] = Object.fromEntries(SWIM_LEVELS.map((l) => [l, 0]));
  let hours = 0;
  let infHours = 0;
  let yellowHours = 0;
  let greenHours = 0;
  let agree = 0;
  let yellowSafe = 0;
  let greenCaution = 0;
  const reasons = new Map<string, number>();
  for (const r of rows) {
    const swim = r.safety?.swim;
    if (!swim) continue;
    const flag = dominantFlag(r.flags?.colors);
    if (flag === "unknown") continue;
    hours++;
    const row = crossTab[flag];
    row[swim] = (row[swim] ?? 0) + 1;
    if (flag !== "yellow" && flag !== "green") continue;
    infHours++;
    if (flag === "yellow") {
      yellowHours++;
      if (swim === "safe") yellowSafe++;
      else agree++;
    } else {
      greenHours++;
      if (swim === "safe") agree++;
      else {
        greenCaution++;
        const k = cautionReason(r.rip);
        reasons.set(k, (reasons.get(k) ?? 0) + 1);
      }
    }
  }
  const ready = hours >= min;
  const infReady = infHours >= min;
  return {
    hours,
    min,
    ready,
    collecting: ready ? null : collectingText(hours, min, "hours"),
    crossTab,
    informative: {
      hours: infHours,
      ready: infReady,
      collecting: infReady ? null : collectingText(infHours, min, "hours"),
      yellowHours,
      greenHours,
      agreeHours: agree,
      agreementRate: infReady ? share(agree, infHours) : null,
      yellowWeSaidSafe: yellowSafe,
      greenWeCautioned: greenCaution,
      greenReasons: [...reasons].map(([reason, h]) => ({ reason, hours: h })).sort((a, b) => b.hours - a.hours),
    },
  };
}

// ============================================================================
// 5. Data health
// ============================================================================

export type HealthRow = Pick<
  HourlyRow,
  "slug" | "hour_utc" | "local_date" | "has_extra" | "window" | "rain" | "flags" | "outlook" | "safety" | "rip"
> & { local_hour?: number };

export interface HealthInput {
  rows: HealthRow[];
  /** Latest cam_observations capture per beach. */
  camLatest: { slug: string; captured_at_utc: string }[] | null;
  /** sun_event_observations summary. */
  sunObs: { count: number; latestScoredAt: string | null; latestEventIso: string | null } | null;
  /** sun_event_predictions rows archived in the last 24 h (null = unknown). */
  sunPredictionsLast24h: number | null;
  nowMs: number;
  /** Optional tier lookup ("curated" archives all 24 hours, "auto" daylight only). */
  tierOf?: (slug: string) => "curated" | "auto" | undefined;
  /** Optional rows a day a beach should have (24 for curated, its daylight hours for auto). */
  expectedPerDay?: (slug: string) => number | undefined;
}

export interface BeachRowsPerDay {
  slug: string;
  tier: "curated" | "auto" | null;
  /** Finished days counted. */
  days: number;
  perDay: number;
  /** Fewest rows on any counted day. */
  minDay: number;
  /** Rows a day this beach should have, when known. */
  expected: number | null;
}

export interface HealthResult {
  beaches: number;
  perBeach: BeachRowsPerDay[];
  /** Beaches averaging fewer than 12 rows a day. */
  underMin: BeachRowsPerDay[];
  /**
   * Local hours that go missing on the beaches meant to archive all 24 hours
   * (curated; or, with no tier lookup, any beach averaging 18+ rows a day).
   * Lists each hour with rows on under 80% of those beach-days. null when no
   * such beach has a finished day.
   */
  hourGaps: { beaches: number; days: number; missing: { hour: number; pct: number }[] } | null;
  extra: {
    rows: number;
    /** Share of the window's rows with extra_json. */
    windowPct: number | null;
    last24hPct: number | null;
    /** Share of rows since the first one that has extra_json. */
    sinceFirstPct: number | null;
    firstHourUtc: string | null;
  };
  /** Share of the last 24 h's extra_json rows carrying each block. */
  blockPct24h: Record<string, number | null>;
  cams: { slug: string; latest: string; ageHours: number }[] | null;
  camsStale: { slug: string; latest: string; ageHours: number }[];
  sunObs: HealthInput["sunObs"];
  sunPredictionsLast24h: number | null;
}

const pct = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

export function dataHealth(input: HealthInput): HealthResult {
  const { nowMs } = input;
  const since7 = nowMs - 7 * DAY_MS;
  const since24 = nowMs - DAY_MS;
  const rows7 = input.rows.filter((r) => Date.parse(r.hour_utc) > since7);

  // Rows per day per beach, over days that are over: not the window's first
  // (partial) date and not the beach's latest (still filling).
  const perBeach: BeachRowsPerDay[] = [];
  const doneDays = new Map<string, { dates: string[]; hoursByDate: Map<string, Set<number>> }>();
  for (const [slug, rs] of groupBy(rows7, (r) => r.slug)) {
    const counts = new Map<string, number>();
    const hoursByDate = new Map<string, Set<number>>();
    for (const r of rs) {
      counts.set(r.local_date, (counts.get(r.local_date) ?? 0) + 1);
      if (finite(r.local_hour)) {
        const set = hoursByDate.get(r.local_date) ?? new Set<number>();
        set.add(r.local_hour);
        hoursByDate.set(r.local_date, set);
      }
    }
    const dates = [...counts.keys()].sort();
    const done = dates.slice(1, -1);
    const use = done.length ? done : dates.length > 1 ? dates.slice(0, -1) : dates;
    const vals = use.map((d) => counts.get(d) as number);
    doneDays.set(slug, { dates: use, hoursByDate });
    perBeach.push({
      slug,
      tier: input.tierOf?.(slug) ?? null,
      days: use.length,
      perDay: round1(mean(vals)) as number,
      minDay: Math.min(...vals),
      expected: input.expectedPerDay?.(slug) ?? null,
    });
  }
  const cover = (b: BeachRowsPerDay): number => (b.expected ? b.perDay / b.expected : b.perDay / 24);
  perBeach.sort((a, b) => cover(a) - cover(b) || (a.slug < b.slug ? -1 : 1));

  // Which local hours go missing on the beaches that should have all 24?
  const fullDay = perBeach.filter((b) => (b.tier ? b.tier === "curated" : b.perDay >= 18));
  let beachDays = 0;
  let sawHour = false;
  const hourCounts = new Array<number>(24).fill(0);
  for (const b of fullDay) {
    const info = doneDays.get(b.slug);
    if (!info) continue;
    for (const d of info.dates) {
      beachDays++;
      for (const h of info.hoursByDate.get(d) ?? []) {
        sawHour = true;
        if (h >= 0 && h < 24) hourCounts[h]++;
      }
    }
  }
  const hourGaps: HealthResult["hourGaps"] =
    beachDays > 0 && sawHour
      ? {
          beaches: fullDay.length,
          days: beachDays,
          missing: hourCounts
            .map((n, hour) => ({ hour, pct: Math.round((n / beachDays) * 1000) / 10 }))
            .filter((x) => x.pct < 80),
        }
      : null;

  const all = input.rows;
  const withExtra = all.filter((r) => r.has_extra);
  const firstExtra = withExtra.reduce<string | null>((m, r) => (m == null || r.hour_utc < m ? r.hour_utc : m), null);
  const last24 = all.filter((r) => Date.parse(r.hour_utc) > since24);
  const sinceFirst = firstExtra ? all.filter((r) => r.hour_utc >= firstExtra) : [];

  const last24Extra = last24.filter((r) => r.has_extra);
  const blocks = ["window", "rain", "flags", "outlook", "safety", "rip"] as const;
  const blockPct24h: Record<string, number | null> = {};
  for (const b of blocks) blockPct24h[b] = pct(last24Extra.filter((r) => r[b] != null).length, last24Extra.length);

  let cams: HealthResult["cams"] = null;
  if (input.camLatest) {
    cams = input.camLatest
      .map((c) => ({
        slug: c.slug,
        latest: c.captured_at_utc,
        ageHours: round1((nowMs - Date.parse(c.captured_at_utc)) / HOUR_MS) as number,
      }))
      .sort((a, b) => b.ageHours - a.ageHours);
  }

  return {
    beaches: perBeach.length,
    perBeach,
    underMin: perBeach.filter((b) => b.perDay < MIN_ROWS_PER_DAY),
    hourGaps,
    extra: {
      rows: withExtra.length,
      windowPct: pct(withExtra.length, all.length),
      last24hPct: pct(last24Extra.length, last24.length),
      sinceFirstPct: pct(sinceFirst.filter((r) => r.has_extra).length, sinceFirst.length),
      firstHourUtc: firstExtra,
    },
    blockPct24h,
    cams,
    camsStale: (cams ?? []).filter((c) => c.ageHours > CAM_STALE_HOURS),
    sunObs: input.sunObs,
    sunPredictionsLast24h: input.sunPredictionsLast24h,
  };
}
