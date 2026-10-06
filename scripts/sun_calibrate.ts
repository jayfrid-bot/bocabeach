// Score every sunrise and sunset in a saved Open-Meteo history with the sun
// color model, and print the score distribution. Run:
//   npx vite-node scripts/sun_calibrate.ts [dataDir]
// dataDir holds hf.json (historical-forecast hourly cloud + RH, UTC),
// aq.json (air-quality hourly AOD + PM2.5, UTC) and sun.json (daily
// sunrise/sunset, UTC). Default: docs/benchmarks/2026-10-06-sun-model.
//
// Two variants: with the CAMS aerosol reading (Open-Meteo air quality) and
// without one (an AirNow-backed snapshot carries AQI but no AOD). The
// satellite horizon is not scored since version 2026-10-06.2.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sunEventQuality, type SunEventQualityInput } from "../lib/sunQuality";

const dir = process.argv[2] ?? "docs/benchmarks/2026-10-06-sun-model";
const read = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8"));
const hf = read("hf.json").hourly;
const aq = read("aq.json").hourly;
const sun = read("sun.json").daily;

const hourIndex = new Map<string, number>(hf.time.map((t: string, i: number) => [t, i]));
const aqIndex = new Map<string, number>(aq.time.map((t: string, i: number) => [t, i]));

function nearestHour(iso: string): string {
  const ms = Date.parse(iso + "Z");
  const h = Math.round(ms / 3_600_000) * 3_600_000;
  return new Date(h).toISOString().slice(0, 13) + ":00";
}

interface Row {
  date: string;
  kind: "sunrise" | "sunset";
  input: SunEventQualityInput;
  total: number;
}

const rows: Row[] = [];
for (let d = 0; d < sun.time.length; d++) {
  for (const kind of ["sunrise", "sunset"] as const) {
    const at = sun[kind][d] as string | undefined;
    if (!at) continue;
    const key = nearestHour(at);
    const i = hourIndex.get(key);
    if (i == null) continue;
    const low = hf.cloud_cover_low[i];
    const mid = hf.cloud_cover_mid[i];
    const high = hf.cloud_cover_high[i];
    const total = hf.cloud_cover[i];
    if (low == null || mid == null || high == null) continue;
    const j = aqIndex.get(key);
    rows.push({
      date: sun.time[d],
      kind,
      total,
      input: {
        cloud: { lowPct: low, midPct: mid, highPct: high, totalPct: total },
        humidityPct: hf.relative_humidity_2m[i] ?? undefined,
        aod: j != null ? (aq.aerosol_optical_depth[j] ?? undefined) : undefined,
        pm2_5: j != null ? (aq.pm2_5[j] ?? undefined) : undefined,
      },
    });
  }
}

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function report(label: string, score: (r: Row) => number | null) {
  const s = rows.map(score).filter((x): x is number => x != null).sort((a, b) => a - b);
  const share = (min: number) => Math.round((100 * s.filter((x) => x >= min).length) / s.length);
  console.log(
    `${label.padEnd(44)} n=${s.length}  p50=${pct(s, 50)} p80=${pct(s, 80)} p90=${pct(s, 90)} max=${s[s.length - 1]}` +
      `  ≥70 (Great+): ${share(70)}%  ≥90 (Amazing): ${share(90)}%`,
  );
}

report("current model, with aerosol reading", (r) => sunEventQuality(r.input).score);
report("current model, no aerosol reading (AirNow)", (r) =>
  sunEventQuality({ ...r.input, aod: undefined, pm2_5: undefined }).score,
);

const oct6 = rows.find((r) => r.date === "2026-10-06" && r.kind === "sunrise") ??
  rows.find((r) => r.date === "2026-10-05" && r.kind === "sunrise");
if (oct6) {
  console.log(`\n${oct6.date} ${oct6.kind}: ${JSON.stringify(oct6.input)}`);
  console.log("  current, no satellite:", sunEventQuality(oct6.input).score);
}

if (process.env.SHOW_TOP) {
  const scored = rows
    .map((r) => ({ r, s: sunEventQuality(r.input).score ?? -1 }))
    .sort((a, b) => b.s - a.s)
    .slice(0, Number(process.env.SHOW_TOP));
  for (const { r, s } of scored) {
    const c = r.input.cloud!;
    console.log(
      `${r.date} ${r.kind.padEnd(7)} ${String(s).padStart(3)}  low ${c.lowPct} mid ${c.midPct} high ${c.highPct} rh ${r.input.humidityPct} aod ${r.input.aod}`,
    );
  }
}
