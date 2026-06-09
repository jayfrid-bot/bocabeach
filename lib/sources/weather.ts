import type { Location, WeatherData, Wrapped } from "@/lib/types";
import {
  cToF,
  degToCardinal,
  fetchWithTimeout,
  kmhToMph,
  nowIso,
  round,
} from "@/lib/util";

const ATTRIBUTION = "U.S. National Weather Service (weather.gov)";

// NWS responses are deeply nested; we read defensively with a loose type.
type Json = Record<string, unknown> & { properties?: Record<string, unknown> };

async function getJson(url: string, revalidate: number): Promise<Json> {
  const res = await fetchWithTimeout(url, {
    headers: { Accept: "application/geo+json" },
    next: { revalidate },
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return (await res.json()) as Json;
}

async function fetchLatestObservation(
  stationsUrl: string,
): Promise<Partial<WeatherData>> {
  const stations = await getJson(stationsUrl, 86400);
  const features = (stations.features as Json[] | undefined) ?? [];
  const stationId = (features[0]?.properties as Record<string, unknown> | undefined)
    ?.stationIdentifier as string | undefined;
  if (!stationId) return {};

  const obs = await getJson(
    `https://api.weather.gov/stations/${stationId}/observations/latest`,
    600,
  );
  const pr = (obs.properties ?? {}) as Record<string, { value?: number } & Record<string, unknown>>;
  const out: Partial<WeatherData> = {};

  const temp = pr.temperature?.value;
  const wspd = pr.windSpeed?.value;
  const wdir = pr.windDirection?.value;
  const rh = pr.relativeHumidity?.value; // percent
  const dew = pr.dewpoint?.value; // Celsius
  if (typeof temp === "number") out.airTempF = round(cToF(temp));
  if (typeof wspd === "number") out.windSpeedMph = round(kmhToMph(wspd));
  if (typeof wdir === "number") out.windDirDeg = wdir;
  if (typeof rh === "number") out.humidityPct = round(rh);
  if (typeof dew === "number") out.dewPointF = round(cToF(dew));
  if (typeof pr.textDescription === "string") out.shortForecast = pr.textDescription;
  if (typeof pr.timestamp === "string") out.observedAt = pr.timestamp;
  return out;
}

export async function fetchWeather(loc: Location): Promise<Wrapped<WeatherData>> {
  const fetchedAt = nowIso();
  try {
    const points = await getJson(
      `https://api.weather.gov/points/${loc.lat},${loc.lon}`,
      86400,
    );
    const p = (points.properties ?? {}) as Record<string, string>;

    const [obs, hourly] = await Promise.allSettled([
      fetchLatestObservation(p.observationStations),
      getJson(p.forecastHourly, 3600),
    ]);

    const data: WeatherData = {};
    if (obs.status === "fulfilled") Object.assign(data, obs.value);

    if (hourly.status === "fulfilled") {
      const periods =
        ((hourly.value.properties as Record<string, unknown>)?.periods as Json[]) ?? [];
      const period = periods[0] as Record<string, unknown> | undefined;
      if (period) {
        if (typeof period.shortForecast === "string" && !data.shortForecast)
          data.shortForecast = period.shortForecast;
        if (typeof period.isDaytime === "boolean") data.isDaytime = period.isDaytime;
        const pop = (period.probabilityOfPrecipitation as { value?: number } | undefined)?.value;
        if (typeof pop === "number") data.precipProbability = pop;
        if (
          data.airTempF == null &&
          typeof period.temperature === "number" &&
          period.temperatureUnit === "F"
        ) {
          data.airTempF = period.temperature as number;
        }
      }
    }

    if (data.windDirDeg != null && !data.windDirCardinal) {
      data.windDirCardinal = degToCardinal(data.windDirDeg);
    }

    const hasAny = Object.keys(data).length > 0;
    return {
      source: "NWS api.weather.gov",
      status: hasAny ? "ok" : "error",
      fetchedAt,
      attribution: ATTRIBUTION,
      data: hasAny ? data : null,
    };
  } catch (e) {
    return {
      source: "NWS api.weather.gov",
      status: "error",
      fetchedAt,
      attribution: ATTRIBUTION,
      data: null,
      note: String(e),
    };
  }
}
