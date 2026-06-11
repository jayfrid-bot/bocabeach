import type { HourlyMetrics, Location, Wrapped } from "@/lib/types";
import { wmoEmoji } from "@/lib/sources/forecast";
import { wmoText } from "@/lib/sources/spotWeather";
import { fetchWithTimeout, nowIso, round } from "@/lib/util";

const ATTRIBUTION = "Open-Meteo (open-meteo.com)";

interface OpenMeteoHourly {
  hourly?: {
    time?: string[];
    temperature_2m?: (number | null)[];
    cloud_cover?: (number | null)[];
    precipitation_probability?: (number | null)[];
    weather_code?: (number | null)[];
    wind_speed_10m?: (number | null)[];
    wind_direction_10m?: (number | null)[];
    uv_index?: (number | null)[];
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
    const pop = num(h.precipitation_probability, i);
    const wind = num(h.wind_speed_10m, i);
    const wdir = num(h.wind_direction_10m, i);
    const uv = num(h.uv_index, i);
    const rh = num(h.relative_humidity_2m, i);
    const dew = num(h.dew_point_2m, i);
    const soil = num(h.soil_temperature_0cm, i);
    const solar = num(h.shortwave_radiation, i);
    const precip = num(h.precipitation, i);
    out.push({
      time: t.toISOString(),
      airTempF: air !== undefined ? round(air) : undefined,
      cloudCoverPct: cloud !== undefined ? round(cloud) : undefined,
      precipProbability: pop !== undefined ? round(pop) : undefined,
      weatherCode: code,
      windSpeedMph: wind !== undefined ? round(wind) : undefined,
      windDirDeg: wdir !== undefined ? round(wdir) : undefined,
      uvIndex: uv !== undefined ? round(uv, 1) : undefined,
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

export async function fetchHourlyForecast(
  loc: Location,
): Promise<Wrapped<HourlyMetrics[]>> {
  const fetchedAt = nowIso();
  // No `timezone=auto`: times come back in GMT, which we pin to UTC in the parser
  // so they line up with the (UTC) sun times and `fmtTime`.
  // `past_days=1` + `forecast_days=2` so the data window always spans the beach's
  // LOCAL day: in the evening (US is behind UTC) the local morning/afternoon hours
  // fall in the *previous* GMT day, which a forecast-only window would omit.
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
    `&hourly=temperature_2m,cloud_cover,precipitation_probability,weather_code,` +
    `wind_speed_10m,wind_direction_10m,uv_index,relative_humidity_2m,dew_point_2m,` +
    `soil_temperature_0cm,shortwave_radiation,precipitation` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch` +
    `&past_days=1&forecast_days=2`;
  try {
    const res = await fetchWithTimeout(url, {
      timeoutMs: 7000,
      next: { revalidate: 3600 }, // 1h
    });
    if (!res.ok) throw new Error(`Open-Meteo hourly -> ${res.status}`);
    const data = parseOpenMeteoHourly(await res.json());
    return {
      source: "Open-Meteo (hourly)",
      status: data ? "ok" : "error",
      fetchedAt,
      attribution: ATTRIBUTION,
      data,
      note: data ? undefined : "no hourly forecast returned",
    };
  } catch (e) {
    return {
      source: "Open-Meteo (hourly)",
      status: "error",
      fetchedAt,
      attribution: ATTRIBUTION,
      data: null,
      note: String(e),
    };
  }
}
