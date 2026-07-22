import type { Location, MarineData, Wrapped } from "@/lib/types";
import { cToF, fetchWithTimeout, fetchedAtOf, mToFt, nowIso, oldestIso, round } from "@/lib/util";

const ATTRIBUTION = "Open-Meteo (open-meteo.com) — marine & weather models";

type Current = Record<string, number | string | undefined>;
type NumArr = (number | null)[];
interface MarineHourly {
  time?: string[];
  wave_height?: NumArr;
  wave_period?: NumArr;
  swell_wave_height?: NumArr;
  swell_wave_period?: NumArr;
}

async function getMarine(
  url: string,
  revalidate: number,
): Promise<{ current: Current | null; hourly: MarineHourly | null; at: string }> {
  const res = await fetchWithTimeout(url, { next: { revalidate } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const json = (await res.json()) as { current?: Current; hourly?: MarineHourly };
  return { current: json.current ?? null, hourly: json.hourly ?? null, at: fetchedAtOf(res) };
}

async function getCurrent(
  url: string,
  revalidate: number,
): Promise<{ current: Current | null; at: string }> {
  const res = await fetchWithTimeout(url, { next: { revalidate } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const json = (await res.json()) as { current?: Current };
  return { current: json.current ?? null, at: fetchedAtOf(res) };
}

/**
 * Reduce Open-Meteo marine `hourly` arrays into the compact wave samples the
 * hourly rip-current curve (lib/ripRiskCurve.ts) anchors on: height (ft) +
 * period (s) per hour, dominant `wave_period` preferred, falling back to
 * `swell_wave_period`. Times come back in GMT (no `timezone=` on the URL), so
 * each is pinned to an absolute UTC ISO string — matching lib/sources/
 * hourlyForecast.ts's convention so they line up with the wind/tide hours.
 */
export function parseMarineHourly(
  h: MarineHourly | null,
): { time: string; waveHeightFt?: number; wavePeriodS?: number }[] | undefined {
  const time = h?.time;
  if (!h || !Array.isArray(time) || time.length === 0) return undefined;
  const num = (arr: NumArr | undefined, i: number): number | undefined =>
    typeof arr?.[i] === "number" ? (arr[i] as number) : undefined;
  const out: { time: string; waveHeightFt?: number; wavePeriodS?: number }[] = [];
  for (let i = 0; i < time.length; i++) {
    const t = new Date(`${time[i]}:00Z`);
    if (!Number.isFinite(t.getTime())) continue;
    const waveM = num(h.wave_height, i);
    const periodS = num(h.wave_period, i) ?? num(h.swell_wave_period, i);
    out.push({
      time: t.toISOString(),
      waveHeightFt: waveM !== undefined ? round(mToFt(waveM), 1) : undefined,
      wavePeriodS: periodS !== undefined ? round(periodS, 1) : undefined,
    });
  }
  return out.length ? out : undefined;
}

export async function fetchMarine(loc: Location): Promise<Wrapped<MarineData>> {
  let fetchedAt = nowIso();
  const marineUrl =
    `https://marine-api.open-meteo.com/v1/marine?latitude=${loc.lat}&longitude=${loc.lon}` +
    `&current=wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_period,` +
    `swell_wave_direction,sea_surface_temperature` +
    // Hourly waves feed the hourly rip-current risk curve (lib/ripRiskCurve.ts).
    `&hourly=wave_height,wave_period,swell_wave_height,swell_wave_period&forecast_days=2`;
  const uvUrl =
    `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
    `&current=uv_index,cloud_cover`;

  try {
    const [marineRes, uvRes] = await Promise.allSettled([
      getMarine(marineUrl, 3600),
      getCurrent(uvUrl, 3600),
    ]);

    fetchedAt = oldestIso(
      marineRes.status === "fulfilled" ? marineRes.value.at : undefined,
      uvRes.status === "fulfilled" ? uvRes.value.at : undefined,
    );

    const data: MarineData = {};
    if (marineRes.status === "fulfilled" && marineRes.value.current) {
      const m = marineRes.value.current;
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
    if (marineRes.status === "fulfilled" && marineRes.value.hourly) {
      const hourlyWaves = parseMarineHourly(marineRes.value.hourly);
      if (hourlyWaves) data.hourlyWaves = hourlyWaves;
    }
    if (uvRes.status === "fulfilled" && uvRes.value.current) {
      const uv = uvRes.value.current["uv_index"];
      if (typeof uv === "number") data.uvIndex = round(uv, 1);
      const cloud = uvRes.value.current["cloud_cover"];
      if (typeof cloud === "number") data.cloudCoverPct = round(cloud);
    }

    const hasAny = Object.keys(data).length > 0;
    return {
      source: "Open-Meteo Marine",
      status: hasAny ? "ok" : "error",
      fetchedAt,
      attribution: ATTRIBUTION,
      data: hasAny ? data : null,
    };
  } catch (e) {
    return {
      source: "Open-Meteo Marine",
      status: "error",
      fetchedAt,
      attribution: ATTRIBUTION,
      data: null,
      note: String(e),
    };
  }
}
