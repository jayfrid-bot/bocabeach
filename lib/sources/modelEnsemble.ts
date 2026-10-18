import type { Location, MetnoCurrent, Wrapped } from "@/lib/types";
import { fetchNowPoint, staleNote, type PointResult, type SplitNow } from "@/lib/sources/openMeteo";
import { nowIso, round } from "@/lib/util";

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

/**
 * GFS "current" for a beach, from the shared call B (lib/sources/openMeteo.ts:
 * `models=best_match,gfs_seamless`; GFS current = the gfs_seamless 15-minute
 * slot at current.time, the same numbers the old `models=gfs_seamless&current=`
 * call returned). A failed call falls back to the last good copy (up to 3 h,
 * "stale"), read for the 15-minute slot of now.
 */
export async function fetchGfs(
  loc: Location,
  point?: Promise<PointResult<SplitNow>>,
): Promise<Wrapped<MetnoCurrent>> {
  const p = await (point ?? fetchNowPoint(loc));
  if (!p.ok) {
    return {
      source: "NOAA GFS (via Open-Meteo)",
      status: "error",
      fetchedAt: nowIso(),
      attribution: ATTRIBUTION,
      data: null,
      note: p.error,
    };
  }
  const data = p.split.gfs ? parseGfsCurrent(p.split.gfs as OmCurrent) : null;
  return {
    source: "NOAA GFS (via Open-Meteo)",
    status: !data ? "error" : p.stale ? "stale" : "ok",
    fetchedAt: p.fetchedAt,
    attribution: ATTRIBUTION,
    data,
    note: !data ? "no GFS current conditions returned" : p.stale ? staleNote(p.stale) : undefined,
  };
}
