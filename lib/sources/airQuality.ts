import type { AirQualityData, Location, Wrapped } from "@/lib/types";
import { fetchWithTimeout, nowIso, round } from "@/lib/util";

const ATTRIBUTION = "Open-Meteo Air Quality (open-meteo.com)";

interface OpenMeteoAir {
  current?: {
    time?: string;
    us_aqi?: number | null;
    pm2_5?: number | null;
    pm10?: number | null;
    ozone?: number | null;
    us_aqi_pm2_5?: number | null;
    us_aqi_pm10?: number | null;
    us_aqi_ozone?: number | null;
  };
}

/** Pick the pollutant whose AQI sub-index is highest — i.e. what's driving the AQI. */
function dominantPollutant(c: NonNullable<OpenMeteoAir["current"]>): string | undefined {
  const subs: Array<[string, number | null | undefined]> = [
    ["PM2.5", c.us_aqi_pm2_5],
    ["PM10", c.us_aqi_pm10],
    ["Ozone", c.us_aqi_ozone],
  ];
  let best: { label: string; v: number } | null = null;
  for (const [label, v] of subs) {
    if (typeof v === "number" && (best === null || v > best.v)) best = { label, v };
  }
  return best?.label;
}

/**
 * Parse an Open-Meteo air-quality `current` payload into AirQualityData.
 * Returns null when there's no usable US AQI reading.
 */
export function parseAirQuality(json: OpenMeteoAir): AirQualityData | null {
  const c = json.current;
  if (!c || typeof c.us_aqi !== "number") return null;
  const num = (v: number | null | undefined, d = 0) =>
    typeof v === "number" ? round(v, d) : undefined;
  return {
    usAqi: round(c.us_aqi),
    dominantPollutant: dominantPollutant(c),
    pm2_5: num(c.pm2_5, 1),
    pm10: num(c.pm10, 1),
    ozone: num(c.ozone),
    observedAt: c.time ? new Date(`${c.time}:00Z`).toISOString() : undefined,
  };
}

export async function fetchAirQuality(
  loc: Location,
): Promise<Wrapped<AirQualityData>> {
  const fetchedAt = nowIso();
  const url =
    `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${loc.lat}` +
    `&longitude=${loc.lon}` +
    `&current=us_aqi,pm2_5,pm10,ozone,us_aqi_pm2_5,us_aqi_pm10,us_aqi_ozone`;
  try {
    const res = await fetchWithTimeout(url, {
      timeoutMs: 7000,
      next: { revalidate: 3600 }, // 1h — the model updates hourly
    });
    if (!res.ok) throw new Error(`Open-Meteo air-quality -> ${res.status}`);
    const data = parseAirQuality(await res.json());
    return {
      source: "Open-Meteo (air quality)",
      status: data ? "ok" : "error",
      fetchedAt,
      attribution: ATTRIBUTION,
      data,
      note: data ? undefined : "no air-quality reading returned",
    };
  } catch (e) {
    return {
      source: "Open-Meteo (air quality)",
      status: "error",
      fetchedAt,
      attribution: ATTRIBUTION,
      data: null,
      note: String(e),
    };
  }
}
