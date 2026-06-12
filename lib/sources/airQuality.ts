import type { AirQualityData, Location, Wrapped } from "@/lib/types";
import { fetchedAtOf, fetchWithTimeout, nowIso, round } from "@/lib/util";

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

// --- EPA AirNow (actual monitor network; preferred when a key is set) ------
interface AirNowObs {
  ParameterName?: string; // "PM2.5" | "O3" | "PM10"
  AQI?: number;
  DateObserved?: string;
  HourObserved?: number;
  LocalTimeZone?: string;
}

/** Parse AirNow current observations: overall AQI = the worst pollutant. Pure. */
export function parseAirNow(rows: AirNowObs[]): AirQualityData | null {
  const valid = (rows ?? []).filter(
    (r) => typeof r.AQI === "number" && r.AQI >= 0 && typeof r.ParameterName === "string",
  );
  if (!valid.length) return null;
  const worst = valid.reduce((a, b) => ((b.AQI as number) > (a.AQI as number) ? b : a));
  const label = worst.ParameterName === "O3" ? "Ozone" : worst.ParameterName;
  return { usAqi: round(worst.AQI as number), dominantPollutant: label };
}

async function fetchAirNow(
  loc: Location,
  key: string,
): Promise<Wrapped<AirQualityData> | null> {
  const url =
    `https://www.airnowapi.org/aq/observation/latLong/current/?format=application/json` +
    `&latitude=${loc.lat}&longitude=${loc.lon}&distance=25&API_KEY=${encodeURIComponent(key)}`;
  try {
    const res = await fetchWithTimeout(url, {
      timeoutMs: 7000,
      next: { revalidate: 1800 }, // 30m — monitors report hourly
    });
    if (!res.ok) return null;
    const data = parseAirNow((await res.json()) as AirNowObs[]);
    if (!data) return null;
    return {
      source: "EPA AirNow",
      status: "ok",
      fetchedAt: fetchedAtOf(res),
      attribution: "US EPA AirNow (airnow.gov) — official monitor network",
      data,
    };
  } catch {
    return null; // fall through to the Open-Meteo model
  }
}

export async function fetchAirQuality(
  loc: Location,
): Promise<Wrapped<AirQualityData>> {
  // Actual EPA monitors beat a model — use AirNow when a key is configured,
  // quietly falling back to Open-Meteo if it errors or has no nearby monitor.
  const airNowKey = process.env.AIRNOW_API_KEY;
  if (airNowKey) {
    const observed = await fetchAirNow(loc, airNowKey);
    if (observed) return observed;
  }
  let fetchedAt = nowIso();
  const url =
    `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${loc.lat}` +
    `&longitude=${loc.lon}` +
    `&current=us_aqi,pm2_5,pm10,ozone,us_aqi_pm2_5,us_aqi_pm10,us_aqi_ozone`;
  try {
    const res = await fetchWithTimeout(url, {
      timeoutMs: 7000,
      next: { revalidate: 3600 }, // 1h — the model updates hourly
    });
    fetchedAt = fetchedAtOf(res);
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
