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

import type { OfflineCam } from "@/lib/camStatus";
import type { FlagColor } from "@/lib/types";

// --- Minimum samples --------------------------------------------------------

export const MIN_SUN_EVENTS = 10;
export const MIN_RAIN_CALLS = 50;
export const MIN_WINDOW_DAYS = 10;
/** Safety vs flags counts beach-days (one flag posting per beach per day), not hours. */
export const MIN_SAFETY_BEACH_DAYS = 30;
/** A published rate needs at least this many cases in ITS OWN denominator. */
export const MIN_RATE_CALLS = 10;
/** The "Dry for the next 2+ hrs" headline needs at least this many such calls. */
export const MIN_DRY_PROMISE_CALLS = 30;

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

/**
 * A published rate. It is gated on ITS OWN denominator (`n`): below `min`, or
 * when the caller's wider gate (`open`) is shut, `value` is null and
 * `collecting` reads "n=<count>, collecting".
 */
export interface Rate {
  value: number | null;
  /** The denominator the rate is a share of. */
  n: number;
  min: number;
  collecting: string | null;
}

export function rateOf(numerator: number, denominator: number, min: number, open = true): Rate {
  const ok = open && denominator >= min && denominator > 0;
  return {
    value: ok ? numerator / denominator : null,
    n: denominator,
    min,
    collecting: ok ? null : `n=${denominator}, collecting`,
  };
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
  /** breakdown_json.satellite.antiMidHighPct: the satellite's mid + high cloud along the
   *  path AWAY from the sun (null or absent when the row had no satellite read). */
  anti_mid_high_pct?: number | null;
}

/** lib/sunQuality.ts band cutoffs: dud <20, plain 20-44, good 45-69, vivid 70-89, epic 90+. */
export function sunBandOf(score: number): "dud" | "plain" | "good" | "vivid" | "epic" {
  if (score >= 90) return "epic";
  if (score >= 70) return "vivid";
  if (score >= 45) return "good";
  if (score >= 20) return "plain";
  return "dud";
}

export const LEAD_BUCKETS = ["<0", "0–2h", "2–6h", "6–12h", "12–24h", "24h+"] as const;
export type LeadBucket = (typeof LEAD_BUCKETS)[number];

/** `<0` is the post-event golden window; the others are time before the event. */
export function leadBucketOf(leadMinutes: number): LeadBucket {
  if (leadMinutes < 0) return "<0";
  if (leadMinutes < 120) return "0–2h";
  if (leadMinutes < 360) return "2–6h";
  if (leadMinutes < 720) return "6–12h";
  if (leadMinutes < 1440) return "12–24h";
  return "24h+"; // 1,440 minutes exactly is the first minute of this bucket
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
  /** Of our calls, the share that really reached the cutoff (needs 10+ calls). */
  hitRate: Rate;
  /** Of our calls, the share that did not (needs 10+ calls). */
  falseAlarmRate: Rate;
  /** Of the events that really reached the cutoff, the share we did not call
   *  (needs 10+ such events). */
  missRate: Rate;
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
  /** By how the cam looked at the sky: toward the sun ("solar") or away from it
   *  ("afterglow", stored as the antisolar view). Only solar readings are the truth for an
   *  event's color: the afterglow group lists its events and rows but never an error, and
   *  its rows are left out of every other number here. */
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
  if (call && finite(call.observed_score) && !isAfterglow(call)) return call.observed_score;
  const row = eventRows.find((r) => finite(r.observed_score) && !isAfterglow(r));
  return row ? (row.observed_score as number) : null;
}

function callCell(
  cutoff: number,
  pairs: { pred: number; obs: number }[],
  ready: boolean,
  rateMin: number,
): CallCell {
  return cellOf(
    cutoff,
    pairs.map((p) => ({ called: p.pred >= cutoff, real: p.obs >= cutoff })),
    ready,
    rateMin,
  );
}

/** A hit/false-alarm/miss table from (did we call it, did it happen) pairs. */
function cellOf(
  cutoff: number,
  items: { called: boolean; real: boolean }[],
  ready: boolean,
  rateMin: number,
): CallCell {
  let hits = 0;
  let falseAlarms = 0;
  let misses = 0;
  let correctNegatives = 0;
  for (const p of items) {
    if (p.called && p.real) hits++;
    else if (p.called) falseAlarms++;
    else if (p.real) misses++;
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
    hitRate: rateOf(hits, calls, rateMin, ready),
    falseAlarmRate: rateOf(falseAlarms, calls, rateMin, ready),
    missRate: rateOf(misses, observedAtOrAbove, rateMin, ready),
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

/** "sun-cam:ftl-elbo-beach-cam:solar" -> "solar"; ":antisolar" -> "afterglow"; anything else -> "other". */
export function sunViewOf(observedSource: string | null): string {
  const m = /^sun-cam:[^:]*:(solar|antisolar)$/.exec(observedSource ?? "");
  return m ? (m[1] === "antisolar" ? "afterglow" : "solar") : "other";
}

/** A reading from a cam that looked away from the sun: stored, but never the truth for the event's color. */
function isAfterglow(r: Pick<SunPredictionRow, "observed_source">): boolean {
  return sunViewOf(r.observed_source) === "afterglow";
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
  opts: { min?: number; rateMin?: number; nowMs?: number } = {},
): SunColorResult {
  const min = opts.min ?? MIN_SUN_EVENTS;
  const rateMin = opts.rateMin ?? MIN_RATE_CALLS;
  const scored = rows.filter((r) => finite(r.score));
  const byEvent = groupBy(scored, eventKey);
  const afterglow = scored.filter((r) => finite(r.observed_score) && isAfterglow(r));
  const paired = scored.filter((r) => finite(r.observed_score) && !isAfterglow(r));
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

  // Newest model version first.
  const byAlgo = [...groupBy(paired, (r) => r.algo_version)]
    .map(([k, v]) => errorGroup(k, v, min))
    .sort((a, b) => compareAlgoVersions(b.key, a.key));

  const byView = [...groupBy(paired, (r) => sunViewOf(r.observed_source))]
    .map(([k, v]) => errorGroup(k, v, min))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
  if (afterglow.length > 0) {
    byView.unshift({
      key: "afterglow",
      events: new Set(afterglow.map(eventKey)).size,
      rows: afterglow.length,
      mae: null,
      bias: null,
      collecting: "afterglow, not used as truth",
    });
  }

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
      great: callCell(GREAT_CUTOFF, pairedCalls, callsReady, rateMin),
      amazing: callCell(AMAZING_CUTOFF, pairedCalls, callsReady, rateMin),
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
// 1b. Sun color: the fair grade, coverage, afterglow and the fix list
// ============================================================================
//
// Each cam has its own raw scale: on the same Anna Maria sunsets Holmes Beach
// averages 74 and White Sands 5, and a thin horizon strip scores a clear sky's
// warm band at 70–97 (docs/benchmarks/2026-11-05-sun-recalibration). So a raw
// "Great on the cam" is mostly a property of the cam. The fair grade asks only
// about ORDER inside one cam: did the skies we scored higher really look better
// on that cam? And it grades a "Great" call against the cam's own top 25%.

/** The forecast people see opens this many minutes before the event. */
export const HEADLINE_LEAD_TARGET_MIN = 60;
/** The headline forecast is the row closest to 60 min ahead, within this lead range (inclusive). */
export const HEADLINE_LEAD_MIN = 30;
export const HEADLINE_LEAD_MAX = 120;
/** A cam's rank correlation, and its own scale, count once it has this many events. */
export const MIN_CAM_RANK_EVENTS = 8;
/** A real "Great" is in the cam's own top 25% for that event kind; a real "Amazing" in its top 10%. */
export const TOP_TIER = { great: 0.75, amazing: 0.9 } as const;
/** "What to fix next": a band's bias beyond this many points is listed. */
export const FIX_BIAS_PTS = 15;
/** "What to fix next": an event kind with a 30–120 min forecast on less than this share is listed. */
export const FIX_MIN_COVERAGE = 0.5;
/** "What to fix next": a cam whose rank correlation is at or below this is listed. */
export const FIX_CAM_RHO = -0.3;
/** "What to fix next": an afterglow correlation at or beyond this size is listed as a signal. */
export const FIX_SIGNAL_RHO = 0.3;
/** "What to fix next": a cam's own correlation (backwards cam, afterglow signal) needs this many
 *  events before it can make a line. A cam shows its number from MIN_CAM_RANK_EVENTS (8), but at
 *  n = 8 a Spearman's standard error is about 0.38, so one number that small is mostly noise. */
export const FIX_MIN_CAM_EVENTS = 15;
/** A camera reading belongs to a forecast event within this much time (the server's own rule). */
const MATCH_MS = 15 * 60_000;

type SunKind = "sunrise" | "sunset";
const SUN_KINDS: readonly SunKind[] = ["sunrise", "sunset"];
const BAND_NAME: Record<string, string> = { dud: "Poor", plain: "Fair", good: "Good", vivid: "Great", epic: "Amazing" };

/** Ranks 1..n; tied values share the average of their ranks. */
function averageRanks(xs: number[]): number[] {
  const order = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const ranks = new Array<number>(xs.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[order[k][1]] = r;
    i = j + 1;
  }
  return ranks;
}

/**
 * Spearman rank correlation: Pearson on average ranks, so ties are handled.
 * null with fewer than 3 pairs, or when either side has no spread.
 */
export function spearman(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const rx = averageRanks(xs.slice(0, n));
  const ry = averageRanks(ys.slice(0, n));
  const mx = mean(rx) as number;
  const my = mean(ry) as number;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (rx[i] - mx) * (ry[i] - my);
    sxx += (rx[i] - mx) ** 2;
    syy += (ry[i] - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** Each value's mid-rank percentile in its own list, 0 to 1: (values below + half the ties) / n. */
export function midRankPercentiles(xs: number[]): number[] {
  const n = xs.length;
  return xs.map((v) => {
    let below = 0;
    let same = 0;
    for (const x of xs) {
      if (x < v) below++;
      else if (x === v) same++;
    }
    return (below + same / 2) / n;
  });
}

/** Model versions "YYYY-MM-DD.N" by date, then N as a number. Use with sort for oldest first. */
export function compareAlgoVersions(a: string, b: string): number {
  const pa = /^(\d{4}-\d{2}-\d{2})\.(\d+)$/.exec(a);
  const pb = /^(\d{4}-\d{2}-\d{2})\.(\d+)$/.exec(b);
  if (pa && pb && pa[1] !== pb[1]) return pa[1] < pb[1] ? -1 : 1;
  if (pa && pb) return Number(pa[2]) - Number(pb[2]);
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The forecast people see: the scored row closest to 60 minutes before the event,
 * with a lead from 30 to 120 minutes. A tie goes to the shorter lead (the newer
 * forecast). null when the event has no such row.
 */
export function headlineRowOf(eventRows: SunPredictionRow[]): SunPredictionRow | null {
  let best: SunPredictionRow | null = null;
  for (const r of eventRows) {
    if (!finite(r.score) || !(r.lead_minutes >= HEADLINE_LEAD_MIN && r.lead_minutes <= HEADLINE_LEAD_MAX)) continue;
    if (!best) {
      best = r;
      continue;
    }
    const d = Math.abs(r.lead_minutes - HEADLINE_LEAD_TARGET_MIN);
    const bd = Math.abs(best.lead_minutes - HEADLINE_LEAD_TARGET_MIN);
    if (d < bd || (d === bd && r.lead_minutes < best.lead_minutes)) best = r;
  }
  return best;
}

/** "sun-cam:holmes-beach-cam:solar" -> "holmes-beach-cam". Any other source (afterglow, hand labels) -> null. */
export function solarCamOf(observedSource: string | null): string | null {
  const m = /^sun-cam:([^:]+):solar$/.exec(observedSource ?? "");
  return m ? m[1] : null;
}

/**
 * The event's one truth cam and its score. The server already picked it when it
 * filled the rows (solar view only; smallest distance_mi, then cam_id; see
 * docs/SUN_CAM_CHECK.md "Filling the predictions"), so every row of an event
 * carries the same one. Like observedOf above, the preferred row is read first.
 */
function solarTruthOf(
  eventRows: SunPredictionRow[],
  prefer: SunPredictionRow | null,
): { score: number; cam: string } | null {
  const ok = (r: SunPredictionRow) => finite(r.observed_score) && solarCamOf(r.observed_source) != null;
  const row = prefer && ok(prefer) ? prefer : eventRows.find(ok);
  return row ? { score: row.observed_score as number, cam: solarCamOf(row.observed_source) as string } : null;
}

export interface CamRank {
  cam: string;
  kind: SunKind;
  /** Events with a 30–120 min forecast and this cam as the truth. */
  pairs: number;
  /** Spearman between our forecast and this cam's score. null under the minimum or with no spread. */
  rho: number | null;
  collecting: string | null;
}

export interface RankSummary {
  /** Average of the per-cam correlations, weighted by each cam's pairs. Only cams at the minimum count. */
  rho: number | null;
  /** Events on the cams that count. */
  events: number;
  cams: number;
}

export interface FairVersion {
  version: string;
  /** The model version live in the app now (passed in by the runner). */
  current: boolean;
  /** Forecast rows loaded with this version (any lead, any event). */
  rows: number;
  /** Past events whose 30–120 min forecast came from this version. */
  events: number;
  /** Of those, the events with a solar camera reading. */
  pairs: number;
  ready: boolean;
  collecting: string | null;
  rank: RankSummary & { byKind: Record<SunKind, RankSummary>; collecting: string | null };
  cams: CamRank[];
  /** Calls against each cam's own top tier. Only events on a cam with its own scale (8+ events) count. */
  tiers: { events: number; great: CallCell; amazing: CallCell };
  /** The 30–120 min forecast against the raw camera score (raw scale: read with care). */
  raw: ErrorGroup;
  rawByBand: ErrorGroup[];
}

export interface SunCoverage {
  kind: SunKind;
  /** Past events loaded. */
  pastEvents: number;
  /** Of those, the events with a forecast 30–120 min before them. */
  withHeadline: number;
  share: number | null;
  /** Past events with a solar camera reading. */
  pairedEvents: number;
  pairedWithHeadline: number;
  pairedShare: number | null;
}

export interface CamScale {
  cam: string;
  kind: SunKind;
  /** Events this cam is the truth for (all versions, any forecast). */
  events: number;
  /** Whether the cam has enough events for its own percentiles. */
  counted: boolean;
}

export interface SunFairResult {
  min: number;
  camMin: number;
  versions: FairVersion[];
  coverage: SunCoverage[];
  camScales: CamScale[];
}

function rankSummary(cams: CamRank[]): RankSummary {
  const used = cams.filter((c) => c.rho != null);
  const events = used.reduce((a, c) => a + c.pairs, 0);
  return {
    rho: events > 0 ? used.reduce((a, c) => a + (c.rho as number) * c.pairs, 0) / events : null,
    events,
    cams: used.length,
  };
}

/** A beach's distance (miles) from a sun cam, from config/sun-cams.json. */
export type CamDistanceFn = (camId: string, slug: string) => number | undefined;
/** The local calendar date (YYYY-MM-DD) of an event at a beach. */
export type EventLocalDateFn = (slug: string, eventIso: string) => string;

/** Fallback when no local-date function is given: the UTC date. Beaches that share
 *  a cam are a few miles apart, so their events seconds apart share it too. */
const utcDateOf: EventLocalDateFn = (_slug, eventIso) => eventIso.slice(0, 10);

/**
 * Shared cams: one cam can be the truth for two beaches (Boca Raton and
 * Deerfield Beach share the Deerfield cams), so the same reading would count
 * twice. Of the items in each group (same cam, event kind and local date),
 * keep one: first an item that can be graded (`usable`, e.g. it has a
 * forecast to pair with), then the beach nearest that cam (`distanceOf`;
 * unknown counts as farthest), then the first slug. So a reading is never
 * dropped for a beach that cannot use it while another beach could.
 * Returns the items kept.
 */
export function nearestBeachPerCamEvent<T>(
  items: T[],
  of: (t: T) => { cam: string; kind: string; date: string; slug: string },
  distanceOf?: CamDistanceFn,
  usable?: (t: T) => boolean,
): Set<T> {
  const best = new Map<string, { item: T; u: number; d: number; slug: string }>();
  for (const item of items) {
    const { cam, kind, date, slug } = of(item);
    const k = `${cam}|${kind}|${date}`;
    const d = distanceOf?.(cam, slug);
    const dist = typeof d === "number" && Number.isFinite(d) ? d : Infinity;
    const u = usable && !usable(item) ? 1 : 0;
    const cur = best.get(k);
    const better =
      !cur || u < cur.u || (u === cur.u && (dist < cur.d || (dist === cur.d && slug < cur.slug)));
    if (better) best.set(k, { item, u, d: dist, slug });
  }
  return new Set([...best.values()].map((b) => b.item));
}

/**
 * The fair sun grade, one block per model version (newest first): the forecast
 * people see (closest to 60 min ahead, 30–120 min) against the event's one solar
 * truth cam, by rank inside each cam and against each cam's own top tier. Also
 * the coverage of that forecast per event kind. Afterglow never enters.
 *
 * A cam reading shared by two beaches is graded once, for the beach nearest
 * the cam (`nearestBeachPerCamEvent`): in the grade, the cam's percentile
 * scale and the top-tier calls. Coverage still counts each beach.
 */
export function sunFairMetrics(
  rows: SunPredictionRow[],
  opts: {
    nowMs?: number;
    currentVersion?: string;
    min?: number;
    camMin?: number;
    rateMin?: number;
    camDistance?: CamDistanceFn;
    localDateOf?: EventLocalDateFn;
  } = {},
): SunFairResult {
  const min = opts.min ?? MIN_SUN_EVENTS;
  const camMin = opts.camMin ?? MIN_CAM_RANK_EVENTS;
  const rateMin = opts.rateMin ?? MIN_RATE_CALLS;

  type Pair = { key: string; kind: SunKind; cam: string; pred: number; row: SunPredictionRow };
  const coverage = new Map<SunKind, SunCoverage>(
    SUN_KINDS.map((k) => [
      k,
      { kind: k, pastEvents: 0, withHeadline: 0, share: null, pairedEvents: 0, pairedWithHeadline: 0, pairedShare: null },
    ]),
  );
  const scale = new Map<string, { key: string; obs: number }[]>(); // cam|kind -> truth per event
  const eventsByVersion = new Map<string, number>();
  const pairsByVersion = new Map<string, Pair[]>();

  type Ev = {
    key: string;
    kind: SunKind;
    slug: string;
    eventIso: string;
    head: SunPredictionRow | null;
    truth: { score: number; cam: string } | null;
  };
  const evs: Ev[] = [];
  for (const [key, evRows] of groupBy(rows, eventKey)) {
    const first = evRows[0];
    if (opts.nowMs != null && Date.parse(first.event_iso) > opts.nowMs) continue;
    const kind = first.event_kind;
    const cov = coverage.get(kind);
    if (!cov) continue;
    const head = headlineRowOf(evRows);
    const truth = solarTruthOf(evRows, head);
    cov.pastEvents++;
    if (head) cov.withHeadline++;
    if (truth) {
      cov.pairedEvents++;
      if (head) cov.pairedWithHeadline++;
    }
    evs.push({ key, kind, slug: first.slug, eventIso: first.event_iso, head, truth });
  }
  const localDateOf = opts.localDateOf ?? utcDateOf;
  const graded = nearestBeachPerCamEvent(
    evs.filter((e) => e.truth),
    (e) => ({ cam: (e.truth as { cam: string }).cam, kind: e.kind, date: localDateOf(e.slug, e.eventIso), slug: e.slug }),
    opts.camDistance,
    (e) => e.head != null,
  );
  for (const ev of evs) {
    const { key, kind, head } = ev;
    // A shared cam's reading counts only for the nearest beach; the other
    // beach's forecast still counts as an event, but without a truth.
    const truth = ev.truth && graded.has(ev) ? ev.truth : null;
    if (truth) {
      const sk = `${truth.cam}|${kind}`;
      const a = scale.get(sk) ?? [];
      a.push({ key, obs: truth.score });
      scale.set(sk, a);
    }
    if (!head) continue;
    eventsByVersion.set(head.algo_version, (eventsByVersion.get(head.algo_version) ?? 0) + 1);
    if (!truth) continue;
    const list = pairsByVersion.get(head.algo_version) ?? [];
    list.push({ key, kind, cam: truth.cam, pred: head.score as number, row: { ...head, observed_score: truth.score } });
    pairsByVersion.set(head.algo_version, list);
  }
  for (const c of coverage.values()) {
    c.share = share(c.withHeadline, c.pastEvents);
    c.pairedShare = share(c.pairedWithHeadline, c.pairedEvents);
  }

  // Each cam's own scale: the percentile of every event it is the truth for.
  const pctOf = new Map<string, number>();
  const camScales: CamScale[] = [];
  for (const [sk, list] of scale) {
    const [cam, kind] = sk.split("|") as [string, SunKind];
    const counted = list.length >= camMin;
    camScales.push({ cam, kind, events: list.length, counted });
    if (!counted) continue;
    const p = midRankPercentiles(list.map((x) => x.obs));
    list.forEach((x, i) => pctOf.set(x.key, p[i]));
  }
  camScales.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.cam < b.cam ? -1 : a.cam > b.cam ? 1 : 0));

  const rowsByVersion = new Map<string, number>();
  for (const r of rows) rowsByVersion.set(r.algo_version, (rowsByVersion.get(r.algo_version) ?? 0) + 1);
  const versionSet = new Set([...rowsByVersion.keys()]);
  if (opts.currentVersion) versionSet.add(opts.currentVersion);
  const bandOf = (r: SunPredictionRow) => r.band ?? sunBandOf(r.score as number);

  const versions: FairVersion[] = [...versionSet]
    .sort((a, b) => compareAlgoVersions(b, a))
    .map((version) => {
      const pairs = pairsByVersion.get(version) ?? [];
      const ready = pairs.length >= min;
      const cams: CamRank[] = [...groupBy(pairs, (p) => `${p.cam}|${p.kind}`)]
        .map(([k, ps]) => {
          const [cam, kind] = k.split("|") as [string, SunKind];
          const enough = ps.length >= camMin;
          const rho = enough ? spearman(ps.map((p) => p.pred), ps.map((p) => p.row.observed_score as number)) : null;
          return {
            cam,
            kind,
            pairs: ps.length,
            rho: rho == null ? null : Math.round(rho * 100) / 100,
            collecting: !enough ? collectingText(ps.length, camMin, "pairs") : rho == null ? "no spread" : null,
          };
        })
        .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : b.pairs - a.pairs || (a.cam < b.cam ? -1 : 1)));
      const all = rankSummary(cams);
      const most = Math.max(0, ...cams.map((c) => c.pairs));
      const rankCollecting = !ready
        ? collectingText(pairs.length, min, "pairs")
        : all.rho == null
          ? collectingText(most, camMin, "pairs on the best cam")
          : null;
      const byKind = Object.fromEntries(SUN_KINDS.map((k) => [k, rankSummary(cams.filter((c) => c.kind === k))])) as Record<
        SunKind,
        RankSummary
      >;
      const round2 = (v: number | null) => (v == null ? null : Math.round(v * 100) / 100);
      const gate = (s: RankSummary): RankSummary => ({ ...s, rho: ready ? round2(s.rho) : null });

      const tierPairs = pairs.filter((p) => pctOf.has(p.key));
      const tiersReady = ready && tierPairs.length >= min;
      const items = (cut: number, level: number) =>
        tierPairs.map((p) => ({ called: p.pred >= cut, real: (pctOf.get(p.key) as number) >= level }));

      const headRows = pairs.map((p) => p.row);
      const byBandMap = groupBy(headRows, bandOf);
      return {
        version,
        current: version === opts.currentVersion,
        rows: rowsByVersion.get(version) ?? 0,
        events: eventsByVersion.get(version) ?? 0,
        pairs: pairs.length,
        ready,
        collecting: ready ? null : collectingText(pairs.length, min, "pairs"),
        rank: { ...gate(all), byKind: { sunrise: gate(byKind.sunrise), sunset: gate(byKind.sunset) }, collecting: rankCollecting },
        cams,
        tiers: {
          events: tierPairs.length,
          great: cellOf(GREAT_CUTOFF, items(GREAT_CUTOFF, TOP_TIER.great), tiersReady, rateMin),
          amazing: cellOf(AMAZING_CUTOFF, items(AMAZING_CUTOFF, TOP_TIER.amazing), tiersReady, rateMin),
        },
        raw: errorGroup("all", headRows, min),
        rawByBand: (["dud", "plain", "good", "vivid", "epic"] as const)
          .filter((b) => byBandMap.has(b))
          .map((b) => errorGroup(b, byBandMap.get(b)!, min)),
      };
    });

  return { min, camMin, versions, coverage: SUN_KINDS.map((k) => coverage.get(k) as SunCoverage), camScales };
}

// --- Afterglow ---------------------------------------------------------------

/** One afterglow (antisolar) reading from sun_event_observations. */
export interface AfterglowReading {
  slug: string;
  event_kind: SunKind;
  cam_id: string;
  event_iso: string;
  view: string;
  observed_score: number;
  /** The event's local date, as stored. Without it the local-date function (or the UTC date) is used. */
  event_date_local?: string;
}

export interface AfterglowCell {
  version: string;
  n: number;
  rho: number | null;
  collecting: string | null;
}

export interface AfterglowCam {
  cam: string;
  facing: "east" | "west";
  /** Afterglow readings from this cam in the window. */
  readings: number;
  /** Of those, the readings that match a forecast event (same beach and kind, within 15 min). */
  matched: number;
  /** Our 30–120 min forecast against the afterglow, per model version (newest first). */
  headline: AfterglowCell[];
  /** Our call (latest forecast 60+ min ahead) against the afterglow, per model version. */
  call: AfterglowCell[];
  /** The satellite's mid + high cloud away from the sun against the afterglow (any version). */
  cloud: { n: number; rho: number | null; collecting: string | null };
}

export interface AfterglowSide {
  /** sunset: east cams look away from the sun, over the ocean. sunrise: Gulf cams look away from the sun, over the Gulf. */
  kind: SunKind;
  readings: number;
  /** Readings that match no forecast event. */
  unmatched: number;
  /** Readings from a cam whose registry facing does not fit this side (left out). */
  wrongFacing: number;
  cams: AfterglowCam[];
}

function afterglowCell(version: string, xs: number[], ys: number[], camMin: number): AfterglowCell {
  const n = xs.length;
  const rho = n >= camMin ? spearman(xs, ys) : null;
  return {
    version,
    n,
    rho: rho == null ? null : Math.round(rho * 100) / 100,
    collecting: n < camMin ? collectingText(n, camMin, "events") : rho == null ? "no spread" : null,
  };
}

/** The event's satellite read: the row with an anti-solar cloud value closest to the event. */
function satelliteAntiOf(eventRows: SunPredictionRow[]): number | null {
  let best: SunPredictionRow | null = null;
  for (const r of eventRows) {
    if (!finite(r.anti_mid_high_pct)) continue;
    if (!best || Math.abs(r.lead_minutes) < Math.abs(best.lead_minutes)) best = r;
  }
  return best ? (best.anti_mid_high_pct as number) : null;
}

/**
 * Afterglow: what a cam saw when it looked AWAY from the sun. For an east-coast
 * beach at sunset, that afterglow over the ocean is what a beachgoer sees. It is
 * graded here by rank against our sunset forecast and the satellite's anti-solar
 * mid/high cloud, per cam. It is never the truth for an event's color and never
 * enters the solar numbers. `facingOf` comes from config/sun-cams.json; without
 * it the view and the event kind imply the facing. A reading shared by two
 * beaches counts once, for the beach nearest the cam (`nearestBeachPerCamEvent`).
 */
export function afterglowMetrics(
  rows: SunPredictionRow[],
  readings: AfterglowReading[],
  opts: {
    facingOf?: (camId: string) => "east" | "west" | undefined;
    nowMs?: number;
    camMin?: number;
    camDistance?: CamDistanceFn;
    localDateOf?: EventLocalDateFn;
  } = {},
): { sunset: AfterglowSide; sunrise: AfterglowSide } {
  const camMin = opts.camMin ?? MIN_CAM_RANK_EVENTS;
  const byEvent = groupBy(rows, eventKey);
  const index = new Map<string, { ms: number; key: string }[]>();
  for (const [key, evRows] of byEvent) {
    const r = evRows[0];
    const k = `${r.slug}|${r.event_kind}`;
    const a = index.get(k) ?? [];
    a.push({ ms: Date.parse(r.event_iso), key });
    index.set(k, a);
  }
  const findEvent = (o: AfterglowReading): SunPredictionRow[] | null => {
    const t = Date.parse(o.event_iso);
    let best: { d: number; key: string } | null = null;
    for (const e of index.get(`${o.slug}|${o.event_kind}`) ?? []) {
      const d = Math.abs(e.ms - t);
      if (d <= MATCH_MS + 10 && (!best || d < best.d)) best = { d, key: e.key };
    }
    return best ? (byEvent.get(best.key) as SunPredictionRow[]) : null;
  };
  // A shared cam's reading counts once: for a beach that has a forecast to pair it
  // with, then the beach nearest the cam (as in sunFairMetrics).
  const localDateOf = opts.localDateOf ?? utcDateOf;
  const kept = nearestBeachPerCamEvent(
    readings,
    (o) => ({
      cam: o.cam_id,
      kind: `${o.event_kind}|${o.view}`,
      date: o.event_date_local ?? localDateOf(o.slug, o.event_iso),
      slug: o.slug,
    }),
    opts.camDistance,
    (o) => findEvent(o) != null,
  );
  readings = readings.filter((o) => kept.has(o));

  const side = (kind: SunKind): AfterglowSide => {
    const want: "east" | "west" = kind === "sunset" ? "east" : "west";
    const mine = readings.filter(
      (o) =>
        o.view === "antisolar" &&
        o.event_kind === kind &&
        finite(o.observed_score) &&
        (opts.nowMs == null || Date.parse(o.event_iso) <= opts.nowMs),
    );
    let unmatched = 0;
    let wrongFacing = 0;
    type Item = { head: SunPredictionRow | null; call: SunPredictionRow | null; anti: number | null; obs: number };
    const perCam = new Map<string, { readings: number; items: Item[] }>();
    for (const o of mine) {
      const facing = opts.facingOf?.(o.cam_id) ?? want;
      if (facing !== want) {
        wrongFacing++;
        continue;
      }
      const c = perCam.get(o.cam_id) ?? { readings: 0, items: [] };
      c.readings++;
      perCam.set(o.cam_id, c);
      const ev = findEvent(o);
      if (!ev) {
        unmatched++;
        continue;
      }
      c.items.push({ head: headlineRowOf(ev), call: callOf(ev), anti: satelliteAntiOf(ev), obs: o.observed_score });
    }
    const cells = (items: Item[], pick: (i: Item) => SunPredictionRow | null): AfterglowCell[] => {
      const byV = new Map<string, { x: number[]; y: number[] }>();
      for (const i of items) {
        const r = pick(i);
        if (!r) continue;
        const a = byV.get(r.algo_version) ?? { x: [], y: [] };
        a.x.push(r.score as number);
        a.y.push(i.obs);
        byV.set(r.algo_version, a);
      }
      return [...byV.keys()]
        .sort((a, b) => compareAlgoVersions(b, a))
        .map((v) => afterglowCell(v, byV.get(v)!.x, byV.get(v)!.y, camMin));
    };
    const cams: AfterglowCam[] = [...perCam]
      .map(([cam, c]) => {
        const sat = c.items.filter((i) => i.anti != null);
        const cloud = afterglowCell("any", sat.map((i) => i.anti as number), sat.map((i) => i.obs), camMin);
        return {
          cam,
          facing: want,
          readings: c.readings,
          matched: c.items.length,
          headline: cells(c.items, (i) => i.head),
          call: cells(c.items, (i) => i.call),
          cloud: { n: cloud.n, rho: cloud.rho, collecting: cloud.collecting },
        };
      })
      .sort((a, b) => b.readings - a.readings || (a.cam < b.cam ? -1 : 1));
    return { kind, readings: mine.length - wrongFacing, unmatched, wrongFacing, cams };
  };
  return { sunset: side("sunset"), sunrise: side("sunrise") };
}

// --- What to fix next ---------------------------------------------------------

const fmtSigned = (v: number, d = 1): string => `${v > 0 ? "+" : ""}${v.toFixed(d)}`;
const fmtPct = (v: number): string => `${Math.round(v * 100)}%`;

/**
 * "What to fix next": plain rules over the computed numbers, nothing else. Each
 * line quotes the number that tripped it. Rules (README "What to fix next"):
 * the live model still collecting; a forecast band whose raw bias is beyond
 * ±15 points on 10+ events; a version that ranks skies the wrong way round
 * (fair correlation at or below 0); a cam at or below −0.3 on 15+ pairs; Great
 * calls that land in the cam's top 25% less often than chance (25%); an event
 * kind with a 30–120 min forecast on under 50% of events; an afterglow
 * correlation of ±0.3 or more on 15+ events (evidence for a future afterglow
 * forecast). A cam shows its correlation from 8 events, but a line needs 15
 * (FIX_MIN_CAM_EVENTS).
 */
export function sunFixList(
  fair: SunFairResult,
  afterglow: { sunset: AfterglowSide; sunrise: AfterglowSide } | null,
): string[] {
  const out: string[] = [];
  for (const v of fair.versions) {
    if (v.current && !v.ready) {
      out.push(
        `Model ${v.version} (live now) is still collecting: ${v.pairs} of ${fair.min} pairs with a forecast 30–120 min out (${plainCount(v.events, "event")} so far). Check again next week.`,
      );
    }
    for (const g of v.rawByBand) {
      if (g.bias == null || Math.abs(g.bias) <= FIX_BIAS_PTS) continue;
      out.push(
        `Model ${v.version} runs ${g.bias > 0 ? "high" : "low"} when it says ${BAND_NAME[g.key] ?? g.key}: bias ${fmtSigned(g.bias)} points on ${plainCount(g.events, "event")} (raw camera scale).`,
      );
    }
    if (v.rank.rho != null && v.rank.rho <= 0) {
      out.push(
        `Model ${v.version} ranks skies the wrong way round: fair rank correlation ${fmtSigned(v.rank.rho, 2)} over ${plainCount(v.rank.events, "event")} on ${plainCount(v.rank.cams, "cam")}.`,
      );
    }
    if (v.ready) {
      for (const c of v.cams) {
        if (c.rho == null || c.rho > FIX_CAM_RHO || c.pairs < FIX_MIN_CAM_EVENTS) continue;
        out.push(`Model ${v.version} ranks ${c.kind}s backwards at ${c.cam}: correlation ${fmtSigned(c.rho, 2)} on ${plainCount(c.pairs, "event")}.`);
      }
    }
    const hr = v.tiers.great.hitRate;
    if (hr.value != null && hr.value < 1 - TOP_TIER.great) {
      out.push(
        `Model ${v.version}'s Great calls land in the cam's own top 25% only ${fmtPct(hr.value)} of the time (${v.tiers.great.hits} of ${v.tiers.great.calls}); chance alone gives 25%.`,
      );
    }
  }
  for (const c of fair.coverage) {
    if (c.share == null || c.share >= FIX_MIN_COVERAGE) continue;
    out.push(
      `${c.kind === "sunrise" ? "Sunrise" : "Sunset"} coverage is low: ${fmtPct(c.share)} of ${plainCount(c.pastEvents, `past ${c.kind}`)} have a forecast 30–120 min before the event (${c.withHeadline})` +
        (c.pairedShare != null
          ? `; of those with a camera reading, ${c.pairedWithHeadline} of ${c.pairedEvents} (${fmtPct(c.pairedShare)}).`
          : "."),
    );
  }
  if (afterglow) {
    for (const s of [afterglow.sunset, afterglow.sunrise]) {
      for (const cam of s.cams) {
        const r = cam.cloud.rho;
        if (r == null || Math.abs(r) < FIX_SIGNAL_RHO || cam.cloud.n < FIX_MIN_CAM_EVENTS) continue;
        out.push(
          `Afterglow signal at ${cam.cam} (${s.kind}s): the satellite's mid/high cloud away from the sun has a rank correlation of ${fmtSigned(r, 2)} with the afterglow on ${plainCount(cam.cloud.n, "event")}. A candidate input for an afterglow forecast.`,
        );
      }
    }
  }
  return out;
}

const plainCount = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`;

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
  /** lib/score.ts SCORING_ENGINE_VERSION the row was scored with. */
  engine_version?: string | null;
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

/** What the nowcast says the sky is doing at one horizon. */
export type ForecastState = "dry" | "rain";

/**
 * The state the nowcast forecasts `horizonMin` minutes ahead, from its current
 * state and `changeInMin` (minutes until it flips; null = no flip in the next
 * 2 hours). "Dry, rain in 25 min" is a rain call at +1 h and +2 h. "Raining,
 * easing in 25 min" is a dry call at +1 h and +2 h. `changeInMin` is the start
 * of the first changed 15-minute bucket (lib/sources/nowcast.ts), so a change
 * at exactly the horizon already applies at the horizon (`<=`). null = cannot tell (no
 * nowcast, or a row that never recorded changeInMin).
 */
export function forecastStateAt(
  nowcast: "dry" | "raining" | null | undefined,
  changeInMin: number | null | undefined,
  horizonMin: number,
): ForecastState | null {
  if (!nowcast || changeInMin === undefined) return null;
  const flipped = changeInMin !== null && changeInMin <= horizonMin;
  if (nowcast === "dry") return flipped ? "rain" : "dry";
  return flipped ? "dry" : "rain";
}

/** The user-facing promise: "Dry for the next 2+ hrs" (dry now, no rain expected for 2 h). */
export function isDryPromise(r: RainBlock | null | undefined): boolean {
  if (!r || r.nowcast !== "dry" || r.changeInMin === undefined) return false;
  return r.changeInMin === null || r.changeInMin >= 120;
}

export interface RainConfusion {
  /** Forecast rain at the horizon and radar saw rain. */
  hits: number;
  /** Forecast rain and radar saw none. */
  falseAlarms: number;
  /** Forecast dry and radar saw rain. */
  misses: number;
  /** Forecast dry and radar saw none. */
  correctDry: number;
  rainCalls: number;
  dryCalls: number;
  /** Of the rain calls, the share radar confirmed (needs 10+ rain calls). */
  hitRate: Rate;
  /** Of the rain calls, the share radar did not confirm (needs 10+ rain calls). */
  falseAlarmRate: Rate;
  /** Of the times radar saw rain, the share we had forecast dry (needs 10+ such times). */
  missRate: Rate;
  /** Of the dry calls, the share that got rained on (needs 30+ dry calls). */
  dryRainedOnRate: Rate;
}

export interface RainResult {
  /** Rows with a nowcast call. */
  calls: number;
  /** Calls with radar truth at both +1 h and +2 h — the scored set. */
  scored: number;
  min: number;
  ready: boolean;
  collecting: string | null;
  /** The forecast at +1 h (60 min) against radar one hour later. */
  next1h: RainConfusion;
  /** The forecast at +2 h (120 min) against radar two hours later. */
  next2h: RainConfusion;
  /** "Dry for the next 2+ hrs" calls: radar rain at +1 h or +2 h breaks the promise. */
  dryPromise: {
    n: number;
    rainedOn: number;
    /** Share rained on (needs 30+ such calls). */
    rate: Rate;
  };
}

/**
 * Radar says rain (true), says dry (false), or cannot say (null). A frame older
 * than RADAR_MAX_AGE_MIN is not an observation, so it is checked FIRST: a stale
 * frame is "unknown" whatever its radarDry or rate say. A row with no recorded
 * age is read as fresh (the archive always records the age with a reading).
 */
export function radarRainAt(r: RainBlock | null | undefined, thresholdMmHr = RADAR_RAIN_MM_HR): boolean | null {
  if (!r) return null;
  if (finite(r.radarAgeMin) && r.radarAgeMin > RADAR_MAX_AGE_MIN) return null;
  if (r.radarDry === 0) return true;
  if (finite(r.radarMmHr) && r.radarMmHr > thresholdMmHr) return true;
  if (r.radarDry === 1) return false;
  if (finite(r.radarMmHr)) return false;
  return null;
}

function confusion(
  items: { forecastRain: boolean; rain: boolean }[],
  open: boolean,
  rateMin: number,
  dryMin: number,
): RainConfusion {
  let hits = 0;
  let falseAlarms = 0;
  let misses = 0;
  let correctDry = 0;
  for (const i of items) {
    if (i.forecastRain && i.rain) hits++;
    else if (i.forecastRain) falseAlarms++;
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
    hitRate: rateOf(hits, rainCalls, rateMin, open),
    falseAlarmRate: rateOf(falseAlarms, rainCalls, rateMin, open),
    missRate: rateOf(misses, hits + misses, rateMin, open),
    dryRainedOnRate: rateOf(misses, dryCalls, dryMin, open),
  };
}

/**
 * Score the rain nowcast against the radar one and two hours later. The
 * forecast state at each horizon comes from (nowcast, changeInMin) — see
 * forecastStateAt — and is graded against the radar reading at hour+1 / hour+2
 * for the same beach. A row is scored when it has a nowcast with a known
 * changeInMin and radar truth at BOTH hours. Radar rain = rate above
 * `thresholdMmHr`, or a fresh frame that is not "confident dry" (RainBlock.radarDry).
 */
export function rainMetrics(
  rows: RainRow[],
  opts: { min?: number; rateMin?: number; dryMin?: number; thresholdMmHr?: number } = {},
): RainResult {
  const min = opts.min ?? MIN_RAIN_CALLS;
  const rateMin = opts.rateMin ?? MIN_RATE_CALLS;
  const dryMin = opts.dryMin ?? MIN_DRY_PROMISE_CALLS;
  const thr = opts.thresholdMmHr ?? RADAR_RAIN_MM_HR;
  const at = new Map<string, RainBlock>();
  for (const r of rows) {
    const ms = Date.parse(r.hour_utc);
    if (r.rain && Number.isFinite(ms)) at.set(`${r.slug}|${ms}`, r.rain);
  }

  let calls = 0;
  const items1: { forecastRain: boolean; rain: boolean }[] = [];
  const items2: { forecastRain: boolean; rain: boolean }[] = [];
  let promiseN = 0;
  let promiseRainedOn = 0;
  for (const r of rows) {
    const ms = Date.parse(r.hour_utc);
    if (!r.rain?.nowcast || !Number.isFinite(ms)) continue;
    calls++;
    const f1 = forecastStateAt(r.rain.nowcast, r.rain.changeInMin, 60);
    const f2 = forecastStateAt(r.rain.nowcast, r.rain.changeInMin, 120);
    const t1 = radarRainAt(at.get(`${r.slug}|${ms + HOUR_MS}`), thr);
    const t2 = radarRainAt(at.get(`${r.slug}|${ms + 2 * HOUR_MS}`), thr);
    if (f1 == null || f2 == null || t1 == null || t2 == null) continue;
    items1.push({ forecastRain: f1 === "rain", rain: t1 });
    items2.push({ forecastRain: f2 === "rain", rain: t2 });
    if (isDryPromise(r.rain)) {
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
    next1h: confusion(items1, ready, rateMin, dryMin),
    next2h: confusion(items2, ready, rateMin, dryMin),
    dryPromise: {
      n: promiseN,
      rainedOn: promiseRainedOn,
      rate: rateOf(promiseRainedOn, promiseN, dryMin, ready),
    },
  };
}

// ============================================================================
// 3. Best window and the multi-day outlook
// ============================================================================

export type WindowRow = Pick<HourlyRow, "slug" | "local_date" | "local_hour" | "hour_utc" | "score" | "window" | "engine_version"> & {
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
  /** Finished (beach, day) pairs with near-complete daylight coverage, so
   *  their hourly scores are a fair record of the day. */
  completeDays: number;
  /** Of those, the days that also have a window predicted by 10 AM local. */
  daysScored: number;
  min: number;
  ready: boolean;
  collecting: string | null;
  skipped: {
    /** The beach's latest archived day: still in progress. */
    incompleteDay: number;
    /** Finished days whose archived daylight hours have gaps or stop early
     *  (the normal pattern while the archive loses afternoons). */
    censoredDay: number;
    noEarlyWindow: number;
    /** Days whose rows were scored by more than one scoring-engine version
     *  (a deploy day): a morning forecast and the afternoon it is graded
     *  against would come from different curves, so the day is left out. */
    versionMixed: number;
    /** Outlook forecast→target pairs skipped because the forecast and the
     *  target day were scored by different engine versions. */
    outlookVersionMismatch: number;
  };
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
/** Of the daylight hours between the first and last archived one, this share must be present. */
export const MIN_DAY_DENSITY = 0.8;
/** A day must be archived through this local hour (or the last daylight hour, if earlier). */
export const DAY_MUST_REACH_HOUR = 17;
/** ...and start within this many hours of sunrise. */
export const DAY_START_SLACK_HOURS = 2;

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

/**
 * Do a day's archived daylight scores cover it well enough to stand as the
 * day's realized record? Needs: 8+ scored daylight hours; at least 80% of the
 * hours between the first and the last archived one; a first hour within 2
 * hours of sunrise; and a last hour at 5 PM local (or the last daylight hour,
 * when sunset comes sooner). A day failing this is "censored": its realized
 * peak and averages would describe only part of the day.
 */
export function dayCoverageOk(hours: Iterable<number>, dl: { from: number; to: number }): boolean {
  const hs = [...hours].sort((a, b) => a - b);
  if (hs.length < MIN_DAYLIGHT_HOURS) return false;
  const first = hs[0];
  const last = hs[hs.length - 1];
  if (hs.length / (last - first + 1) < MIN_DAY_DENSITY) return false;
  if (first > dl.from + DAY_START_SLACK_HOURS) return false;
  return last >= Math.min(DAY_MUST_REACH_HOUR, dl.to - 1);
}

export function windowMetrics(
  rows: WindowRow[],
  opts: { min?: number; daylight?: DaylightFn } = {},
): WindowResult {
  const min = opts.min ?? MIN_WINDOW_DAYS;
  const daylightOf = opts.daylight ?? defaultDaylight;

  // Group by beach, then local date.
  const bySlug = groupBy(rows, (r) => r.slug);
  type Day = {
    rows: WindowRow[];
    scores: Map<number, { score: number; hourMs: number }>;
    daylight: { from: number; to: number } | null;
  };
  const days = new Map<string, Map<string, Day>>(); // slug -> date -> day
  const lastDate = new Map<string, string>();
  for (const [slug, rs] of bySlug) {
    const m = new Map<string, Day>();
    let last = "";
    for (const r of rs) {
      if (r.local_date > last) last = r.local_date;
      let d = m.get(r.local_date);
      if (!d) {
        d = { rows: [], scores: new Map(), daylight: daylightOf(slug, r.local_date) };
        m.set(r.local_date, d);
      }
      d.rows.push(r);
    }
    for (const d of m.values()) {
      if (!d.daylight) continue;
      for (const r of d.rows.sort((a, b) => (a.hour_utc < b.hour_utc ? -1 : 1))) {
        if (!finite(r.score) || r.local_hour < d.daylight.from || r.local_hour >= d.daylight.to) continue;
        d.scores.set(r.local_hour, { score: r.score, hourMs: Date.parse(r.hour_utc) });
      }
    }
    days.set(slug, m);
    lastDate.set(slug, last);
  }

  const skipped = { incompleteDay: 0, censoredDay: 0, noEarlyWindow: 0, versionMixed: 0, outlookVersionMismatch: 0 };
  /** Realized daylight scores per finished, well-covered (slug, date). */
  const complete = new Map<string, { slug: string; date: string; day: Day }>();
  for (const [slug, m] of days) {
    for (const [date, day] of m) {
      if (date >= (lastDate.get(slug) as string)) {
        skipped.incompleteDay++;
        continue;
      }
      if (!day.daylight || !dayCoverageOk(day.scores.keys(), day.daylight)) {
        skipped.censoredDay++;
        continue;
      }
      if (new Set(day.rows.map((r) => r.engine_version ?? "unknown")).size > 1) {
        skipped.versionMixed++;
        continue;
      }
      complete.set(`${slug}|${date}`, { slug, date, day });
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
  for (const { day } of complete.values()) {
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
  // Only well-covered target days count: a day with the afternoon missing has
  // no honest "realized peak".
  const errsByLead = new Map<number, number[]>();
  for (const [slug, m] of days) {
    for (const [date, day] of m) {
      const row = earliestRow(day, (r) => (r.outlook?.days?.length ?? 0) > 0);
      if (!row?.outlook) continue;
      for (const o of row.outlook.days) {
        const lead = daysBetween(date, o.date);
        if (lead < 1 || lead > 6 || !finite(o.peak)) continue;
        const target = complete.get(`${slug}|${o.date}`);
        if (!target) continue;
        // A forecast made under one scoring-engine version is not graded
        // against a day scored under another (a deploy between the two).
        const targetVersion = target.day.rows[0]?.engine_version ?? "unknown";
        if ((row.engine_version ?? "unknown") !== targetVersion) {
          skipped.outlookVersionMismatch++;
          continue;
        }
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
    completeDays: complete.size,
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

export type SafetyRow = Pick<
  HourlyRow,
  "slug" | "hour_utc" | "local_date" | "local_hour" | "safety" | "flags" | "rip"
>;

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
  /** Beach-days with a swim message and a known flag (one flag posting per beach per day). */
  beachDays: number;
  /** The hourly rows those beach-days summarize. */
  hours: number;
  min: number;
  ready: boolean;
  collecting: string | null;
  /** flag -> swim level -> beach-days. */
  crossTab: Record<string, Record<string, number>>;
  /** Beach-days whose flag is green or yellow. Red flags directly set
   *  "stay-out" (lib/safetyLine.ts), so red days say nothing about our own
   *  judgement. */
  informative: {
    beachDays: number;
    ready: boolean;
    collecting: string | null;
    yellowDays: number;
    greenDays: number;
    /** Yellow and we said caution or stay out, or green and we said safe. */
    agreeDays: number;
    agreement: Rate;
    /** A yellow flag flew and we said "safe". */
    yellowWeSaidSafe: number;
    /** A green flag flew and we said caution or stay out. */
    greenWeCautioned: number;
    /** Why we cautioned on those green days (from the archived rip block). */
    greenReasons: { reason: string; days: number }[];
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

/** Most frequent key; ties go to the earliest in `priority` (the more serious). */
function modeOf<T extends string>(counts: Map<T, number>, priority: readonly T[]): T | null {
  let best: T | null = null;
  let bestN = 0;
  for (const [k, n] of counts) {
    const better =
      n > bestN ||
      (n === bestN && best != null && priority.indexOf(k) !== -1 && priority.indexOf(k) < priority.indexOf(best));
    if (better) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

const SWIM_SERIOUS_FIRST = ["stay-out", "caution", "safe"] as const;

/**
 * Safety message against the lifeguard flag, one beach-day at a time. The City
 * posts one flag a day, so 24 hourly rows are one observation, not 24. A
 * beach-day's flag is its most frequent flag; our message is its most frequent
 * swim level (ties go to the more serious one). With `opts.daylight`, only
 * daylight hours count, so a quiet night does not outvote the beach day.
 */
export function safetyMetrics(
  rows: SafetyRow[],
  opts: { min?: number; daylight?: DaylightFn } = {},
): SafetyResult {
  const min = opts.min ?? MIN_SAFETY_BEACH_DAYS;
  const crossTab: Record<string, Record<string, number>> = {};
  for (const f of FLAG_ORDER) crossTab[f] = Object.fromEntries(SWIM_LEVELS.map((l) => [l, 0]));

  const byDay = groupBy(rows, (r) => `${r.slug}|${r.local_date}`);
  let beachDays = 0;
  let hours = 0;
  let infDays = 0;
  let yellowDays = 0;
  let greenDays = 0;
  let agree = 0;
  let yellowSafe = 0;
  let greenCaution = 0;
  const reasons = new Map<string, number>();

  for (const dayRows of byDay.values()) {
    const first = dayRows[0];
    const dl = opts.daylight?.(first.slug, first.local_date);
    if (opts.daylight && !dl) continue;
    const used = dayRows.filter(
      (r) => r.safety?.swim && (!dl || (r.local_hour >= dl.from && r.local_hour < dl.to)),
    );
    const flagCounts = new Map<DominantFlag, number>();
    const known: SafetyRow[] = [];
    for (const r of used) {
      const f = dominantFlag(r.flags?.colors);
      if (f === "unknown") continue;
      flagCounts.set(f, (flagCounts.get(f) ?? 0) + 1);
      known.push(r);
    }
    const flag = modeOf(flagCounts, FLAG_ORDER);
    if (!flag) continue;
    const swimCounts = new Map<string, number>();
    for (const r of known) swimCounts.set(r.safety!.swim, (swimCounts.get(r.safety!.swim) ?? 0) + 1);
    const swim = modeOf(swimCounts, SWIM_SERIOUS_FIRST as readonly string[]);
    if (!swim) continue;

    beachDays++;
    hours += known.length;
    crossTab[flag][swim] = (crossTab[flag][swim] ?? 0) + 1;
    if (flag !== "yellow" && flag !== "green") continue;
    infDays++;
    if (flag === "yellow") {
      yellowDays++;
      if (swim === "safe") yellowSafe++;
      else agree++;
    } else {
      greenDays++;
      if (swim === "safe") agree++;
      else {
        greenCaution++;
        // The day's reason: the most common one among the hours that said so.
        const rc = new Map<string, number>();
        for (const r of known) {
          if (r.safety!.swim !== swim) continue;
          const k = cautionReason(r.rip);
          rc.set(k, (rc.get(k) ?? 0) + 1);
        }
        const top = [...rc].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
        if (top) reasons.set(top[0], (reasons.get(top[0]) ?? 0) + 1);
      }
    }
  }

  const ready = beachDays >= min;
  const infReady = infDays >= min;
  return {
    beachDays,
    hours,
    min,
    ready,
    collecting: ready ? null : collectingText(beachDays, min, "beach-days"),
    crossTab,
    informative: {
      beachDays: infDays,
      ready: infReady,
      collecting: infReady ? null : collectingText(infDays, min, "beach-days"),
      yellowDays,
      greenDays,
      agreeDays: agree,
      agreement: rateOf(agree, infDays, min, infReady),
      yellowWeSaidSafe: yellowSafe,
      greenWeCautioned: greenCaution,
      greenReasons: [...reasons].map(([reason, d]) => ({ reason, days: d })).sort((a, b) => b.days - a.days),
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
  /** Cams the offline rule hides on the page right now (lib/camStatus.ts); null = not checked. */
  camsOffline?: OfflineCam[] | null;
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
  /** Cams hidden on the page as offline, longest-down first; null = not checked. */
  camsOffline: OfflineCam[] | null;
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
    camsOffline: input.camsOffline ?? null,
    sunObs: input.sunObs,
    sunPredictionsLast24h: input.sunPredictionsLast24h,
  };
}
