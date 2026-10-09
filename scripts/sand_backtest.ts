// Sand-temperature bench: re-score every IR reading in
// docs/benchmarks/sand-ir/readings.csv with the sand model and report the
// error, overall and by month. Then try candidate changes to the model's
// transfer function and report the same numbers for each.
//
//   npx vite-node -c vitest.config.ts scripts/sand_backtest.ts
//
// Inputs are reconstructed from Open-Meteo's archives for Boca Raton
// (docs/benchmarks/sand-ir/hourly-forecast.json and satellite.json):
// modeled soil temperature and wind from the historical forecast, and the
// SATELLITE-OBSERVED hourly sunshine for radiation. Observed radiation already
// embodies the sky it came through, so no cloud damping is applied on top of
// it (lib/sandTemp.ts, the 2026-09-04 lesson). This isolates the transfer
// function from the live input pipeline (carry rules, GOES freshness).

import { readFileSync } from "node:fs";
import { hoursFromSolarNoon, afternoonBoostFactor } from "@/lib/sandTemp";

const DIR = "docs/benchmarks/sand-ir";
const LON = -80.0686;
const read = (f: string) => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8")).hourly;
const fc = read("hourly-forecast.json");
const sat = read("satellite.json");
const idx = new Map<string, number>(fc.time.map((t: string, i: number) => [t, i]));

interface Reading {
  date: string;
  local: string;
  spot: "dunes" | "surf" | "mid";
  measured: number;
  utcMs: number;
  notes: string;
}

function parseReadings(): Reading[] {
  const lines = readFileSync(`${DIR}/readings.csv`, "utf8").trim().split("\n").slice(1);
  const out: Reading[] = [];
  for (const line of lines) {
    const c = line.split(",");
    const spotRaw = c[3].toLowerCase();
    let spot: Reading["spot"] | null = null;
    if (/dune|dry sand/.test(spotRaw) && !/mid/.test(spotRaw)) spot = "dunes";
    else if (/surf/.test(spotRaw)) spot = "surf";
    else if (/mid/.test(spotRaw)) spot = "mid";
    if (!spot) continue; // "first reading (spot not noted)" is superseded
    const [hh, mm] = c[1].split(":").map(Number);
    // Every reading is Eastern Daylight Time (UTC−4).
    const utcMs = Date.parse(`${c[0]}T${String(hh + 4).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`);
    out.push({ date: c[0], local: c[1], spot, measured: Number(c[6]), utcMs, notes: c[15] ?? "" });
  }
  return out;
}

interface Inputs {
  soilF: number;
  windMph: number;
  solarObs: number;
  solarForecast: number;
  cloudPct: number;
  rainIn: number;
  /** Satellite-observed sunshine accumulated since the start of the day, Wh/m². */
  accumWh: number;
  hfn: number;
}

function inputsAt(ms: number): Inputs {
  const hourStart = new Date(Math.floor(ms / 3_600_000) * 3_600_000).toISOString().slice(0, 13) + ":00";
  const i = idx.get(hourStart);
  if (i == null) throw new Error(`no hour ${hourStart}`);
  // Hour means for the hour containing the reading, as the live model uses.
  const soilF = fc.soil_temperature_0cm[i];
  const windMph = fc.wind_speed_10m[i];
  const solarObs = sat.shortwave_radiation[i];
  const solarForecast = fc.shortwave_radiation[i];
  const cloudPct = fc.cloud_cover[i];
  const rainIn = (fc.precipitation[i] ?? 0) + (fc.precipitation[i - 1] ?? 0) + (fc.precipitation[i - 2] ?? 0);
  let accumWh = 0;
  for (let j = i - 14; j <= i; j++) {
    const start = Date.parse(fc.time[j] + ":00Z");
    const frac = Math.min(1, Math.max(0, (ms - start) / 3_600_000));
    accumWh += (sat.shortwave_radiation[j] ?? 0) * frac;
  }
  return { soilF, windMph, solarObs, solarForecast, cloudPct, rainIn, accumWh, hfn: hoursFromSolarNoon(LON, new Date(ms)) };
}

/** The live model's transfer function (lib/sandTemp.ts sandBoostF), with the
 *  knobs the candidates turn exposed. Defaults reproduce the live model. */
interface Knobs {
  maxBoost: number; // MAX_SUN_BOOST_F
  sunPower: number; // exponent on sunFrac (0.5 = sqrt)
  windDiv: number; // boost *= max(windFloor, 1 - wind/windDiv)
  windFloor: number; // floor of the wind factor (live model: 0.6)
  soilSlope: number; // boost *= max(0.4, 1 - (soil-90)/soilSlope)
  /** Accumulated-sunshine factor: boost *= min(1, accumWh/accumRef)^accumPower. 0 = off. */
  accumRef: number;
  accumPower: number;
}
const LIVE: Knobs = { maxBoost: 55, sunPower: 0.5, windDiv: 60, windFloor: 0.6, soilSlope: 55, accumRef: 0, accumPower: 1 };

function boostF(inp: Inputs, k: Knobs, solar: number): number {
  const sunFrac = Math.min(1, Math.max(0, solar / 1000));
  let boost = Math.pow(sunFrac, k.sunPower) * k.maxBoost;
  boost *= Math.max(k.windFloor, 1 - Math.max(0, inp.windMph) / k.windDiv);
  boost *= Math.max(0.4, Math.min(1, 1 - (inp.soilF - 90) / k.soilSlope));
  boost *= afternoonBoostFactor(inp.hfn);
  if (k.accumRef > 0) boost *= Math.pow(Math.min(1, inp.accumWh / k.accumRef), k.accumPower);
  if (inp.rainIn >= 0.05) boost *= 0.3;
  return boost;
}

function eveningCool(hfn: number): number {
  if (hfn <= 3.8) return 0;
  return 2.2 * Math.min(1, (hfn - 3.8) / (6.5 - 3.8));
}

function predict(inp: Inputs, k: Knobs, spot: Reading["spot"], solar: number): number {
  const b = boostF(inp, k, solar);
  const cool = eveningCool(inp.hfn);
  const dunes = inp.soilF + b - cool;
  const surf = inp.soilF + b * 0.65 - cool;
  return spot === "dunes" ? dunes : spot === "surf" ? surf : (dunes + surf) / 2;
}

const readings = parseReadings();
const rows = readings.map((r) => ({ r, inp: inputsAt(r.utcMs) }));

function evaluate(k: Knobs, useObserved = true) {
  const errs = rows.map(({ r, inp }) => predict(inp, k, r.spot, useObserved ? inp.solarObs : inp.solarForecast) - r.measured);
  const mae = errs.reduce((a, e) => a + Math.abs(e), 0) / errs.length;
  const bias = errs.reduce((a, e) => a + e, 0) / errs.length;
  const byMonth = new Map<string, number[]>();
  rows.forEach(({ r }, i) => {
    const m = r.date.slice(0, 7);
    byMonth.set(m, [...(byMonth.get(m) ?? []), errs[i]]);
  });
  const monthBias = [...byMonth.entries()]
    .map(([m, es]) => `${m.slice(5)}: ${(es.reduce((a, e) => a + e, 0) / es.length).toFixed(1)}`)
    .join("  ");
  return { errs, mae, bias, monthBias };
}

const f1 = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(1);

console.log("## Every reading, live model, satellite-observed sunshine\n");
console.log("| date | time | spot | measured | soil | sun W/m² | accum Wh | wind | h from noon | model | error |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|");
const live = evaluate(LIVE);
rows.forEach(({ r, inp }, i) => {
  console.log(
    `| ${r.date} | ${r.local} | ${r.spot} | ${r.measured} | ${inp.soilF.toFixed(0)} | ${inp.solarObs} | ${inp.accumWh.toFixed(0)} | ${inp.windMph.toFixed(0)} | ${f1(inp.hfn)} | ${(r.measured + live.errs[i]).toFixed(0)} | ${f1(live.errs[i])} |`,
  );
});
console.log(`\nLive model: MAE ${live.mae.toFixed(1)}  bias ${f1(live.bias)}  by month → ${live.monthBias}`);
const liveFc = evaluate(LIVE, false);
console.log(`Live model fed FORECAST sunshine instead: MAE ${liveFc.mae.toFixed(1)}  bias ${f1(liveFc.bias)}  by month → ${liveFc.monthBias}\n`);

console.log("## Candidates (all readings, observed sunshine)\n");
console.log("| candidate | MAE | bias | by month |");
console.log("|---|---|---|---|");
const candidates: [string, Knobs][] = [
  ["live", LIVE],
  ["accumulated sunshine, ref 3000 Wh", { ...LIVE, accumRef: 3000 }],
  ["accumulated sunshine, ref 4000 Wh", { ...LIVE, accumRef: 4000 }],
  ["accumulated sunshine, ref 5000 Wh", { ...LIVE, accumRef: 5000 }],
  ["accumulated sunshine, ref 4000 Wh, sqrt", { ...LIVE, accumRef: 4000, accumPower: 0.5 }],
  ["steeper sun response (power 0.75)", { ...LIVE, sunPower: 0.75 }],
  ["linear sun response (power 1)", { ...LIVE, sunPower: 1 }],
  ["weaker wind effect (÷90)", { ...LIVE, windDiv: 90 }],
  ["stronger wind effect (÷40, floor 0.4)", { ...LIVE, windDiv: 40, windFloor: 0.4 }],
  ["stronger wind effect (÷30, floor 0.3)", { ...LIVE, windDiv: 30, windFloor: 0.3 }],
  ["stronger wind effect (÷25, floor 0.2)", { ...LIVE, windDiv: 25, windFloor: 0.2 }],
  ["stronger wind effect (÷20, floor 0.2)", { ...LIVE, windDiv: 20, windFloor: 0.2 }],
  ["max boost 50", { ...LIVE, maxBoost: 50 }],
];
for (const [name, k] of candidates) {
  const e = evaluate(k);
  console.log(`| ${name} | ${e.mae.toFixed(1)} | ${f1(e.bias)} | ${e.monthBias} |`);
}

// Small grid search, reported for transparency — with ~15 readings this is a
// hint about which knob matters, not a fit to adopt blindly.
let best: { k: Knobs; mae: number } | null = null;
for (const maxBoost of [45, 50, 55, 60])
  for (const sunPower of [0.5, 0.75, 1])
    for (const windDiv of [20, 25, 30, 40, 60, 90])
      for (const windFloor of [0.2, 0.4, 0.6])
      for (const soilSlope of [40, 55, 80])
        for (const accumRef of [0, 3000, 4000, 5000]) {
          const k = { ...LIVE, maxBoost, sunPower, windDiv, windFloor, soilSlope, accumRef };
          const e = evaluate(k);
          if (!best || e.mae < best.mae) best = { k, mae: e.mae };
        }
if (best) {
  const e = evaluate(best.k);
  console.log(`\nGrid best: ${JSON.stringify(best.k)} → MAE ${e.mae.toFixed(1)} bias ${f1(e.bias)} by month → ${e.monthBias}`);
}
