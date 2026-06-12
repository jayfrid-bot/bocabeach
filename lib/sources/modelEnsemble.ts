import type { Location, MetnoCurrent, Wrapped } from "@/lib/types";
import { fetchWithTimeout, fetchedAtOf, nowIso, round } from "@/lib/util";

const ATTRIBUTION = "Open-Meteo — NOAA GFS model (open-meteo.com)";

/**
 * An explicit-GFS voice for the consensus. Open-Meteo's default "best match"
 * blends models; pinning GFS gives genuine model diversity alongside MET
 * Norway (ECMWF-based) and the NWS station observation, so the medians in
 * deriveMetrics rest on three model families plus a real instrument.
 */
interface OmCurrent {
  current?: {
    temperature_2m?: number | null;
    relative_humidity_2m?: number | null;
    dew_point_2m?: number | null;
    wind_speed_10m?: number | null;
    wind_direction_10m?: number | null;
    cloud_cover?: number | null;
  };
}

/** Parse the GFS `current` block (already imperial via request params). Pure. */
export function parseGfsCurrent(json: OmCurrent): MetnoCurrent | null {
  const c = json?.current;
  if (!c) return null;
  const out: MetnoCurrent = {};
  const num = (v: number | null | undefined) =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  if (num(c.temperature_2m) != null) out.airTempF = round(c.temperature_2m as number);
  if (num(c.wind_speed_10m) != null) out.windSpeedMph = round(c.wind_speed_10m as number);
  if (num(c.wind_direction_10m) != null) out.windDirDeg = round(c.wind_direction_10m as number);
  if (num(c.relative_humidity_2m) != null) out.humidityPct = round(c.relative_humidity_2m as number);
  if (num(c.dew_point_2m) != null) out.dewPointF = round(c.dew_point_2m as number);
  if (num(c.cloud_cover) != null) out.cloudCoverPct = round(c.cloud_cover as number);
  return Object.keys(out).length ? out : null;
}

export async function fetchGfs(loc: Location): Promise<Wrapped<MetnoCurrent>> {
  let fetchedAt = nowIso();
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
    `&current=temperature_2m,relative_humidity_2m,dew_point_2m,wind_speed_10m,` +
    `wind_direction_10m,cloud_cover` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&models=gfs_seamless`;
  try {
    const res = await fetchWithTimeout(url, {
      timeoutMs: 7000,
      next: { revalidate: 1800 }, // 30m
    });
    fetchedAt = fetchedAtOf(res);
    if (!res.ok) throw new Error(`Open-Meteo GFS -> ${res.status}`);
    const data = parseGfsCurrent(await res.json());
    return {
      source: "NOAA GFS (via Open-Meteo)",
      status: data ? "ok" : "error",
      fetchedAt,
      attribution: ATTRIBUTION,
      data,
      note: data ? undefined : "no GFS current conditions returned",
    };
  } catch (e) {
    return {
      source: "NOAA GFS (via Open-Meteo)",
      status: "error",
      fetchedAt,
      attribution: ATTRIBUTION,
      data: null,
      note: String(e),
    };
  }
}
