import type { HourlyMetrics, Location, Wrapped } from "@/lib/types";
import { wmoEmoji } from "@/lib/sources/forecast";
import { wmoText } from "@/lib/sources/spotWeather";
import {
  fetchForecastPoint,
  fetchOpenMeteoJson,
  MAX_AGE_MS,
  openMeteoUrl,
  staleNote,
  type PointResult,
  type SplitForecast,
} from "@/lib/sources/openMeteo";
import { nowIso, round } from "@/lib/util";

const ATTRIBUTION = "Open-Meteo (open-meteo.com)";

interface OpenMeteoHourly {
  hourly?: {
    time?: string[];
    temperature_2m?: (number | null)[];
    cloud_cover?: (number | null)[];
    cloud_cover_low?: (number | null)[];
    cloud_cover_mid?: (number | null)[];
    cloud_cover_high?: (number | null)[];
    precipitation_probability?: (number | null)[];
    weather_code?: (number | null)[];
    wind_speed_10m?: (number | null)[];
    wind_direction_10m?: (number | null)[];
    uv_index?: (number | null)[];
    uv_index_clear_sky?: (number | null)[];
    relative_humidity_2m?: (number | null)[];
    dew_point_2m?: (number | null)[];
    soil_temperature_0cm?: (number | null)[];
    shortwave_radiation?: (number | null)[];
    precipitation?: (number | null)[];
  };
}

/**
 * Parse an Open-Meteo `hourly` payload (imperial units, requested WITHOUT a
 * timezone so `time` values are GMT wall-clock) into HourlyMetrics[]. Each row's
 * `time` is normalized to an absolute UTC ISO string. Returns null when there is
 * no usable hourly data.
 */
export function parseOpenMeteoHourly(
  json: OpenMeteoHourly,
): HourlyMetrics[] | null {
  const h = json.hourly;
  const time = h?.time;
  if (!h || !Array.isArray(time) || time.length === 0) return null;

  const num = (arr: (number | null)[] | undefined, i: number): number | undefined =>
    typeof arr?.[i] === "number" ? (arr[i] as number) : undefined;

  const out: HourlyMetrics[] = [];
  for (let i = 0; i < time.length; i++) {
    // Open-Meteo returns "YYYY-MM-DDThh:mm" in GMT; pin it to UTC explicitly.
    const t = new Date(`${time[i]}:00Z`);
    if (!Number.isFinite(t.getTime())) continue;
    const code = num(h.weather_code, i);
    const air = num(h.temperature_2m, i);
    const cloud = num(h.cloud_cover, i);
    const cloudLow = num(h.cloud_cover_low, i);
    const cloudMid = num(h.cloud_cover_mid, i);
    const cloudHigh = num(h.cloud_cover_high, i);
    const pop = num(h.precipitation_probability, i);
    const wind = num(h.wind_speed_10m, i);
    const wdir = num(h.wind_direction_10m, i);
    const uv = num(h.uv_index, i);
    const uvClear = num(h.uv_index_clear_sky, i);
    const rh = num(h.relative_humidity_2m, i);
    const dew = num(h.dew_point_2m, i);
    const soil = num(h.soil_temperature_0cm, i);
    const solar = num(h.shortwave_radiation, i);
    const precip = num(h.precipitation, i);
    out.push({
      time: t.toISOString(),
      airTempF: air !== undefined ? round(air) : undefined,
      cloudCoverPct: cloud !== undefined ? round(cloud) : undefined,
      cloudCoverLowPct: cloudLow !== undefined ? round(cloudLow) : undefined,
      cloudCoverMidPct: cloudMid !== undefined ? round(cloudMid) : undefined,
      cloudCoverHighPct: cloudHigh !== undefined ? round(cloudHigh) : undefined,
      precipProbability: pop !== undefined ? round(pop) : undefined,
      weatherCode: code,
      windSpeedMph: wind !== undefined ? round(wind) : undefined,
      windDirDeg: wdir !== undefined ? round(wdir) : undefined,
      uvIndex: uv !== undefined ? round(uv, 1) : undefined,
      uvClearSkyIndex: uvClear !== undefined ? round(uvClear, 1) : undefined,
      humidityPct: rh !== undefined ? round(rh) : undefined,
      dewPointF: dew !== undefined ? round(dew) : undefined,
      soilTempF: soil !== undefined ? round(soil) : undefined,
      solarWm2: solar !== undefined ? round(solar) : undefined,
      precipIn: precip !== undefined ? round(precip, 2) : undefined,
      shortForecast: wmoText(code),
      emoji: wmoEmoji(code),
    });
  }
  return out.length ? out : null;
}

/**
 * Overlay GOES satellite-OBSERVED radiation onto elapsed hours. The weather
 * model sometimes hallucinates clouds (or misses them): on 2026-06-11 it said
 * 437 W/m² for a 1 PM hour the satellite saw at 918 — a ~24°F sand-temp error.
 * Only hours that have fully elapsed are overridden; the satellite endpoint's
 * future rows are clear-sky estimates, not observations, so the forecast model
 * keeps future hours. Mutates and returns `hours`. Pure given its inputs.
 */
export function overlaySatelliteRadiation(
  hours: HourlyMetrics[],
  sat: { time?: string[]; shortwave_radiation?: (number | null)[] },
  nowMs: number,
): HourlyMetrics[] {
  const times = sat?.time;
  const values = sat?.shortwave_radiation;
  if (!Array.isArray(times) || !Array.isArray(values)) return hours;
  const byIso = new Map<string, number>();
  for (let i = 0; i < times.length; i++) {
    const v = values[i];
    if (typeof v === "number" && Number.isFinite(v)) {
      byIso.set(new Date(`${times[i]}:00Z`).toISOString(), v);
    }
  }
  for (const h of hours) {
    const elapsed = new Date(h.time).getTime() + 3600_000 <= nowMs;
    const observed = byIso.get(h.time);
    if (elapsed && observed != null) {
      h.solarWm2 = round(observed);
      // Marks the hour as evidence, not a guess. The sand model uses this to
      // discard forecast rain in a bright observed hour and to carry an observed
      // radiation into the current (forecast) hour — see lib/sandTemp.ts.
      h.solarObserved = true;
    }
  }
  return hours;
}

/**
 * Hourly forecast for a beach. The hourly numbers come from the shared call A
 * (lib/sources/openMeteo.ts: hourly + daily in one request; lib/conditions.ts
 * passes the same promise to fetchForecast). GOES satellite-observed radiation
 * is a separate best-effort call that overlays elapsed hours.
 *
 * Window (set in openMeteo.ts, unchanged from the old call): 2 GMT days back
 * (the man-o'-war advisory needs >=24 h of trailing wind) and 7 GMT days on,
 * which MUST match the daily FORECAST_DAYS so every outlook tile has hours to
 * score (2026-07-17 bug). Times are GMT, pinned to UTC by the parser.
 *
 * When Open-Meteo fails (a 429, say), the last good copy (up to 3 h old) is
 * served with status "stale", so UV and sand temperature keep working.
 */
export async function fetchHourlyForecast(
  loc: Location,
  point?: Promise<PointResult<SplitForecast>>,
): Promise<Wrapped<HourlyMetrics[]>> {
  // GOES satellite-observed radiation for elapsed hours (best effort; the
  // forecast model's values stand wherever this is missing or fails).
  const satUrl = openMeteoUrl(
    "satellite-api",
    `/v1/archive?latitude=${loc.lat}&longitude=${loc.lon}` +
      `&hourly=shortwave_radiation&past_days=1&forecast_days=1`,
  );
  const [p, sat] = await Promise.all([
    point ?? fetchForecastPoint(loc),
    fetchOpenMeteoJson<{ hourly?: { time?: string[]; shortwave_radiation?: (number | null)[] } }>(satUrl, {
      storeKey: `satellite:${loc.lat},${loc.lon}`,
      maxAgeMs: MAX_AGE_MS.satellite,
      timeoutMs: 7000,
      revalidate: 1800, // 30m
    }),
  ]);
  if (!p.ok) {
    return {
      source: "Open-Meteo (hourly)",
      status: "error",
      fetchedAt: nowIso(),
      attribution: ATTRIBUTION,
      data: null,
      note: p.error,
    };
  }
  const data = parseOpenMeteoHourly(p.split.hourly as OpenMeteoHourly);
  let satOk = false;
  if (data && sat.ok && sat.json.hourly) {
    overlaySatelliteRadiation(data, sat.json.hourly, Date.now());
    satOk = true;
  }
  return {
    source: satOk ? "Open-Meteo (hourly + GOES radiation)" : "Open-Meteo (hourly)",
    status: !data ? "error" : p.stale ? "stale" : "ok",
    fetchedAt: p.fetchedAt,
    attribution: ATTRIBUTION,
    data,
    note: !data ? "no hourly forecast returned" : p.stale ? staleNote(p.stale) : undefined,
  };
}
