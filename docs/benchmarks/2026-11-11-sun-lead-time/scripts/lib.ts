// Shared helpers for the 2026-11-11 sun lead-time study. Run with vite-node from
// the repo root (see REPORT.md "Reproduce"). The grading rules are the
// scorecard's own (lib/scorecard/metrics.ts): rank inside each cam, one truth
// cam per event, a shared cam counted once. The model is the live one
// (lib/sunQuality.ts), so old rows are judged on today's formula.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lowCloudClearPath, SUN_CANVAS_CURVE, SUN_OVERCAST_FLOOR, SUN_OVERCAST_START_PCT, SUN_PATH_FLOOR, sunEventQuality } from "@/lib/sunQuality";
import { MIN_CAM_RANK_EVENTS, nearestBeachPerCamEvent, spearman } from "@/lib/scorecard/metrics";
import { SUN_CAMS } from "@/lib/sunObservations";
import { IR_MAX_UNCLASSIFIED_PCT } from "@/lib/sunAlert";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const BENCH = resolve(HERE, "..");
export const RAW = join(BENCH, "raw");

export type Kind = "sunrise" | "sunset";

/** One graded event: a beach's sunrise or sunset with its one truth cam (solar view). */
export interface Ev {
  key: string; // slug|kind|local date
  slug: string;
  kind: Kind;
  date: string; // beach-local day
  eventIso: string;
  eventMs: number;
  cam: string;
  obs: number;
}

/** What the model is handed. */
export interface Inp {
  low: number;
  mid: number;
  high: number;
  total: number | null;
  /** Low cloud along the sun's path, when the satellite read it (scored as verified). */
  beamLow?: number | null;
  /** Satellite read without a path read: the model estimates the path from overhead low cloud. */
  aod?: number | null;
  pm?: number | null;
  hum?: number | null;
}

export interface PredRow {
  slug: string;
  event_kind: Kind;
  event_iso: string;
  as_of_hour_utc: string;
  lead_minutes: number;
  score: number | null;
  model_path?: string | null;
  low_cloud_pct: number | null;
  mid_cloud_pct: number | null;
  high_cloud_pct: number | null;
  total_cloud_pct: number | null;
  humidity_pct: number | null;
  aod: number | null;
  pm2_5: number | null;
  horizon_cloud_pct: number | null;
  horizon_source: string | null;
  algo_version: string;
  source: string | null;
  observed_score?: number | null;
  observed_source?: string | null;
}

/** One wrangler `--json` export (plain or gzipped, as committed). */
const wr = (name: string): Record<string, unknown>[] => {
  const buf = readFileSync(join(RAW, name));
  const text = name.endsWith(".gz") ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
  return (JSON.parse(text) as { results: Record<string, unknown>[] }[])[0].results;
};

export function loadRaw<T>(prefix: string): T[] {
  return readdirSync(RAW)
    .filter((f) => f.startsWith(prefix) && (f.endsWith(".json") || f.endsWith(".json.gz")))
    .sort()
    .flatMap((f) => wr(f) as T[]);
}

const camMiles = new Map(SUN_CAMS.flatMap((c) => c.beaches.map((b) => [`${c.id}|${b.slug}`, b.distance_mi] as const)));
export const camDistance = (cam: string, slug: string): number | undefined => camMiles.get(`${cam}|${slug}`);

interface ObsRow {
  slug: string;
  event_kind: Kind;
  event_date_local: string;
  cam_id: string;
  event_iso: string;
  view: string;
  distance_mi: number;
  observed_score: number;
}

/** Every solar-view reading (one per beach, event and cam). */
export function loadSolarObs(): ObsRow[] {
  return loadRaw<ObsRow>("obs").filter((o) => o.view === "solar");
}

/**
 * The graded events: the server's own truth pick (solar view; smallest
 * distance, then cam id; docs/SUN_CAM_CHECK.md "Filling the predictions").
 */
export function loadEvents(): Ev[] {
  const best = new Map<string, ObsRow>();
  for (const o of loadSolarObs()) {
    const k = `${o.slug}|${o.event_kind}|${o.event_date_local}`;
    const cur = best.get(k);
    if (!cur || o.distance_mi < cur.distance_mi || (o.distance_mi === cur.distance_mi && o.cam_id < cur.cam_id)) best.set(k, o);
  }
  return [...best.entries()]
    .map(([key, o]) => ({
      key,
      slug: o.slug,
      kind: o.event_kind,
      date: o.event_date_local,
      eventIso: o.event_iso,
      eventMs: Date.parse(o.event_iso),
      cam: o.cam_id,
      obs: o.observed_score,
    }))
    .sort((a, b) => a.eventMs - b.eventMs || (a.slug < b.slug ? -1 : 1));
}

/** Index events for joining forecast rows: same beach and kind, event times within 15 min. */
export function eventFinder(events: Ev[]): (slug: string, kind: string, eventIso: string) => Ev | undefined {
  const by = new Map<string, Ev[]>();
  for (const e of events) {
    const k = `${e.slug}|${e.kind}`;
    by.set(k, [...(by.get(k) ?? []), e]);
  }
  return (slug, kind, eventIso) => {
    const t = Date.parse(eventIso);
    return (by.get(`${slug}|${kind}`) ?? []).find((e) => Math.abs(e.eventMs - t) <= 15 * 60_000);
  };
}

const n = (v: number | null | undefined): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Score an input with the LIVE model. null when the model has no complete reading. */
export function liveScore(i: Inp): number | null {
  return sunEventQuality({
    cloud: { lowPct: i.low, midPct: i.mid, highPct: i.high, totalPct: n(i.total) },
    humidityPct: n(i.hum),
    aod: n(i.aod),
    pm2_5: n(i.pm),
    horizon: i.beamLow != null ? { cloudPct: i.beamLow, fresh: true } : undefined,
  }).score;
}

/** The input a stored forecast row carried (the satellite path read only when it was scored). */
export function inpOfRow(r: PredRow): Inp | null {
  if (r.low_cloud_pct == null || r.mid_cloud_pct == null || r.high_cloud_pct == null) return null;
  return {
    low: r.low_cloud_pct,
    mid: r.mid_cloud_pct,
    high: r.high_cloud_pct,
    total: r.total_cloud_pct,
    beamLow: r.source === "satellite-ir" && r.horizon_source === "ir-beam" ? r.horizon_cloud_pct : null,
    aod: r.aod,
    pm: r.pm2_5,
    hum: r.humidity_pct,
  };
}

export interface IrRead {
  granuleStartIso: string;
  inp: Inp;
  sunwardMidHigh: number | null;
  antiMidHigh: number | null;
}

/**
 * The rebuilt satellite reads, keyed `slug|kind|eventIso|offset`. A read the
 * app would refuse (too many cloudy pixels with no height) is dropped, as
 * lib/sunAlert.ts resolveIrObservation does.
 */
export function loadIr(): Map<string, IrRead> {
  const out = new Map<string, IrRead>();
  const files = [join(BENCH, "ir_backfill.json"), ...readdirSync(RAW).filter((f) => /^ir_backfill\.\d+\.json$/.test(f)).map((f) => join(RAW, f))];
  for (const f of files) {
    if (!existsSync(f)) continue;
    const j = JSON.parse(readFileSync(f, "utf8")) as Record<string, { granuleStartIso: string; ir: Record<string, unknown> | null } | null>;
    for (const [k, v] of Object.entries(j)) {
      const ir = v?.ir as
        | { lowPct: number; midPct: number; highPct: number; irCloudPct: number; unclassifiedPct?: number | null; events?: Record<string, { beamLowPct: number | null; beamMidHighPct: number | null; antiMidHighPct: number | null }> }
        | null
        | undefined;
      if (!v || !ir) continue;
      if (ir.unclassifiedPct != null && ir.unclassifiedPct > IR_MAX_UNCLASSIFIED_PCT) continue;
      const kind = k.split("|")[1];
      const path = ir.events?.[kind];
      out.set(k, {
        granuleStartIso: v.granuleStartIso,
        inp: { low: ir.lowPct, mid: ir.midPct, high: ir.highPct, total: ir.irCloudPct, beamLow: path?.beamLowPct ?? null },
        sunwardMidHigh: path?.beamMidHighPct ?? null,
        antiMidHigh: path?.antiMidHighPct ?? null,
      });
    }
  }
  return out;
}

export interface RunRead {
  run: string;
  lead_from_run_min: number;
  inp: Inp;
}

/** The rebuilt hourly forecasts from two earlier model runs, keyed `slug|kind|eventIso|late|early`. */
export function loadRuns(): Map<string, RunRead> {
  const out = new Map<string, RunRead>();
  for (const f of [join(BENCH, "om_runs.json"), join(RAW, "om_runs.json")]) {
    if (!existsSync(f)) continue;
    const j = JSON.parse(readFileSync(f, "utf8")) as Record<string, { run: string; lead_from_run_min: number; total: number | null; low: number | null; mid: number | null; high: number | null; humidity: number | null }>;
    for (const [k, v] of Object.entries(j)) {
      if (v.low == null || v.mid == null || v.high == null) continue;
      out.set(k, { run: v.run, lead_from_run_min: v.lead_from_run_min, inp: { low: v.low, mid: v.mid, high: v.high, total: v.total, hum: v.humidity } });
    }
    break;
  }
  return out;
}

// --- The model with its numbers as parameters ---------------------------------
// A copy of lib/sunQuality.ts factorModelQuality. tune.ts proves that at the
// shipped numbers it returns the live model's score for every input.

export interface Params {
  /** Canvas value for a clear sky (0% mid/high). The peak is fixed at 86, so c0 = 86 means "no sweet spot". */
  c0: number;
  /** Canvas value at 100% mid/high. */
  tail: number;
  ovcStart: number;
  ovcFloor: number;
  pathFloor: number;
  /** How a total below its layers is raised: the shipped rule ("max"), not at all, or to the screen blend. */
  floor: "max" | "none" | "blend";
}
export const PEAK = SUN_CANVAS_CURVE[1][1];
export const SHIPPED: Params = { c0: SUN_CANVAS_CURVE[0][1], tail: SUN_CANVAS_CURVE[3][1], ovcStart: SUN_OVERCAST_START_PCT, ovcFloor: SUN_OVERCAST_FLOOR, pathFloor: SUN_PATH_FLOOR, floor: "max" };

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const screen = (a: number, b: number) => Math.round((1 - (1 - clamp(a, 0, 100) / 100) * (1 - clamp(b, 0, 100) / 100)) * 100);
function lerp(x: number, pts: [number, number][]): number {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) return pts[i - 1][1] + ((x - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0])) * (pts[i][1] - pts[i - 1][1]);
  return pts[pts.length - 1][1];
}
export function paramScore(i: Inp, p: Params): number {
  const low = clamp(i.low, 0, 100);
  const mid = clamp(i.mid, 0, 100);
  const high = clamp(i.high, 0, 100);
  const midHigh = screen(mid, high);
  const blend = screen(screen(low, mid), high);
  const total = i.total == null ? blend : p.floor === "max" ? Math.max(clamp(i.total, 0, 100), low, mid, high) : p.floor === "blend" ? Math.max(clamp(i.total, 0, 100), blend) : clamp(i.total, 0, 100);
  const canvas = lerp(midHigh, [[0, p.c0], [SUN_CANVAS_CURVE[1][0], PEAK], [SUN_CANVAS_CURVE[2][0], PEAK], [100, p.tail]]);
  const ovc = total <= p.ovcStart ? 1 : 1 - (1 - p.ovcFloor) * ((total - p.ovcStart) / (100 - p.ovcStart));
  const path = p.pathFloor + (1 - p.pathFloor) * (lowCloudClearPath(i.beamLow ?? low) / 100);
  let aero = 1;
  if (i.aod != null) aero *= i.aod < 0.15 ? 1.05 : clamp(1 - (i.aod - 0.15) * 0.5, 0.75, 1);
  if (i.pm != null && i.pm > 35) aero *= clamp(1 - (i.pm - 35) * 0.0035, 0.65, 1);
  const humid = i.aod != null || i.hum == null || i.hum <= 92 ? 1 : clamp(1 - (i.hum - 92) * 0.01, 0.92, 1);
  return Math.round(clamp(canvas * ovc * path * aero * humid, 0, 100));
}

// --- Grading ----------------------------------------------------------------

export interface Pair {
  ev: Ev;
  pred: number;
}

/** Keep one event per cam, kind and day (a shared cam counts once, for the nearest beach that has a forecast). */
export function dedupe(events: Ev[], usable: (e: Ev) => boolean): Ev[] {
  const kept = nearestBeachPerCamEvent(events, (e) => ({ cam: e.cam, kind: e.kind, date: e.date, slug: e.slug }), camDistance, usable);
  return events.filter((e) => kept.has(e) && usable(e));
}

export interface Fair {
  rho: number | null;
  events: number;
  cams: number;
  perCam: { cam: string; kind: Kind; pairs: number; rho: number | null }[];
}

/** The scorecard's fair grade: Spearman inside each cam (and kind) with enough pairs, averaged by pairs. */
export function fairRho(pairs: Pair[], camMin = MIN_CAM_RANK_EVENTS): Fair {
  const groups = new Map<string, Pair[]>();
  for (const p of pairs) {
    const k = `${p.ev.cam}|${p.ev.kind}`;
    const g = groups.get(k);
    if (g) g.push(p);
    else groups.set(k, [p]);
  }
  let sum = 0;
  let events = 0;
  let cams = 0;
  const perCam: Fair["perCam"] = [];
  for (const [k, ps] of groups) {
    const [cam, kind] = k.split("|") as [string, Kind];
    const rho = ps.length >= camMin ? spearman(ps.map((p) => p.pred), ps.map((p) => p.ev.obs)) : null;
    perCam.push({ cam, kind, pairs: ps.length, rho: rho == null ? null : Math.round(rho * 100) / 100 });
    if (rho == null) continue;
    sum += rho * ps.length;
    events += ps.length;
    cams++;
  }
  return { rho: events ? sum / events : null, events, cams, perCam };
}

/** Small seeded generator, so every interval in the report can be reproduced. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const quantile = (sorted: number[], q: number): number => {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};

export interface Interval {
  value: number | null;
  lo: number | null;
  hi: number | null;
  /** Share of resamples where the statistic is above zero. */
  pPositive: number | null;
  nDays: number;
}

/**
 * Bootstrap by DAY: all events on one calendar day share a sky, so whole days
 * are drawn with replacement. `stat` gets the resampled items. 90% interval.
 */
export function dayBootstrap<T>(items: T[], dateOf: (t: T) => string, stat: (xs: T[]) => number | null, reps = 2000, seed = 20261111): Interval {
  const byDay = new Map<string, T[]>();
  for (const it of items) byDay.set(dateOf(it), [...(byDay.get(dateOf(it)) ?? []), it]);
  const days = [...byDay.keys()].sort();
  const value = stat(items);
  const r = rng(seed);
  const vals: number[] = [];
  for (let b = 0; b < reps; b++) {
    const sample: T[] = [];
    for (let i = 0; i < days.length; i++) sample.push(...(byDay.get(days[Math.floor(r() * days.length)]) as T[]));
    const v = stat(sample);
    if (v != null && Number.isFinite(v)) vals.push(v);
  }
  vals.sort((a, b) => a - b);
  const ok = vals.length >= reps / 2;
  return {
    value,
    lo: ok ? quantile(vals, 0.05) : null,
    hi: ok ? quantile(vals, 0.95) : null,
    pPositive: ok ? vals.filter((v) => v > 0).length / vals.length : null,
    nDays: days.length,
  };
}

export const r2 = (v: number | null | undefined): number | null => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
export const median = (xs: number[]): number | null => (xs.length ? quantile([...xs].sort((a, b) => a - b), 0.5) : null);
export const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function csv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const cell = (v: unknown) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}
