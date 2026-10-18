import type { Location, MarineData, Wrapped } from "@/lib/types";
import {
  fetchNowPoint,
  fetchOpenMeteoJson,
  MAX_AGE_MS,
  openMeteoUrl,
  staleNote,
  type OpenMeteoStale,
  type PointResult,
  type SplitNow,
} from "@/lib/sources/openMeteo";
import { cToF, mToFt, oldestIso, round } from "@/lib/util";

const ATTRIBUTION = "Open-Meteo (open-meteo.com) — marine & weather models";

type Current = Record<string, number | string | undefined>;
type NumArr = (number | null)[];
interface MarineHourly {
  time?: string[];
  wave_height?: NumArr;
  wave_period?: NumArr;
  wave_direction?: NumArr;
  swell_wave_height?: NumArr;
  swell_wave_period?: NumArr;
  swell_wave_direction?: NumArr;
}

/**
 * Reduce Open-Meteo marine `hourly` arrays into the compact wave samples the
 * hourly rip-current curve (lib/ripRiskCurve.ts) anchors on: height (ft) +
 * period (s) + approach direction per hour, plus the swell-only height/period
 * reported separately. `wave_period`/`wave_direction` are this hour's own
 * TOTAL fields; `waveDirDeg` alone falls back to `swell_wave_direction` when
 * the total direction is missing (direction isn't part of the breaker-height
 * physics, so that fallback is harmless) — but `wavePeriodS` is NEVER filled
 * from `swell_wave_period` here (Codex review 2026-09-28 #2): a period read
 * off the swell-only field does not describe the TOTAL height it would end up
 * paired with. The swell height/period are carried through as their own
 * fields instead, so a consumer that needs to fall back to the swell
 * component (lib/surfHeight.ts's `estimateSurfFromSources`) can pair them
 * with EACH OTHER, never with the total height. Times come back in GMT (no
 * `timezone=` on the URL), so each is pinned to an absolute UTC ISO string —
 * matching lib/sources/hourlyForecast.ts's convention so they line up with
 * the wind/tide hours.
 */
export function parseMarineHourly(
  h: MarineHourly | null,
): NonNullable<MarineData["hourlyWaves"]> | undefined {
  const time = h?.time;
  if (!h || !Array.isArray(time) || time.length === 0) return undefined;
  const num = (arr: NumArr | undefined, i: number): number | undefined =>
    typeof arr?.[i] === "number" ? (arr[i] as number) : undefined;
  const out: NonNullable<MarineData["hourlyWaves"]> = [];
  for (let i = 0; i < time.length; i++) {
    const t = new Date(`${time[i]}:00Z`);
    if (!Number.isFinite(t.getTime())) continue;
    const waveM = num(h.wave_height, i);
    const periodS = num(h.wave_period, i); // TOTAL period only — no swell fallback.
    const swellM = num(h.swell_wave_height, i);
    const swellPeriodS = num(h.swell_wave_period, i);
    const dirDeg = num(h.wave_direction, i) ?? num(h.swell_wave_direction, i);
    out.push({
      time: t.toISOString(),
      waveHeightFt: waveM !== undefined ? round(mToFt(waveM), 1) : undefined,
      wavePeriodS: periodS !== undefined ? round(periodS, 1) : undefined,
      swellHeightFt: swellM !== undefined ? round(mToFt(swellM), 1) : undefined,
      swellPeriodS: swellPeriodS !== undefined ? round(swellPeriodS, 1) : undefined,
      waveDirDeg: dirDeg !== undefined ? round(dirDeg) : undefined,
    });
  }
  return out.length ? out : undefined;
}

/**
 * Waves, swell and sea temperature from Open-Meteo Marine, plus the current UV
 * and cloud cover from the shared call B (lib/sources/openMeteo.ts; the same
 * best-match numbers the old separate `current=uv_index,cloud_cover` call
 * returned). Either part falls back to its last good copy (up to 3 h); the
 * source is then "stale" and fetchedAt is the oldest part's time.
 */
export async function fetchMarine(
  loc: Location,
  point?: Promise<PointResult<SplitNow>>,
): Promise<Wrapped<MarineData>> {
  const marineUrl = openMeteoUrl(
    "marine-api",
    `/v1/marine?latitude=${loc.lat}&longitude=${loc.lon}` +
      `&current=wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_period,` +
      `swell_wave_direction,sea_surface_temperature` +
      // Hourly waves feed the hourly rip-current risk curve (lib/ripRiskCurve.ts).
      // `wave_direction` (+ its swell fallback) drives that curve's shore-incidence
      // multiplier — square-on swell makes rips, oblique swell makes longshore drift.
      `&hourly=wave_height,wave_period,wave_direction,swell_wave_height,swell_wave_period,` +
      `swell_wave_direction&forecast_days=7`,
  );

  const [marineRes, uvRes] = await Promise.all([
    fetchOpenMeteoJson<{ current?: Current; hourly?: MarineHourly }>(marineUrl, {
      storeKey: `marine:${loc.lat},${loc.lon}`,
      maxAgeMs: MAX_AGE_MS.marine,
      revalidate: 3600,
    }),
    point ?? fetchNowPoint(loc),
  ]);
  // The UV part has its own 3 h limit (the shared copy may be kept for other uses).
  const uvOk = uvRes.ok && (uvRes.stale == null || uvRes.stale.ageMs <= MAX_AGE_MS.marine);

  const fetchedAt = oldestIso(
    marineRes.ok ? marineRes.fetchedAt : undefined,
    uvOk && uvRes.ok ? uvRes.fetchedAt : undefined,
  );

  const data: MarineData = {};
  const marineCurrent = marineRes.ok ? (marineRes.json.current ?? null) : null;
  if (marineCurrent) {
    const m = marineCurrent;
    const n = (k: string): number | undefined =>
      typeof m[k] === "number" ? (m[k] as number) : undefined;
    const waveM = n("wave_height");
    const swellM = n("swell_wave_height");
    const sstC = n("sea_surface_temperature");
    if (waveM !== undefined) data.waveHeightFt = round(mToFt(waveM), 1);
    if (n("wave_direction") !== undefined) data.waveDirDeg = n("wave_direction");
    if (n("wave_period") !== undefined) data.wavePeriodS = round(n("wave_period") as number, 1);
    if (swellM !== undefined) data.swellHeightFt = round(mToFt(swellM), 1);
    if (n("swell_wave_period") !== undefined)
      data.swellPeriodS = round(n("swell_wave_period") as number, 1);
    if (n("swell_wave_direction") !== undefined)
      data.swellDirDeg = n("swell_wave_direction");
    if (sstC !== undefined) data.seaSurfaceTempF = round(cToF(sstC));
  }
  if (marineRes.ok && marineRes.json.hourly) {
    const hourlyWaves = parseMarineHourly(marineRes.json.hourly);
    if (hourlyWaves) data.hourlyWaves = hourlyWaves;
  }
  if (uvOk && uvRes.ok && uvRes.split.current) {
    const uv = uvRes.split.current.uv_index;
    if (typeof uv === "number") data.uvIndex = round(uv, 1);
    const cloud = uvRes.split.current.cloud_cover;
    if (typeof cloud === "number") data.cloudCoverPct = round(cloud);
  }

  const hasAny = Object.keys(data).length > 0;
  const stale = [marineRes.ok ? marineRes.stale : undefined, uvOk && uvRes.ok ? uvRes.stale : undefined]
    .filter((x): x is OpenMeteoStale => x != null)
    .sort((x, y) => y.ageMs - x.ageMs)[0];
  const errors = [marineRes.ok ? null : marineRes.error, uvRes.ok ? null : uvRes.error].filter(Boolean);
  return {
    source: "Open-Meteo Marine",
    status: !hasAny ? "error" : stale ? "stale" : "ok",
    fetchedAt,
    attribution: ATTRIBUTION,
    data: hasAny ? data : null,
    note: !hasAny ? errors.join("; ") || undefined : stale ? staleNote(stale) : undefined,
  };
}
