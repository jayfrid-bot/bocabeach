import type { Location, MetnoCurrent, Wrapped } from "@/lib/types";
import { cToF, fetchWithTimeout, fetchedAtOf, msToMph, nowIso, round } from "@/lib/util";

const ATTRIBUTION = "MET Norway (api.met.no, CC BY 4.0)";

/**
 * Norwegian Meteorological Institute Locationforecast — a fully independent
 * organization AND model family (ECMWF-based) from Open-Meteo and NWS. It is
 * the second/third voice in the consensus for shared metrics, so one model's
 * bad day (or one provider's outage) can't single-handedly skew the dashboard.
 * Free, no key; they require a descriptive User-Agent.
 */
interface MetnoResponse {
  properties?: {
    timeseries?: Array<{
      time?: string;
      data?: {
        instant?: {
          details?: {
            air_temperature?: number; // °C
            wind_speed?: number; // m/s
            wind_from_direction?: number;
            relative_humidity?: number;
            dew_point_temperature?: number; // °C
            cloud_area_fraction?: number; // %
          };
        };
      };
    }>;
  };
}

/** Parse the first (current-hour) timeseries entry into imperial units. Pure. */
export function parseMetno(json: MetnoResponse): MetnoCurrent | null {
  const d = json?.properties?.timeseries?.[0]?.data?.instant?.details;
  if (!d) return null;
  const out: MetnoCurrent = {};
  if (typeof d.air_temperature === "number") out.airTempF = round(cToF(d.air_temperature));
  if (typeof d.wind_speed === "number") out.windSpeedMph = round(msToMph(d.wind_speed));
  if (typeof d.wind_from_direction === "number") out.windDirDeg = round(d.wind_from_direction);
  if (typeof d.relative_humidity === "number") out.humidityPct = round(d.relative_humidity);
  if (typeof d.dew_point_temperature === "number")
    out.dewPointF = round(cToF(d.dew_point_temperature));
  if (typeof d.cloud_area_fraction === "number") out.cloudCoverPct = round(d.cloud_area_fraction);
  return Object.keys(out).length ? out : null;
}

export async function fetchMetno(loc: Location): Promise<Wrapped<MetnoCurrent>> {
  let fetchedAt = nowIso();
  const url =
    `https://api.met.no/weatherapi/locationforecast/2.0/compact` +
    `?lat=${loc.lat.toFixed(4)}&lon=${loc.lon.toFixed(4)}`;
  try {
    const res = await fetchWithTimeout(url, {
      timeoutMs: 7000,
      headers: {
        "User-Agent":
          process.env.CONDITIONS_USER_AGENT ?? "isitbeachday.com (hello@isitbeachday.com)",
      },
      next: { revalidate: 1800 }, // 30m — model updates a few times a day
    });
    fetchedAt = fetchedAtOf(res);
    if (!res.ok) throw new Error(`met.no -> ${res.status}`);
    const data = parseMetno(await res.json());
    return {
      source: "MET Norway",
      status: data ? "ok" : "error",
      fetchedAt,
      attribution: ATTRIBUTION,
      data,
      note: data ? undefined : "no current conditions returned",
    };
  } catch (e) {
    return {
      source: "MET Norway",
      status: "error",
      fetchedAt,
      attribution: ATTRIBUTION,
      data: null,
      note: String(e),
    };
  }
}
