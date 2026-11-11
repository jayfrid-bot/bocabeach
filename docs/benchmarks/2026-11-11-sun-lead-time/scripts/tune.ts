// Part C of the 2026-11-11 sun lead-time study: does all the cam data support a
// change to the model's numbers?
//
//   npx vite-node -c vitest.config.ts docs/benchmarks/2026-11-11-sun-lead-time/scripts/tune.ts
//
// Honest by construction:
//   - The search is a full grid, so it has no starting point (the shipped
//     values get no head start).
//   - Every candidate is graded out of sample two ways: fitted on the earlier
//     half of the days and graded on the later half; and leave-one-DAY-out.
//   - The grade is the scorecard's fair one (rank inside each cam). A rank
//     grade cannot see a change of scale, so this study can only test the
//     ORDER of skies, which is what the four questions are about.
// Input: the satellite read from the scan 20 min before the event (the input
// the 2026-11-05 recalibration used). Writes eval.json (section "tune").

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SUN_QUALITY_VERSION } from "@/lib/sunQuality";
import { midRankPercentiles, MIN_CAM_RANK_EVENTS } from "@/lib/scorecard/metrics";
import { BENCH, dayBootstrap, dedupe, eventFinder, fairRho, inpOfRow, liveScore, loadEvents, loadIr, loadRaw, loadRuns, mean, paramScore, PEAK, r2, screen, SHIPPED, type Ev, type Inp, type Kind, type Params, type PredRow } from "./lib";

// --- Data ----------------------------------------------------------------------

const allEvents = loadEvents();
const ir = loadIr();
const find = eventFinder(allEvents);
const air = new Map<string, { aod: number | null; pm: number | null; hum: number | null }>();
const stored = loadRaw<PredRow>("preds");
for (const r of [...stored].sort((a, b) => b.lead_minutes - a.lead_minutes)) {
  const ev = find(r.slug, r.event_kind, r.event_iso);
  if (ev && r.lead_minutes >= 0) air.set(ev.key, { aod: r.aod, pm: r.pm2_5, hum: r.humidity_pct });
}
const inpAt = (e: Ev, off: number): Inp | null => {
  const v = ir.get(`${e.slug}|${e.kind}|${e.eventIso}|${off}`);
  return v ? { ...v.inp, ...(air.get(e.key) ?? {}) } : null;
};
type Item = { ev: Ev; inp: Inp };
const items: Item[] = dedupe(allEvents, (e) => inpAt(e, 20) != null).map((ev) => ({ ev, inp: inpAt(ev, 20) as Inp }));
const days = [...new Set(items.map((i) => i.ev.date))].sort();

const check = { inputs: items.length, same: items.filter((i) => paramScore(i.inp, SHIPPED) === liveScore(i.inp)).length };
if (check.same !== check.inputs) throw new Error(`the parametric copy differs from the live model on ${check.inputs - check.same} inputs`);

const rhoOf = (xs: Item[], pred: (i: Item) => number) => fairRho(xs.map((i) => ({ ev: i.ev, pred: pred(i) }))).rho;
const KINDS: Kind[] = ["sunrise", "sunset"];

// --- 1. The sky types, on each cam's own scale ----------------------------------

const pct = new Map<string, number>();
{
  const groups = new Map<string, Item[]>();
  for (const i of items) groups.set(`${i.ev.cam}|${i.ev.kind}`, [...(groups.get(`${i.ev.cam}|${i.ev.kind}`) ?? []), i]);
  for (const g of groups.values()) {
    if (g.length < MIN_CAM_RANK_EVENTS) continue;
    const p = midRankPercentiles(g.map((i) => i.ev.obs));
    g.forEach((i, k) => pct.set(i.ev.key, p[k]));
  }
}
function skyClass(i: Inp): string {
  const mh = screen(i.mid, i.high);
  const total = Math.max(i.total ?? 0, i.low, i.mid, i.high);
  if (total >= 90) return "solid deck (total ≥ 90%)";
  if (total < 15) return "clear (total < 15%)";
  if (mh >= 20 && mh <= 70 && total <= 60) return "sweet spot (20–70% mid/high, total ≤ 60%)";
  if (mh >= 20) return "heavy mid/high (total 60–90%, or mid/high > 70%)";
  if (mh < 20 && i.low >= 15) return "low cloud, little above";
  return "thin mid/high (under 20%)";
}
const ranked = items.filter((i) => pct.has(i.ev.key));
const classOrder = ["clear (total < 15%)", "thin mid/high (under 20%)", "low cloud, little above", "sweet spot (20–70% mid/high, total ≤ 60%)", "heavy mid/high (total 60–90%, or mid/high > 70%)", "solid deck (total ≥ 90%)"];
function classTable(xs: Item[]) {
  return classOrder.map((c) => {
    const g = xs.filter((i) => skyClass(i.inp) === c);
    const b = dayBootstrap(g, (i) => i.ev.date, (s) => mean(s.map((i) => pct.get(i.ev.key) as number)), 1000);
    return { sky: c, events: g.length, days: new Set(g.map((i) => i.ev.date)).size, meanCamPercentile: r2(b.value), lo: r2(b.lo), hi: r2(b.hi), meanModelScore: r2(mean(g.map((i) => paramScore(i.inp, SHIPPED)))) };
  });
}
function classDiff(xs: Item[], a: string, b: string) {
  const d = dayBootstrap(xs, (i) => i.ev.date, (s) => {
    const A = s.filter((i) => skyClass(i.inp) === a);
    const B = s.filter((i) => skyClass(i.inp) === b);
    if (A.length < 3 || B.length < 3) return null;
    return (mean(A.map((i) => pct.get(i.ev.key) as number)) as number) - (mean(B.map((i) => pct.get(i.ev.key) as number)) as number);
  });
  return { diff: r2(d.value), lo: r2(d.lo), hi: r2(d.hi), pPositive: r2(d.pPositive) };
}
const skyTypes = {
  note: "mean of each event's percentile on its own cam (0 = that cam's dullest, 1 = its best); 0.5 is average",
  all: classTable(ranked),
  sunrise: classTable(ranked.filter((i) => i.ev.kind === "sunrise")),
  sunset: classTable(ranked.filter((i) => i.ev.kind === "sunset")),
  sweetSpotMinusClear: { all: classDiff(ranked, classOrder[3], classOrder[0]), sunrise: classDiff(ranked.filter((i) => i.ev.kind === "sunrise"), classOrder[3], classOrder[0]), sunset: classDiff(ranked.filter((i) => i.ev.kind === "sunset"), classOrder[3], classOrder[0]) },
  anyPartialMidHighMinusClear: (() => {
    const lab = (i: Item) => { const c = skyClass(i.inp); return c === classOrder[3] || c === classOrder[4] ? "p" : c === classOrder[0] ? "c" : "x"; };
    const d = dayBootstrap(ranked, (i) => i.ev.date, (s) => {
      const A = s.filter((i) => lab(i) === "p");
      const B = s.filter((i) => lab(i) === "c");
      return A.length < 3 || B.length < 3 ? null : (mean(A.map((i) => pct.get(i.ev.key) as number)) as number) - (mean(B.map((i) => pct.get(i.ev.key) as number)) as number);
    });
    return { diff: r2(d.value), lo: r2(d.lo), hi: r2(d.hi), pPositive: r2(d.pPositive) };
  })(),
  // Low cloud toward the sun, on its own.
  pathLow: (() => {
    const has = ranked.filter((i) => i.inp.beamLow != null);
    const bins: [string, (v: number) => boolean][] = [["under 20%", (v) => v < 20], ["20–50%", (v) => v >= 20 && v < 50], ["50–90%", (v) => v >= 50 && v < 90], ["90% and over", (v) => v >= 90]];
    return {
      bins: bins.map(([name, f]) => {
        const g = has.filter((i) => f(i.inp.beamLow as number));
        return { pathLowCloud: name, events: g.length, days: new Set(g.map((i) => i.ev.date)).size, meanCamPercentile: r2(mean(g.map((i) => pct.get(i.ev.key) as number))) };
      }),
      // Among skies with little mid/high cloud, so the deck does not confound it.
      binsLittleMidHigh: bins.map(([name, f]) => {
        const g = has.filter((i) => f(i.inp.beamLow as number) && screen(i.inp.mid, i.inp.high) < 20);
        return { pathLowCloud: name, events: g.length, meanCamPercentile: r2(mean(g.map((i) => pct.get(i.ev.key) as number))) };
      }),
    };
  })(),
};

// --- 2. The grid ----------------------------------------------------------------

const GRID = {
  c0: [50, 56, 62, 68, 74, 80, 86, 92, 98, 104],
  tail: [40, 60, 86],
  ovcStart: [40, 50, 60, 70, 80],
  ovcFloor: [0.25, 0.35, 0.45, 0.6, 0.8, 1],
  pathFloor: [0.25, 0.5, 0.75, 1],
};
type Family = { name: string; free: number; grid: Params[] };
const cross = (over: Partial<Record<keyof typeof GRID, number[]>>): Params[] => {
  let out: Params[] = [{ ...SHIPPED }];
  for (const [k, vals] of Object.entries(over)) out = out.flatMap((p) => (vals as number[]).map((v) => ({ ...p, [k]: v })));
  return out;
};
const families: Family[] = [
  { name: "clear-sky value only (is there a sweet spot?)", free: 1, grid: cross({ c0: GRID.c0 }) },
  { name: "path cost only (low cloud toward the sun)", free: 1, grid: cross({ pathFloor: GRID.pathFloor }) },
  { name: "overcast fade only (start, floor)", free: 2, grid: cross({ ovcStart: GRID.ovcStart, ovcFloor: GRID.ovcFloor }) },
  { name: "all five numbers", free: 5, grid: cross(GRID) },
];

/** The grid point with the best fair grade on `xs`. Ties go to the first point (grid order), never to the shipped one. */
function fit(xs: Item[], grid: Params[], table: Map<Params, Map<string, number>>): Params {
  let best = grid[0];
  let bestRho = -Infinity;
  for (const p of grid) {
    const t = table.get(p) as Map<string, number>;
    const rho = rhoOf(xs, (i) => t.get(i.ev.key) as number);
    if (rho != null && rho > bestRho + 1e-12) {
      bestRho = rho;
      best = p;
    }
  }
  return best;
}
const tableOf = (grid: Params[]) => new Map(grid.map((p) => [p, new Map(items.map((i) => [i.ev.key, paramScore(i.inp, p)]))] as const));
const shippedPred = (i: Item) => paramScore(i.inp, SHIPPED);

const half = Math.ceil(days.length / 2);
const trainDays = new Set(days.slice(0, half));
const train = items.filter((i) => trainDays.has(i.ev.date));
const test = items.filter((i) => !trainDays.has(i.ev.date));
const afterShip = items.filter((i) => i.ev.date > "2026-11-05");

function pairedVsShipped(xs: Item[], pred: (i: Item) => number) {
  const d = dayBootstrap(xs, (i) => i.ev.date, (s) => {
    const a = rhoOf(s, pred);
    const b = rhoOf(s, shippedPred);
    return a == null || b == null ? null : a - b;
  }, 1000);
  return { diff: r2(d.value), lo: r2(d.lo), hi: r2(d.hi), pPositive: r2(d.pPositive) };
}
function interval(xs: Item[], pred: (i: Item) => number) {
  const b = dayBootstrap(xs, (i) => i.ev.date, (s) => rhoOf(s, pred), 1000);
  const f = fairRho(xs.map((i) => ({ ev: i.ev, pred: pred(i) })));
  return { rho: r2(b.value), lo: r2(b.lo), hi: r2(b.hi), events: f.events, cams: f.cams, days: new Set(xs.map((i) => i.ev.date)).size };
}

function evaluateFamily(f: Family, pool: Item[] = items) {
  const table = tableOf(f.grid);
  const at = (p: Params) => (i: Item) => (table.get(p) as Map<string, number>).get(i.ev.key) as number;
  const poolDays = [...new Set(pool.map((i) => i.ev.date))].sort();
  const tr = pool.filter((i) => trainDays.has(i.ev.date));
  const te = pool.filter((i) => !trainDays.has(i.ev.date));
  const bestAll = fit(pool, f.grid, table);
  const bestTrain = fit(tr, f.grid, table);
  // Leave one day out: each day is scored by the fit on all the other days.
  const lodo = new Map<string, number>();
  const picks = new Map<string, number>();
  for (const d of poolDays) {
    const p = fit(pool.filter((i) => i.ev.date !== d), f.grid, table);
    picks.set(JSON.stringify(p), (picks.get(JSON.stringify(p)) ?? 0) + 1);
    for (const i of pool.filter((x) => x.ev.date === d)) lodo.set(i.ev.key, at(p)(i));
  }
  const lodoPred = (i: Item) => lodo.get(i.ev.key) as number;
  return {
    family: f.name,
    freeNumbers: f.free,
    gridPoints: f.grid.length,
    inSample: { best: bestAll, candidate: interval(pool, at(bestAll)), shipped: interval(pool, shippedPred) },
    timeSplit: {
      fittedOn: `${tr.length} events, ${new Set(tr.map((i) => i.ev.date)).size} days to ${days[half - 1]}`,
      best: bestTrain,
      trainCandidate: r2(rhoOf(tr, at(bestTrain))),
      trainShipped: r2(rhoOf(tr, shippedPred)),
      testCandidate: interval(te, at(bestTrain)),
      testShipped: interval(te, shippedPred),
      testCandidateMinusShipped: pairedVsShipped(te, at(bestTrain)),
    },
    leaveOneDayOut: {
      candidate: interval(pool, lodoPred),
      shipped: interval(pool, shippedPred),
      candidateMinusShipped: pairedVsShipped(pool, lodoPred),
      distinctFits: picks.size,
      mostCommonFit: (() => {
        const [k, n] = [...picks.entries()].sort((a, b) => b[1] - a[1])[0];
        return { params: JSON.parse(k) as Params, days: n };
      })(),
    },
  };
}

const familyResults = families.map((f) => evaluateFamily(f));

// The one candidate named before the search: "no sweet spot" (a clear sky scores the same as
// partial mid/high cloud). It has NO fitted number, so its grade on any set of days is out of sample.
const FLAT: Params = { ...SHIPPED, c0: PEAK };
const flatPred = (i: Item) => paramScore(i.inp, FLAT);
const noSweetSpot = (() => {
  const on = (xs: Item[]) => ({ candidate: interval(xs, flatPred), shipped: interval(xs, shippedPred), candidateMinusShipped: pairedVsShipped(xs, flatPred) });
  const a = fairRho(items.map((i) => ({ ev: i.ev, pred: shippedPred(i) }))).perCam;
  const b = fairRho(items.map((i) => ({ ev: i.ev, pred: flatPred(i) }))).perCam;
  const perCam = a
    .filter((c) => c.rho != null)
    .map((c) => ({ cam: c.cam, kind: c.kind, pairs: c.pairs, shipped: c.rho, noSweetSpot: b.find((x) => x.cam === c.cam && x.kind === c.kind)?.rho ?? null }));
  return {
    params: FLAT,
    all: on(items),
    sunrise: on(items.filter((i) => i.ev.kind === "sunrise")),
    sunset: on(items.filter((i) => i.ev.kind === "sunset")),
    firstHalf: on(train),
    secondHalf: on(test),
    perCam,
    camsBetter: perCam.filter((c) => (c.noSweetSpot as number) > (c.shipped as number)).length,
    camsWorse: perCam.filter((c) => (c.noSweetSpot as number) < (c.shipped as number)).length,
    // How many events does the change re-order? Only skies with mid/high cloud below 20% and the clear ones move against the rest.
    eventsWithMidHighUnder20: items.filter((i) => screen(i.inp.mid, i.inp.high) < 20).length,
    eventsInSweetSpotBand: items.filter((i) => { const m = screen(i.inp.mid, i.inp.high); return m >= 20 && m <= 70; }).length,
    // What the app would say with a flat canvas at the shipped clear-sky value (62): the bands.
    bandsIfFlatAt62: (() => {
      const counts: Record<string, number> = {};
      for (const i of items) {
        const s = Math.round((paramScore(i.inp, FLAT) * SHIPPED.c0) / PEAK);
        const b = s >= 90 ? "Amazing" : s >= 70 ? "Great" : s >= 45 ? "Good" : s >= 20 ? "Fair" : "Poor";
        counts[b] = (counts[b] ?? 0) + 1;
      }
      return counts;
    })(),
    bandsShipped: (() => {
      const counts: Record<string, number> = {};
      for (const i of items) {
        const s = shippedPred(i);
        const b = s >= 90 ? "Amazing" : s >= 70 ? "Great" : s >= 45 ? "Good" : s >= 20 ? "Fair" : "Poor";
        counts[b] = (counts[b] ?? 0) + 1;
      }
      return counts;
    })(),
  };
})();

// One number at a time, in sample: the shape of the grade around the shipped value.
const profiles = Object.fromEntries(
  (Object.keys(GRID) as (keyof typeof GRID)[]).map((k) => [
    k,
    GRID[k].map((v) => {
      const p = { ...SHIPPED, [k]: v };
      const pred = (i: Item) => paramScore(i.inp, p);
      return { value: v, shipped: SHIPPED[k] === v, all: r2(rhoOf(items, pred)), sunrise: r2(rhoOf(items.filter((i) => i.ev.kind === "sunrise"), pred)), sunset: r2(rhoOf(items.filter((i) => i.ev.kind === "sunset"), pred)), firstHalf: r2(rhoOf(train, pred)), secondHalf: r2(rhoOf(test, pred)) };
    }),
  ]),
);

// Should sunrise and sunset differ? Fit each kind alone and grade it out of sample against the pooled fit.
// (Every sunrise cam is on the Atlantic and every sunset cam on the Gulf or the Keys, so kind and coast cannot be told apart.)
const full = families[3];
const byKind = Object.fromEntries(
  KINDS.map((k) => {
    const pool = items.filter((i) => i.ev.kind === k);
    const own = evaluateFamily(full, pool);
    // Pooled fit, graded on this kind only, leave one day out.
    const table = tableOf(full.grid);
    const lodo = new Map<string, number>();
    for (const d of days) {
      const p = fit(items.filter((i) => i.ev.date !== d), full.grid, table);
      for (const i of pool.filter((x) => x.ev.date === d)) lodo.set(i.ev.key, (table.get(p) as Map<string, number>).get(i.ev.key) as number);
    }
    const pooledPred = (i: Item) => lodo.get(i.ev.key) as number;
    return [k, { ownFit: own, pooledFitLeaveOneDayOut: interval(pool, pooledPred) }];
  }),
);

// --- 3. The shipped model, where it has never been tuned -------------------------

const shipped = {
  all: interval(items, shippedPred),
  sunrise: interval(items.filter((i) => i.ev.kind === "sunrise"), shippedPred),
  sunset: interval(items.filter((i) => i.ev.kind === "sunset"), shippedPred),
  firstHalf: interval(train, shippedPred),
  secondHalf: interval(test, shippedPred),
  // The shipped numbers were set on data to 2026-11-05. Days after that are its only clean test.
  afterItShipped: { ...interval(afterShip, shippedPred), pairs: afterShip.length, note: "per-cam minimum is 8 pairs; with 6 days no cam reaches it" },
  afterItShippedPooledRanks: (() => {
    // Too few days for the per-cam grade: rank each event on its cam's whole history instead, then one Spearman.
    const xs = afterShip.filter((i) => pct.has(i.ev.key));
    const b = dayBootstrap(xs, (i) => i.ev.date, (s) => {
      const a = s.map((i) => shippedPred(i));
      const o = s.map((i) => pct.get(i.ev.key) as number);
      return spearmanLocal(a, o);
    }, 1000);
    return { rho: r2(b.value), lo: r2(b.lo), hi: r2(b.hi), events: xs.length, days: new Set(xs.map((i) => i.ev.date)).size };
  })(),
};
function spearmanLocal(a: number[], b: number[]): number | null {
  if (a.length < 5) return null;
  const rk = (xs: number[]) => midRankPercentiles(xs);
  const x = rk(a);
  const y = rk(b);
  const mx = mean(x) as number;
  const my = mean(y) as number;
  const sxy = x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0);
  const sxx = x.reduce((s, v) => s + (v - mx) ** 2, 0);
  const syy = y.reduce((s, v) => s + (v - my) ** 2, 0);
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

// How did the shipped model's Great and Amazing calls (70 and over) rank on the cams?
const greatCalls = (() => {
  const calls = ranked.filter((i) => shippedPred(i) >= 70);
  const b = dayBootstrap(calls, (i) => i.ev.date, (s) => mean(s.map((i) => pct.get(i.ev.key) as number)), 1000);
  const top = calls.filter((i) => (pct.get(i.ev.key) as number) >= 0.75).length;
  return {
    calls: calls.length,
    days: new Set(calls.map((i) => i.ev.date)).size,
    sunrise: calls.filter((i) => i.ev.kind === "sunrise").length,
    sunset: calls.filter((i) => i.ev.kind === "sunset").length,
    meanCamPercentile: r2(b.value),
    lo: r2(b.lo),
    hi: r2(b.hi),
    inCamsTopQuarter: top,
    topQuarterShare: r2(calls.length ? top / calls.length : null),
    chance: 0.25,
  };
})();

// --- 4. The forecast-only total-cloud floor ---------------------------------------

const runs = loadRuns();
const runItems = (tag: "late" | "early"): Item[] =>
  dedupe(allEvents, (ev) => runs.has(`${ev.slug}|${ev.kind}|${ev.eventIso}|${tag}`)).map((ev) => ({
    ev,
    inp: { ...(runs.get(`${ev.slug}|${ev.kind}|${ev.eventIso}|${tag}`) as { inp: Inp }).inp, ...(air.get(ev.key) ?? {}) },
  }));
const storedFc: Item[] = (() => {
  const out: Item[] = [];
  for (const r of stored) {
    if (r.source === "satellite-ir") continue;
    const ev = find(r.slug, r.event_kind, r.event_iso);
    const inp = inpOfRow(r);
    if (ev && inp) out.push({ ev, inp });
  }
  return out;
})();
function floorStudy(xs: Item[], gradeable: boolean) {
  const belowMax = xs.filter((i) => i.inp.total != null && i.inp.total < Math.max(i.inp.low, i.inp.mid, i.inp.high) - 0.5);
  const belowBlend = xs.filter((i) => i.inp.total != null && i.inp.total < screen(screen(i.inp.low, i.inp.mid), i.inp.high) - 0.5);
  const moved = (mode: Params["floor"]) => xs.filter((i) => paramScore(i.inp, { ...SHIPPED, floor: mode }) !== paramScore(i.inp, SHIPPED)).length;
  return {
    inputs: xs.length,
    totalBelowLargestLayer: belowMax.length,
    totalBelowScreenBlend: belowBlend.length,
    scoresChangedIfNoFloor: moved("none"),
    scoresChangedIfScreenBlend: moved("blend"),
    meanChangeIfScreenBlend: r2(mean(xs.map((i) => paramScore(i.inp, { ...SHIPPED, floor: "blend" }) - paramScore(i.inp, SHIPPED)).filter((d) => d !== 0))),
    ...(gradeable
      ? {
          grade: (["max", "none", "blend"] as const).map((mode) => ({ floor: mode, shipped: mode === "max", ...interval(xs, (i) => paramScore(i.inp, { ...SHIPPED, floor: mode })) })),
          blendMinusShipped: pairedVsShipped(xs, (i) => paramScore(i.inp, { ...SHIPPED, floor: "blend" })),
        }
      : {}),
  };
}
const totalFloor = {
  rebuiltForecastLateRun: floorStudy(runItems("late"), true),
  rebuiltForecastEarlyRun: floorStudy(runItems("early"), true),
  everyStoredForecastRow: floorStudy(storedFc, false),
};

// --- Output -------------------------------------------------------------------------

const out = {
  model: SUN_QUALITY_VERSION,
  input: "satellite read from the scan 20 min before the event",
  events: items.length,
  days: days.length,
  cams: new Set(items.map((i) => i.ev.cam)).size,
  split: { firstHalf: `${days[0]} to ${days[half - 1]}`, secondHalf: `${days[half]} to ${days[days.length - 1]}` },
  parametricCopyMatchesLiveModel: check,
  shippedParams: SHIPPED,
  shipped,
  skyTypes,
  families: familyResults,
  noSweetSpot,
  greatCalls,
  profiles,
  byKind,
  totalFloor,
};
const evalPath = join(BENCH, "eval.json");
const prev = existsSync(evalPath) ? (JSON.parse(readFileSync(evalPath, "utf8")) as Record<string, unknown>) : {};
writeFileSync(evalPath, JSON.stringify({ ...prev, tune: out }, null, 1) + "\n");

console.log(JSON.stringify({ events: out.events, days: out.days, cams: out.cams, split: out.split, check, shipped }, null, 1));
console.log(JSON.stringify(skyTypes, null, 1));
for (const f of familyResults) {
  console.log(`\n== ${f.family} (${f.gridPoints} points)`);
  console.log(" in-sample best", JSON.stringify(f.inSample.best), "cand", JSON.stringify(f.inSample.candidate), "shipped", f.inSample.shipped.rho);
  console.log(" time split: best", JSON.stringify(f.timeSplit.best), "train c/s", f.timeSplit.trainCandidate, f.timeSplit.trainShipped, "TEST cand", JSON.stringify(f.timeSplit.testCandidate), "shipped", JSON.stringify(f.timeSplit.testShipped), "diff", JSON.stringify(f.timeSplit.testCandidateMinusShipped));
  console.log(" LODO cand", JSON.stringify(f.leaveOneDayOut.candidate), "diff", JSON.stringify(f.leaveOneDayOut.candidateMinusShipped), "fits", f.leaveOneDayOut.distinctFits, JSON.stringify(f.leaveOneDayOut.mostCommonFit));
}
console.log(JSON.stringify(noSweetSpot, null, 1));
console.log(JSON.stringify(profiles, null, 0));
for (const k of KINDS) {
  const b = byKind[k];
  console.log(`\n== ${k}: own fit`, JSON.stringify(b.ownFit.inSample.best), "in-sample", b.ownFit.inSample.candidate.rho, "shipped", b.ownFit.inSample.shipped.rho, "LODO own", JSON.stringify(b.ownFit.leaveOneDayOut.candidate), "LODO pooled", JSON.stringify(b.pooledFitLeaveOneDayOut), "own-shipped", JSON.stringify(b.ownFit.leaveOneDayOut.candidateMinusShipped));
}
console.log(JSON.stringify(totalFloor, null, 1));
