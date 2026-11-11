// Parts A and B of the 2026-11-11 sun lead-time study.
//
//   npx vite-node -c vitest.config.ts docs/benchmarks/2026-11-11-sun-lead-time/scripts/lead_skill.ts
//
// A. Skill by lead: every stored forecast row of a graded event, re-scored with
//    the live model, graded by rank inside each cam, by lead bucket.
// B. A 2-hour forecast: the rebuilt satellite reads at five scan ages and the
//    rebuilt hourly forecasts from two model runs, on the same events.
// Writes eval.json (section "lead"), dataset.csv and predictions.csv.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sunBandOf } from "@/lib/scorecard/metrics";
import { SUN_QUALITY_VERSION } from "@/lib/sunQuality";
import {
  BENCH,
  csv,
  dayBootstrap,
  dedupe,
  eventFinder,
  fairRho,
  inpOfRow,
  liveScore,
  loadEvents,
  loadIr,
  loadRaw,
  loadRuns,
  loadSolarObs,
  camDistance,
  mean,
  median,
  paramScore,
  PEAK,
  quantile,
  r2,
  SHIPPED,
  type Ev,
  type Inp,
  type Kind,
  type Pair,
  type PredRow,
} from "./lib";
import { midRankPercentiles, nearestBeachPerCamEvent } from "@/lib/scorecard/metrics";

const events = loadEvents();
const find = eventFinder(events);
const KINDS: Kind[] = ["sunrise", "sunset"];

// --- Stored rows, re-scored ---------------------------------------------------

type Row = PredRow & { ev: Ev; re: number | null; src: "satellite-ir" | "forecast" };
const rows: Row[] = [];
let truthMismatch = 0;
let noEvent = 0;
for (const r of loadRaw<PredRow>("preds")) {
  const ev = find(r.slug, r.event_kind, r.event_iso);
  if (!ev) {
    noEvent++;
    continue;
  }
  const cam = /^sun-cam:([^:]+):solar$/.exec(r.observed_source ?? "")?.[1];
  if (cam !== ev.cam || Math.abs((r.observed_score ?? NaN) - ev.obs) > 0.51) truthMismatch++;
  const inp = inpOfRow(r);
  rows.push({ ...r, ev, re: inp ? liveScore(inp) : null, src: r.source === "satellite-ir" ? "satellite-ir" : "forecast" });
}
// The curves have not changed since 2026-11-05.1 (2026-11-11.1 only added the early look), so the
// live model must return the stored score of every 2026-11-05.1 row.
const CURVES_SINCE = "2026-11-05.1";
const cur = rows.filter((r) => r.algo_version === CURVES_SINCE && r.score != null && r.re != null);
const reproduce = { version: CURVES_SINCE, rows: cur.length, exact: cur.filter((r) => r.re === r.score).length };

const BUCKETS: { name: string; lo: number; hi: number }[] = [
  { name: "0–30 min", lo: 0, hi: 30 },
  { name: "30–60 min", lo: 30, hi: 60 },
  { name: "60–90 min", lo: 60, hi: 90 },
  { name: "90–120 min", lo: 90, hi: 120 },
  { name: "2–3 h", lo: 120, hi: 180 },
  { name: "3–6 h", lo: 180, hi: 360 },
  { name: "6–12 h", lo: 360, hi: 720 },
  { name: "12–24 h", lo: 720, hi: 1440 },
  { name: ">24 h", lo: 1440, hi: 1e9 },
];

/** One row per event in a lead bucket: the row nearest the middle of the bucket. */
function pickRows(rs: Row[], lo: number, hi: number, val: (r: Row) => number | null): Map<string, Row> {
  const mid = hi > 1e8 ? lo : (lo + hi) / 2;
  const out = new Map<string, Row>();
  for (const r of rs) {
    if (!(r.lead_minutes >= lo && r.lead_minutes < hi) || val(r) == null) continue;
    const c = out.get(r.ev.key);
    if (!c || Math.abs(r.lead_minutes - mid) < Math.abs(c.lead_minutes - mid)) out.set(r.ev.key, r);
  }
  return out;
}

function pairsOf(score: (e: Ev) => number | null | undefined, kind?: Kind): Pair[] {
  const pool = kind ? events.filter((e) => e.kind === kind) : events;
  return dedupe(pool, (e) => score(e) != null).map((ev) => ({ ev, pred: score(ev) as number }));
}

function grade(pairs: Pair[]) {
  const f = fairRho(pairs);
  const b = dayBootstrap(pairs, (p) => p.ev.date, (xs) => fairRho(xs).rho);
  return {
    rho: r2(f.rho),
    lo: r2(b.lo),
    hi: r2(b.hi),
    pPositive: r2(b.pPositive),
    events: f.events,
    cams: f.cams,
    days: new Set(pairs.map((p) => p.ev.date)).size,
    pairsLoaded: pairs.length,
    perCam: f.perCam,
  };
}

function gradeAll(score: (e: Ev) => number | null | undefined) {
  return { all: grade(pairsOf(score)), sunrise: grade(pairsOf(score, "sunrise")), sunset: grade(pairsOf(score, "sunset")) };
}

/** rho(a) - rho(b) on the events that have both, with a day-bootstrap interval. */
function paired(a: (e: Ev) => number | null | undefined, b: (e: Ev) => number | null | undefined, kind?: Kind) {
  const pool = kind ? events.filter((e) => e.kind === kind) : events;
  const both = dedupe(pool, (e) => a(e) != null && b(e) != null);
  const pa = (xs: Ev[]) => fairRho(xs.map((ev) => ({ ev, pred: a(ev) as number })));
  const pb = (xs: Ev[]) => fairRho(xs.map((ev) => ({ ev, pred: b(ev) as number })));
  const d = dayBootstrap(both, (e) => e.date, (xs) => {
    const x = pa(xs).rho;
    const y = pb(xs).rho;
    return x == null || y == null ? null : x - y;
  });
  return { a: r2(pa(both).rho), b: r2(pb(both).rho), diff: r2(d.value), lo: r2(d.lo), hi: r2(d.hi), pPositive: r2(d.pPositive), events: pa(both).events, days: d.nDays };
}

// --- A. Skill by lead ---------------------------------------------------------

const byLead = BUCKETS.map((b) => {
  const re = pickRows(rows, b.lo, b.hi, (r) => r.re);
  const stored = pickRows(rows, b.lo, b.hi, (r) => r.score);
  const sat = pickRows(rows.filter((r) => r.src === "satellite-ir"), b.lo, b.hi, (r) => r.re);
  const fc = pickRows(rows.filter((r) => r.src === "forecast"), b.lo, b.hi, (r) => r.re);
  const leads = [...re.values()].map((r) => r.lead_minutes);
  return {
    bucket: b.name,
    medianLead: median(leads),
    rescored: gradeAll((e) => re.get(e.key)?.re),
    asStored: grade(pairsOf((e) => stored.get(e.key)?.score)),
    satellite: gradeAll((e) => sat.get(e.key)?.re),
    forecast: gradeAll((e) => fc.get(e.key)?.re),
  };
});

// Same sunrises at every lead (sunsets have almost no stored row inside 6 h).
const leadSets = BUCKETS.filter((b) => ["0–30 min", "60–90 min", "2–3 h", "3–6 h", "6–12 h", "12–24 h"].includes(b.name)).map((b) => ({
  name: b.name,
  m: pickRows(rows, b.lo, b.hi, (r) => r.re),
}));
const sameSunrises = (() => {
  const has = (e: Ev) => leadSets.every((s) => s.m.get(e.key)?.re != null);
  const both = dedupe(events.filter((e) => e.kind === "sunrise"), has);
  return {
    events: both.length,
    days: new Set(both.map((e) => e.date)).size,
    byLead: leadSets.map((s) => {
      const pairs = both.map((ev) => ({ ev, pred: s.m.get(ev.key)!.re as number }));
      const g = grade(pairs);
      return { bucket: s.name, rho: g.rho, lo: g.lo, hi: g.hi, events: g.events, cams: g.cams };
    }),
    vs60to90: leadSets
      .filter((s) => s.name !== "60–90 min")
      .map((s) => ({ bucket: s.name, ...paired((e) => s.m.get(e.key)?.re, (e) => leadSets[1].m.get(e.key)?.re, "sunrise") })),
  };
})();

// --- B. Rebuilt inputs --------------------------------------------------------

const ir = loadIr();
const runs = loadRuns();
const OFFSETS = [20, 75, 105, 135, 195] as const;
/** What the app holds this many minutes before the event, for a scan of that age. */
const APP_LEAD: Record<number, string> = { 20: "about 5 min", 75: "60 min (today's opening)", 105: "90 min", 135: "120 min", 195: "180 min" };

// Aerosol and humidity are not in the satellite read: take them from the event's newest stored row.
const air = new Map<string, { aod: number | null; pm: number | null; hum: number | null }>();
for (const r of [...rows].sort((a, b) => b.lead_minutes - a.lead_minutes)) {
  if (r.lead_minutes < 0) continue;
  air.set(r.ev.key, { aod: r.aod, pm: r.pm2_5, hum: r.humidity_pct });
}
const withAir = (e: Ev, i: Inp): Inp => ({ ...i, aod: air.get(e.key)?.aod ?? null, pm: air.get(e.key)?.pm ?? null, hum: i.hum ?? air.get(e.key)?.hum ?? null });

const irInp = (e: Ev, off: number): Inp | null => {
  const v = ir.get(`${e.slug}|${e.kind}|${e.eventIso}|${off}`);
  return v ? withAir(e, v.inp) : null;
};
const runInp = (e: Ev, tag: "late" | "early"): Inp | null => {
  const v = runs.get(`${e.slug}|${e.kind}|${e.eventIso}|${tag}`);
  return v ? withAir(e, v.inp) : null;
};
const memo = new Map<string, number | null>();
const sc = (e: Ev, name: string, inp: () => Inp | null): number | null => {
  const k = `${e.key}|${name}`;
  if (!memo.has(k)) {
    const i = inp();
    memo.set(k, i ? liveScore(i) : null);
  }
  return memo.get(k) as number | null;
};
const irScore = (off: number) => (e: Ev) => sc(e, `ir${off}`, () => irInp(e, off));
const runScore = (tag: "late" | "early") => (e: Ev) => sc(e, `run-${tag}`, () => runInp(e, tag));
const blend = (a: (e: Ev) => number | null, b: (e: Ev) => number | null, w = 0.5) => (e: Ev) => {
  const x = a(e);
  const y = b(e);
  return x == null || y == null ? null : Math.round(w * x + (1 - w) * y);
};
/** The stored forecast-sourced row 2–3 h ahead (sunrises have one; sunsets almost never). */
const stored2h = pickRows(rows.filter((r) => r.src === "forecast"), 120, 180, (r) => r.re);
const stored2hScore = (e: Ev) => stored2h.get(e.key)?.re ?? null;

const satelliteByScanAge = OFFSETS.map((off) => ({ scanAgeMin: off, appLead: APP_LEAD[off], ...gradeAll(irScore(off)) }));
const hasAllIr = (e: Ev) => OFFSETS.every((o) => irScore(o)(e) != null);
const satelliteSameEvents = {
  events: dedupe(events, hasAllIr).length,
  byScanAge: OFFSETS.map((off) => {
    const pairs = dedupe(events, hasAllIr).map((ev) => ({ ev, pred: irScore(off)(ev) as number }));
    const g = grade(pairs);
    return { scanAgeMin: off, rho: g.rho, lo: g.lo, hi: g.hi, events: g.events };
  }),
  vsAge75: OFFSETS.filter((o) => o !== 75).map((off) => ({ scanAgeMin: off, all: paired(irScore(off), irScore(75)), sunrise: paired(irScore(off), irScore(75), "sunrise"), sunset: paired(irScore(off), irScore(75), "sunset") })),
};

const forecastRuns = {
  late: gradeAll(runScore("late")),
  early: gradeAll(runScore("early")),
  lateRunHoursBeforeEvent: r2(median(events.map((e) => runs.get(`${e.slug}|${e.kind}|${e.eventIso}|late`)?.lead_from_run_min ?? NaN).filter(Number.isFinite)) as number / 60),
  // Does the rebuilt run stand in for the stored forecast? Sunrises have both.
  checkAgainstStored: (() => {
    const es = events.filter((e) => stored2hScore(e) != null && runScore("late")(e) != null);
    const a = es.map((e) => stored2hScore(e) as number);
    const b = es.map((e) => runScore("late")(e) as number);
    const ma = mean(a) as number;
    const mb = mean(b) as number;
    const cov = a.reduce((s, x, i) => s + (x - ma) * (b[i] - mb), 0);
    const va = a.reduce((s, x) => s + (x - ma) ** 2, 0);
    const vb = b.reduce((s, x) => s + (x - mb) ** 2, 0);
    return { events: es.length, pearson: r2(cov / Math.sqrt(va * vb)), meanAbsDiff: r2(mean(a.map((x, i) => Math.abs(x - b[i])))), sameBandShare: r2(es.filter((_, i) => sunBandOf(a[i]) === sunBandOf(b[i])).length / es.length) };
  })(),
};

// The three 2-hour candidates, on the events that have all of them.
const fc2h = runScore("late");
const sat2h = irScore(135);
const blend2h = blend(sat2h, fc2h);
const candidates2h = {
  note: "forecast = hourly forecast from the model run about 5 to 11 h before the event; satellite = the scan 135 min before the event (what the app holds 120 min out), carried forward; blend = the mean of the two scores",
  forecast: gradeAll(fc2h),
  satellitePersistence: gradeAll(sat2h),
  blend: gradeAll(blend2h),
  storedForecastRow2to3h: gradeAll(stored2hScore),
  reference: { at60min_satellite: gradeAll(irScore(75)), at5min_satellite: gradeAll(irScore(20)) },
  paired: Object.fromEntries(
    (["all", "sunrise", "sunset"] as const).map((k) => {
      const kind = k === "all" ? undefined : k;
      return [
        k,
        {
          satellite_minus_forecast: paired(sat2h, fc2h, kind),
          blend_minus_forecast: paired(blend2h, fc2h, kind),
          blend_minus_satellite: paired(blend2h, sat2h, kind),
          satellite120_minus_satellite60: paired(sat2h, irScore(75), kind),
          blend120_minus_satellite60: paired(blend2h, irScore(75), kind),
          forecast_minus_satellite60: paired(fc2h, irScore(75), kind),
          satellite60_minus_satellite5: paired(irScore(75), irScore(20), kind),
        },
      ];
    }),
  ),
  // The weight is NOT fitted for the shipped rule (0.5 is the neutral choice). This sweep is in-sample, for information.
  blendWeightSweep: [0, 0.25, 0.5, 0.75, 1].map((w) => ({ satelliteWeight: w, rho: r2(fairRho(pairsOf(blend(sat2h, fc2h, w))).rho) })),
};

// Sensitivity: the same comparison with the "no sweet spot" canvas of the tuning study (tune.ts).
const FLAT = { ...SHIPPED, c0: PEAK };
const flatOf = (inp: (e: Ev) => Inp | null) => (e: Ev) => {
  const i = inp(e);
  return i ? paramScore(i, FLAT) : null;
};
const noSweetSpot = (() => {
  const s60 = flatOf((e) => irInp(e, 75));
  const s120 = flatOf((e) => irInp(e, 135));
  const f = flatOf((e) => runInp(e, "late"));
  const b = blend(s120, f);
  const g = (x: (e: Ev) => number | null) => { const r = grade(pairsOf(x)); return { rho: r.rho, lo: r.lo, hi: r.hi, events: r.events }; };
  return {
    satelliteByScanAge: OFFSETS.map((off) => ({ scanAgeMin: off, ...g(flatOf((e) => irInp(e, off))) })),
    forecast: g(f),
    blend120: g(b),
    blend120_minus_satellite60: paired(b, s60),
    satellite120_minus_satellite60: paired(s120, s60),
    blend_minus_forecast: paired(b, f),
    blend_minus_satellite: paired(b, s120),
  };
})();

// A blend of the INPUTS (mean of the two cloud mixes, scored once) instead of the scores.
const inputBlend2h = (e: Ev) => {
  const a = irInp(e, 135);
  const b = runInp(e, "late");
  if (!a || !b) return null;
  const m = (x: number | null, y: number | null) => (x == null || y == null ? null : (x + y) / 2);
  return liveScore({ ...a, low: (a.low + b.low) / 2, mid: (a.mid + b.mid) / 2, high: (a.high + b.high) / 2, total: m(a.total, b.total) });
};
const inputBlend = { ...gradeAll(inputBlend2h), minusScoreBlend: paired(inputBlend2h, blend2h) };

// Sensitivity: every solar cam as its own truth (not only the nearest one), each cam still counted once per day.
const allCams = (() => {
  const obs = loadSolarObs().map((o) => ({ key: `${o.slug}|${o.event_kind}|${o.event_date_local}`, slug: o.slug, kind: o.event_kind, date: o.event_date_local, eventIso: o.event_iso, eventMs: Date.parse(o.event_iso), cam: o.cam_id, obs: o.observed_score }) as Ev);
  const g = (score: (e: Ev) => number | null) => {
    const kept = nearestBeachPerCamEvent(obs, (e) => ({ cam: e.cam, kind: e.kind, date: e.date, slug: e.slug }), camDistance, (e) => score(e) != null);
    const pairs = obs.filter((e) => kept.has(e) && score(e) != null).map((ev) => ({ ev, pred: score(ev) as number }));
    const f = grade(pairs);
    return { rho: f.rho, lo: f.lo, hi: f.hi, events: f.events, cams: f.cams };
  };
  return { satellite5min: g(irScore(20)), satellite60min: g(irScore(75)), satellite120min: g(irScore(135)), forecast: g(fc2h), blend120min: g(blend2h) };
})();

// --- A coarse outlook: can a forecast hours ahead tell a gray sky from the rest? ---
// Each event's percentile on its own cam (0 = that cam's dullest sky, 1 = its best).
const pct = new Map<string, number>();
{
  const groups = new Map<string, Ev[]>();
  for (const e of dedupe(events, () => true)) groups.set(`${e.cam}|${e.kind}`, [...(groups.get(`${e.cam}|${e.kind}`) ?? []), e]);
  for (const g of groups.values()) {
    if (g.length < 8) continue;
    const p = midRankPercentiles(g.map((e) => e.obs));
    g.forEach((e, i) => pct.set(e.key, p[i]));
  }
}
function outlookSplit(score: (e: Ev) => number | null | undefined) {
  const xs = dedupe(events, (e) => score(e) != null && pct.has(e.key));
  const low = (e: Ev) => (score(e) as number) < 45; // Fair or Poor
  const part = (f: (e: Ev) => boolean) => xs.filter(f);
  const m = (ys: Ev[]) => mean(ys.map((e) => pct.get(e.key) as number));
  const d = dayBootstrap(xs, (e) => e.date, (s) => {
    const a = s.filter((e) => !low(e));
    const b = s.filter(low);
    return a.length < 5 || b.length < 5 ? null : (m(a) as number) - (m(b) as number);
  });
  return {
    events: xs.length,
    saidGoodOrBetter: { events: part((e) => !low(e)).length, meanCamPercentile: r2(m(part((e) => !low(e)))) },
    saidFairOrPoor: { events: part(low).length, meanCamPercentile: r2(m(part(low))), inCamsBottomThird: r2(part(low).filter((e) => (pct.get(e.key) as number) < 1 / 3).length / Math.max(1, part(low).length)) },
    difference: { diff: r2(d.value), lo: r2(d.lo), hi: r2(d.hi), pPositive: r2(d.pPositive) },
  };
}
const pick = (lo: number, hi: number) => {
  const m = pickRows(rows.filter((r) => r.src === "forecast"), lo, hi, (r) => r.re);
  return (e: Ev) => m.get(e.key)?.re;
};
const outlook = {
  note: "the forecast's score cut at 45 (Good or better against Fair or Poor), against each event's percentile on its own cam",
  stored6to12h: outlookSplit(pick(360, 720)),
  stored12to24h: outlookSplit(pick(720, 1440)),
  rebuiltRun5to11hBefore: outlookSplit(runScore("late")),
  rebuiltRun11to17hBefore: outlookSplit(runScore("early")),
  earlyLook120min: outlookSplit(blend2h),
  satellite60min: outlookSplit(irScore(75)),
};

// --- Stability: how much the number moves between leads -----------------------

function moves(pairs: [number, number][]) {
  const d = pairs.map(([a, b]) => Math.abs(a - b)).sort((x, y) => x - y);
  return {
    n: pairs.length,
    medianAbs: r2(median(d)),
    meanAbs: r2(mean(d)),
    p90Abs: r2(d.length ? quantile(d, 0.9) : null),
    bandChangeShare: r2(pairs.length ? pairs.filter(([a, b]) => sunBandOf(a) !== sunBandOf(b)).length / pairs.length : null),
    move15Share: r2(pairs.length ? pairs.filter(([a, b]) => Math.abs(a - b) >= 15).length / pairs.length : null),
    twoBandShare: r2(pairs.length ? pairs.filter(([a, b]) => Math.abs(BANDS.indexOf(sunBandOf(a)) - BANDS.indexOf(sunBandOf(b))) >= 2).length / pairs.length : null),
  };
}
const BANDS = ["dud", "plain", "good", "vivid", "epic"];

// (a) What the app archived, all beaches, re-scored with the live model.
const near = loadRaw<PredRow>("near").map((r) => ({ ...r, key: `${r.slug}|${r.event_kind}|${r.event_iso.slice(0, 16)}`, re: (() => { const i = inpOfRow(r); return i ? liveScore(i) : null; })() }));
function nearPick(lo: number, hi: number, kind?: Kind) {
  const mid = (lo + hi) / 2;
  const out = new Map<string, (typeof near)[number]>();
  for (const r of near) {
    if (r.re == null || !(r.lead_minutes >= lo && r.lead_minutes < hi) || (kind && r.event_kind !== kind)) continue;
    const c = out.get(r.key);
    if (!c || Math.abs(r.lead_minutes - mid) < Math.abs(c.lead_minutes - mid)) out.set(r.key, r);
  }
  return out;
}
function nearMoves(a: [number, number], b: [number, number], kind?: Kind) {
  const A = nearPick(a[0], a[1], kind);
  const B = nearPick(b[0], b[1], kind);
  const ps: [number, number][] = [];
  for (const [k, r] of A) if (B.has(k)) ps.push([r.re as number, B.get(k)!.re as number]);
  return moves(ps);
}
const stabilityStored = Object.fromEntries(
  (["all", "sunrise", "sunset"] as const).map((k) => {
    const kind = k === "all" ? undefined : k;
    return [k, { "2–3 h → 60–90 min": nearMoves([120, 180], [60, 90], kind), "60–90 min → 0–30 min": nearMoves([60, 90], [0, 30], kind), "2–3 h → 0–30 min": nearMoves([120, 180], [0, 30], kind) }];
  }),
);

// (b) Rebuilt inputs on graded events (both kinds).
function evMoves(a: (e: Ev) => number | null, b: (e: Ev) => number | null, kind?: Kind) {
  const ps: [number, number][] = [];
  for (const e of events) {
    if (kind && e.kind !== kind) continue;
    const x = a(e);
    const y = b(e);
    if (x != null && y != null) ps.push([x, y]);
  }
  return moves(ps);
}
const stabilityRebuilt = Object.fromEntries(
  (["all", "sunrise", "sunset"] as const).map((k) => {
    const kind = k === "all" ? undefined : k;
    return [
      k,
      {
        "today: satellite at 60 min → at 5 min": evMoves(irScore(75), irScore(20), kind),
        "satellite at 120 min → at 60 min": evMoves(sat2h, irScore(75), kind),
        "satellite at 120 min → at 5 min": evMoves(sat2h, irScore(20), kind),
        "forecast at 120 min → satellite at 60 min": evMoves(fc2h, irScore(75), kind),
        "forecast at 120 min → satellite at 5 min": evMoves(fc2h, irScore(20), kind),
        "blend at 120 min → satellite at 60 min": evMoves(blend2h, irScore(75), kind),
        "blend at 120 min → satellite at 5 min": evMoves(blend2h, irScore(20), kind),
        "satellite at 180 min → at 5 min": evMoves(irScore(195), irScore(20), kind),
      },
    ];
  }),
);

// --- Output -------------------------------------------------------------------

const dedupAll = new Set(dedupe(events, () => true).map((e) => e.key));
const out = {
  generatedFor: "docs/benchmarks/2026-11-11-sun-lead-time",
  model: SUN_QUALITY_VERSION,
  data: {
    gradedEvents: events.length,
    gradedAfterSharedCamRule: dedupAll.size,
    sunrise: events.filter((e) => e.kind === "sunrise" && dedupAll.has(e.key)).length,
    sunset: events.filter((e) => e.kind === "sunset" && dedupAll.has(e.key)).length,
    days: new Set(events.map((e) => e.date)).size,
    firstDay: events[0]?.date,
    lastDay: events[events.length - 1]?.date,
    truthCams: new Set(events.map((e) => e.cam)).size,
    storedRows: rows.length,
    // Rows whose stored truth is an afterglow (away-from-the-sun) reading: never graded.
    storedRowsAfterglowTruthLeftOut: noEvent,
    truthMismatchRows: truthMismatch,
    liveModelReproducesStoredScore: reproduce,
    satelliteReads: ir.size,
    forecastRunReads: runs.size,
  },
  A: { byLead, sameSunrises },
  B: { satelliteByScanAge, satelliteSameEvents, forecastRuns, candidates2h, inputBlend, noSweetSpot, allCams },
  outlook,
  stability: { stored: stabilityStored, rebuilt: stabilityRebuilt },
};
const evalPath = join(BENCH, "eval.json");
const prev = existsSync(evalPath) ? (JSON.parse(readFileSync(evalPath, "utf8")) as Record<string, unknown>) : {};
writeFileSync(evalPath, JSON.stringify({ ...prev, lead: out }, null, 1) + "\n");

writeFileSync(
  join(BENCH, "dataset.csv"),
  csv(
    events.map((e) => {
      const row: Record<string, unknown> = { slug: e.slug, kind: e.kind, date: e.date, event_iso: e.eventIso, truth_cam: e.cam, cam_score: e.obs, counted: dedupAll.has(e.key) ? 1 : 0, aod: air.get(e.key)?.aod ?? null, pm2_5: air.get(e.key)?.pm ?? null };
      for (const off of OFFSETS) {
        const v = ir.get(`${e.slug}|${e.kind}|${e.eventIso}|${off}`);
        const p = `sat${off}`;
        Object.assign(row, { [`${p}_scan`]: v?.granuleStartIso ?? null, [`${p}_low`]: v?.inp.low ?? null, [`${p}_mid`]: v?.inp.mid ?? null, [`${p}_high`]: v?.inp.high ?? null, [`${p}_total`]: v?.inp.total ?? null, [`${p}_path_low`]: v?.inp.beamLow ?? null, [`${p}_sunward_midhigh`]: v?.sunwardMidHigh ?? null, [`${p}_score`]: irScore(off)(e) });
      }
      for (const tag of ["late", "early"] as const) {
        const v = runs.get(`${e.slug}|${e.kind}|${e.eventIso}|${tag}`);
        const p = `run_${tag}`;
        Object.assign(row, { [`${p}_start`]: v?.run ?? null, [`${p}_low`]: v?.inp.low ?? null, [`${p}_mid`]: v?.inp.mid ?? null, [`${p}_high`]: v?.inp.high ?? null, [`${p}_total`]: v?.inp.total ?? null, [`${p}_humidity`]: v?.inp.hum ?? null, [`${p}_score`]: runScore(tag)(e) });
      }
      row.blend120_score = blend2h(e);
      return row;
    }),
  ),
);
writeFileSync(
  join(BENCH, "predictions.csv"),
  csv(
    rows.map((r) => ({
      slug: r.slug,
      kind: r.event_kind,
      event_iso: r.event_iso,
      as_of_hour_utc: r.as_of_hour_utc,
      lead_minutes: r.lead_minutes,
      source: r.src,
      algo_version: r.algo_version,
      stored_score: r.score,
      live_model_score: r.re,
      low: r.low_cloud_pct,
      mid: r.mid_cloud_pct,
      high: r.high_cloud_pct,
      total: r.total_cloud_pct,
      path_low: r.source === "satellite-ir" && r.horizon_source === "ir-beam" ? r.horizon_cloud_pct : null,
      humidity: r.humidity_pct,
      aod: r.aod,
      pm2_5: r.pm2_5,
      truth_cam: r.ev.cam,
      cam_score: r.ev.obs,
    })),
  ),
);

// A short console view.
const line = (name: string, g: { rho: number | null; lo: number | null; hi: number | null; events: number; cams: number; days?: number }) =>
  console.log(`${name.padEnd(46)} rho ${String(g.rho).padStart(5)}  [${g.lo}, ${g.hi}]  n=${g.events} cams=${g.cams} days=${g.days ?? ""}`);
console.log(JSON.stringify(out.data));
for (const b of byLead) {
  line(`${b.bucket} all`, b.rescored.all);
  line(`   sunrise`, b.rescored.sunrise);
  line(`   sunset`, b.rescored.sunset);
  line(`   satellite`, b.satellite.all);
  line(`   forecast`, b.forecast.all);
}
for (const s of satelliteByScanAge) {
  line(`satellite scan age ${s.scanAgeMin} all`, s.all);
  line(`   sunrise`, s.sunrise);
  line(`   sunset`, s.sunset);
}
line("forecast run late all", forecastRuns.late.all);
line("   sunrise", forecastRuns.late.sunrise);
line("   sunset", forecastRuns.late.sunset);
line("forecast run early all", forecastRuns.early.all);
line("blend 120 all", candidates2h.blend.all);
line("   sunrise", candidates2h.blend.sunrise);
line("   sunset", candidates2h.blend.sunset);
console.log(JSON.stringify(candidates2h.paired, null, 1));
console.log(JSON.stringify(out.stability, null, 1));
console.log(JSON.stringify({ outlook, noSweetSpot, inputBlend: { all: inputBlend.all.rho, d: inputBlend.minusScoreBlend }, sameSunrises, allCams, check: forecastRuns.checkAgainstStored, sweep: candidates2h.blendWeightSweep }, null, 1));
