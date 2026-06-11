import type { ForecastDay, Location, Wrapped } from "@/lib/types";
import { wmoText } from "@/lib/sources/spotWeather";
import { fetchedAtOf, fetchWithTimeout, nowIso, round } from "@/lib/util";

const ATTRIBUTION = "Open-Meteo (open-meteo.com)";

/** Map a WMO weather code to a representative emoji. */
export function wmoEmoji(code: number | undefined): string {
  if (code == null) return "•";
  if (code === 0) return "☀️";
  if (code === 1 || code === 2) return "🌤️";
  if (code === 3) return "☁️";
  if (code === 45 || code === 48) return "🌫️";
  if (code >= 51 && code <= 57) return "🌦️";
  if (code >= 61 && code <= 65) return "🌧️";
  if (code === 66 || code === 67) return "🌧️";
  if (code >= 71 && code <= 77) return "🌨️";
  if (code >= 80 && code <= 82) return "🌧️";
  if (code === 85 || code === 86) return "🌨️";
  if (code === 95) return "⛈️";
  if (code === 96 || code === 99) return "⛈️";
  return "•";
}

/** Short 3-letter weekday for a YYYY-MM-DD date (parsed at noon UTC, TZ-safe). */
function dow(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
}

interface OpenMeteoDaily {
  daily?: {
    time?: string[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_probability_max?: (number | null)[];
    weathercode?: number[];
    weather_code?: number[];
    wind_speed_10m_max?: number[];
  };
}

/**
 * Parse an Open-Meteo `daily` payload (imperial units) into ForecastDay[].
 * Returns null when there is no usable daily data.
 */
export function parseOpenMeteoDaily(json: OpenMeteoDaily): ForecastDay[] | null {
  const d = json.daily;
  const time = d?.time;
  if (!d || !Array.isArray(time) || time.length === 0) return null;

  const codes = d.weathercode ?? d.weather_code ?? [];
  const out: ForecastDay[] = [];
  for (let i = 0; i < time.length; i++) {
    const date = time[i];
    const hi = d.temperature_2m_max?.[i];
    const lo = d.temperature_2m_min?.[i];
    const rain = d.precipitation_probability_max?.[i];
    const wind = d.wind_speed_10m_max?.[i];
    const code = codes[i];
    out.push({
      date,
      dow: dow(date),
      hi: typeof hi === "number" ? Math.round(hi) : undefined,
      lo: typeof lo === "number" ? Math.round(lo) : undefined,
      rain: typeof rain === "number" ? Math.round(rain) : undefined,
      windMaxMph: typeof wind === "number" ? round(wind) : undefined,
      weatherCode: typeof code === "number" ? code : undefined,
      emoji: wmoEmoji(typeof code === "number" ? code : undefined),
      sky: wmoText(typeof code === "number" ? code : undefined),
    });
  }
  return out.length ? out : null;
}

export async function fetchForecast(
  loc: Location,
): Promise<Wrapped<ForecastDay[]>> {
  let fetchedAt = nowIso();
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,` +
    `weathercode,wind_speed_10m_max` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=7`;
  try {
    const res = await fetchWithTimeout(url, {
      timeoutMs: 7000,
      next: { revalidate: 3600 }, // 1h
    });
    fetchedAt = fetchedAtOf(res);
    if (!res.ok) throw new Error(`Open-Meteo daily -> ${res.status}`);
    const data = parseOpenMeteoDaily(await res.json());
    return {
      source: "Open-Meteo (7-day)",
      status: data ? "ok" : "error",
      fetchedAt,
      attribution: ATTRIBUTION,
      data,
      note: data ? undefined : "no daily forecast returned",
    };
  } catch (e) {
    return {
      source: "Open-Meteo (7-day)",
      status: "error",
      fetchedAt,
      attribution: ATTRIBUTION,
      data: null,
      note: String(e),
    };
  }
}
