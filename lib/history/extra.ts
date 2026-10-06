// Builds `beach_hourly.extra_json` — the app's other proprietary computed
// readouts (surf estimate, sand model, rip resolve, storm meter, feels-like,
// water trend, vs-average, safety levels, best window, sky events), archived
// next to the beach score so predictions can later be checked against reality
// and recalibrated. Recording only: every number here is read off the same
// functions/fields the UI uses; nothing is rescored.
//
// Every block is built in its own try/catch — a model that throws logs and is
// skipped, the others (and the beach_hourly row) still land. Pure: no I/O, no
// clock reads (`nowMs` is passed in).

import type { ConditionsResponse } from "@/lib/types";
import {
  consensusCloudPct,
  currentHourOf,
  satelliteBeamCloudPct,
  satelliteCloudPct,
  type Derived,
} from "@/lib/score";
import { currentSandInput, estimateSandRangeF, estimateSandTempF } from "@/lib/sandTemp";
import { computeStormActivity } from "@/lib/stormActivity";
import { feelsLikeBeach } from "@/lib/feelsLikeBeach";
import { surfConditions, swimSafety } from "@/lib/safetyLine";
import type { BeachHourlyExtra } from "@/lib/history/types";

/** Schema version of the whole extra_json document. */
export const EXTRA_SCHEMA_VERSION = 1 as const;

/**
 * Per-model algorithm versions. Only the sun-color model and the beach score
 * export a version constant of their own (SUN_QUALITY_VERSION,
 * SCORING_ENGINE_VERSION); the models below have none, so each carries a
 * dated tag here. BUMP THE TAG BY HAND whenever that module's formula or
 * constants change, so archived rows stay attributable to the right version.
 */
export const MODEL_VERSIONS = {
  surf: "2026-09-28.1", // lib/surfHeight.ts (Komar-Gaughan, MAX_AMPLIFICATION 2.5)
  sand: "2026-09-08.1", // lib/sandTemp.ts (carry-forward darkening calibration)
  rip: "2026-09-24.1", // lib/ripRisk/resolve.ts (temporal resolve)
  storm: "2026-09-04.1", // lib/stormActivity.ts (radar-preferred rain term)
  feels: "2026-10-06.1", // lib/feelsLikeBeach.ts (first-guess calibration)
  water: "2026-10-06.1", // lib/waterTrend.ts
  vsAvg: "2026-10-06.1", // lib/vsAverage.ts
  safety: "2026-10-06.1", // lib/safetyLine.ts
  window: "2026-10-06.1", // lib/score.ts bestBeachWindow
  sky: "2026-10-06.1", // lib/skyEvents.ts + lib/skyVisibilityQuality.ts
} as const;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const round1 = (v: number | null): number | null => (v == null ? null : Math.round(v * 10) / 10);

/** Run one block; log and return undefined on failure so the caller skips it. */
function guard<T>(name: string, slug: string, fn: () => T | undefined): T | undefined {
  try {
    return fn();
  } catch (e) {
    console.error("history: extra block failed", name, slug, e);
    return undefined;
  }
}

/**
 * Build the extra_json document for one archive row. `d` is the same
 * `deriveMetrics` result the row's scalar columns came from, `anchorMs` the
 * snapshot's own clock. Always returns an object (possibly with no blocks).
 */
export function buildExtra(res: ConditionsResponse, d: Derived, anchorMs: number): BeachHourlyExtra {
  const snap = res.snapshot;
  const slug = snap.location?.slug ?? "?";
  const hours = snap.hourly?.data ?? [];
  const out: BeachHourlyExtra = { v: EXTRA_SCHEMA_VERSION };

  const surf = guard("surf", slug, () => {
    if (d.waveHeightFt == null && d.waveTotalHsFt == null) return undefined;
    return {
      av: MODEL_VERSIONS.surf,
      hs: round1(num(d.waveTotalHsFt)),
      rawFt: round1(num(d.waveSwellHeightFt)),
      periodS: round1(num(d.wavePeriodS)),
      surfFt: round1(num(d.waveHeightFt)),
      src: d.waveHeightSource?.kind ?? null,
    };
  });
  if (surf) out.surf = surf;

  const sand = guard("sand", slug, () => {
    if (!hours.length) return undefined;
    const beam = satelliteBeamCloudPct(snap);
    const input = currentSandInput(
      hours,
      anchorMs,
      {
        cloudCoverPct: beam ?? satelliteCloudPct(snap) ?? d.cloudCoverPct,
        cloudIsBeamPath: beam != null,
        radarDryNow: d.radarDryNow,
      },
      snap.location.lon,
    );
    if (!input) return undefined;
    const range = estimateSandRangeF(input);
    return {
      av: MODEL_VERSIONS.sand,
      tempF: num(estimateSandTempF(input)),
      surfF: num(range?.surfF),
      soilF: num(input.soilTempF),
      solarWm2: num(input.solarWm2),
      windMph: round1(num(input.windSpeedMph)),
      rainIn: num(input.recentRainIn) == null ? null : Math.round((input.recentRainIn as number) * 100) / 100,
      cloudPct: round1(num(input.cloudCoverPct)),
      beamCloud: input.cloudIsBeamPath ? (1 as const) : (0 as const),
      carried: input.solarCarried ? (1 as const) : (0 as const),
      hfn: round1(num(input.hoursFromSolarNoon)),
    };
  });
  if (sand) out.sand = sand;

  const rip = guard("rip", slug, () => {
    const n = d.ripNow;
    if (!n) return undefined;
    return {
      av: MODEL_VERSIONS.rip,
      level: n.level,
      source: n.source,
      modelPct: num(n.model?.prob),
      srf: n.period?.level ?? null,
      watch: n.watch ? (1 as const) : (0 as const),
      alert: n.alert ? (1 as const) : (0 as const),
    };
  });
  if (rip) out.rip = rip;

  const currentHour = currentHourOf(hours, anchorMs);

  const storm = guard("storm", slug, () => {
    const s = computeStormActivity({
      lightning: snap.lightning,
      precipIn: currentHour?.precipIn,
      weatherCode: currentHour?.weatherCode,
      precipProbability: currentHour?.precipProbability,
      precipRadar: snap.precipRadar,
    });
    if (!s) return undefined;
    return {
      av: MODEL_VERSIONS.storm,
      score: s.score,
      band: s.band,
      strikes: num(s.parts.strikes),
      proximity: num(s.parts.proximity),
      rain: num(s.parts.rain),
      radar: s.rainFromRadar ? (1 as const) : (0 as const),
    };
  });
  if (storm) out.storm = storm;

  const feels = guard("feels", slug, () => {
    const r = feelsLikeBeach({
      airTempF: d.airTempF,
      humidityPct: d.humidityPct,
      windSpeedMph: d.windSpeedMph,
      cloudCoverPct: consensusCloudPct(snap),
      sandTempF: d.sandTempF,
      isDaytime: snap.weather?.data?.isDaytime,
      solarWm2: currentHour?.solarWm2,
    });
    return r ? { av: MODEL_VERSIONS.feels, tempF: r.tempF, band: r.band } : undefined;
  });
  if (feels) out.feels = feels;

  const water = guard("water", slug, () => {
    const w = snap.waterTrend;
    if (!w) return undefined;
    return { av: MODEL_VERSIONS.water, status: w.status, d48: w.deltaF48h, d7d: num(w.deltaF7d) };
  });
  if (water) out.water = water;

  const vsAvg = guard("vsAvg", slug, () => {
    const c = snap.busyness?.data?.vsAvg;
    const s = snap.sargassum?.data?.vsAvg;
    if (!c && !s) return undefined;
    const v: NonNullable<BeachHourlyExtra["vsAvg"]> = { av: MODEL_VERSIONS.vsAvg };
    if (c) v.crowd = { pct: num(c.deltaPct), pts: num(c.deltaPts), days: c.baselineDays };
    if (s) v.seaweed = { pct: num(s.deltaPct), pts: num(s.deltaPts), days: s.baselineDays };
    return v;
  });
  if (vsAvg) out.vsAvg = vsAvg;

  const safety = guard("safety", slug, () => ({
    av: MODEL_VERSIONS.safety,
    swim: swimSafety(d, snap).level,
    surf: surfConditions(d, snap).level,
  }));
  if (safety) out.safety = safety;

  const win = guard("window", slug, () => {
    const best = res.multiDayWindows?.[0]?.best;
    if (!best) return undefined;
    return { av: MODEL_VERSIONS.window, startIso: best.startIso, endIso: best.endIso, score: best.score };
  });
  if (win) out.window = win;

  const sky = guard("sky", slug, () => {
    const rows = snap.skyEvents?.rows ?? [];
    const events = rows.flatMap((r) =>
      r.events.map((e) => {
        const at =
          e.eventType === "moon"
            ? e.fullMoonInstant
            : e.eventType === "eclipse" || e.eventType === "meteor"
              ? e.peak
              : e.eventType === "launch"
                ? e.net
                : e.episode.start;
        const rating = e.rating as ({ label: string; score?: number } | null);
        return { t: e.eventType, at, r: rating?.label ?? null, s: num(rating?.score) };
      }),
    );
    return events.length ? { av: MODEL_VERSIONS.sky, events } : undefined;
  });
  if (sky) out.sky = sky;

  return out;
}

/** extra_json text, or null when nothing (not even a block) could be built. */
export function extraJsonFor(res: ConditionsResponse, d: Derived, anchorMs: number): string | null {
  try {
    return JSON.stringify(buildExtra(res, d, anchorMs));
  } catch (e) {
    console.error("history: extra_json failed", e);
    return null;
  }
}
