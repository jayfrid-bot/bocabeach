import type { SpotWeatherData, Wrapped } from "@/lib/types";
import { degToCardinal, fetchWithTimeout, nowIso, round } from "@/lib/util";

const ATTRIBUTION = "Open-Meteo (open-meteo.com)";

/** Map a WMO weather code to a short human-readable label. */
export function wmoText(code: number | undefined): string | undefined {
  if (code == null) return undefined;
  if (code === 0) return "Clear";
  if (code === 1) return "Mainly clear";
  if (code === 2) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if (code === 45 || code === 48) return "Fog";
  if (code >= 51 && code <= 57) return "Drizzle";
  if (code >= 61 && code <= 65) return "Rain";
  if (code === 66 || code === 67) return "Freezing rain";
  if (code >= 71 && code <= 77) return "Snow";
  if (code >= 80 && code <= 82) return "Rain showers";
  if (code === 85 || code === 86) return "Snow showers";
  if (code === 95) return "Thunderstorm";
  if (code === 96 || code === 99) return "Thunderstorm w/ hail";
  return undefined;
}

interface OpenMeteoCurrent {
  current?: Record<string, number | string | undefined>;
}

/**
 * Parse an Open-Meteo `current` payload (requested with imperial units) into
 * per-spot weather. Returns null when no usable fields are present.
 */
export function parseOpenMeteoCurrent(
  json: OpenMeteoCurrent,
): SpotWeatherData | null {
  const c = json.current;
  if (!c) return null;

  const num = (k: string): number | undefined =>
    typeof c[k] === "number" ? (c[k] as number) : undefined;

  const out: SpotWeatherData = {};
  const temp = num("temperature_2m");
  const feels = num("apparent_temperature");
  const windDir = num("wind_direction_10m");
  const windSpeed = num("wind_speed_10m");
  const gust = num("wind_gusts_10m");
  const humidity = num("relative_humidity_2m");
  const code = num("weather_code");

  if (temp !== undefined) out.airTempF = round(temp);
  if (feels !== undefined) out.apparentTempF = round(feels);
  if (windSpeed !== undefined) out.windSpeedMph = round(windSpeed);
  if (gust !== undefined) out.windGustMph = round(gust);
  if (windDir !== undefined) {
    out.windDirDeg = round(windDir);
    out.windDirCardinal = degToCardinal(windDir);
  }
  if (humidity !== undefined) out.humidity = round(humidity);
  if (code !== undefined) {
    out.weatherCode = code;
    out.shortForecast = wmoText(code);
  }

  const time = c["time"];
  if (typeof time === "string") {
    // Requested without a timezone, so `time` is GMT "YYYY-MM-DDThh:mm".
    const d = new Date(`${time}:00Z`);
    if (Number.isFinite(d.getTime())) out.observedAt = d.toISOString();
  }

  return Object.keys(out).length > 0 ? out : null;
}

export async function fetchSpotWeather(
  lat: number,
  lon: number,
): Promise<Wrapped<SpotWeatherData>> {
  const fetchedAt = nowIso();
  // Round to ~1km so nearby cams share a cached request.
  const la = round(lat, 2);
  const lo = round(lon, 2);
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${lo}` +
    `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,` +
    `wind_speed_10m,wind_direction_10m,wind_gusts_10m` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph`;
  try {
    const res = await fetchWithTimeout(url, {
      timeoutMs: 6000,
      next: { revalidate: 900 }, // 15 min
    });
    if (!res.ok) throw new Error(`Open-Meteo current -> ${res.status}`);
    const data = parseOpenMeteoCurrent(await res.json());
    return {
      source: "Open-Meteo (current)",
      status: data ? "ok" : "error",
      fetchedAt,
      attribution: ATTRIBUTION,
      data,
      note: data ? undefined : "no current weather returned",
    };
  } catch (e) {
    return {
      source: "Open-Meteo (current)",
      status: "error",
      fetchedAt,
      attribution: ATTRIBUTION,
      data: null,
      note: String(e),
    };
  }
}
