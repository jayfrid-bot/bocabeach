import type { Location, WeatherData, Wrapped } from "@/lib/types";
import {
  cToF,
  degToCardinal,
  fetchWithTimeout,
  fetchedAtOf,
  kmhToMph,
  nowIso,
  oldestIso,
  round,
} from "@/lib/util";

const ATTRIBUTION = "U.S. National Weather Service (weather.gov)";
// Beyond this, the latest station observation is too old to call a live "ok" reading.
const STALE_AFTER_MS = 120 * 60_000;

// NWS responses are deeply nested; we read defensively with a loose type.
type Json = Record<string, unknown> & { properties?: Record<string, unknown> };

async function getJsonAt(
  url: string,
  revalidate: number,
): Promise<{ json: Json; at: string }> {
  const res = await fetchWithTimeout(url, {
    headers: { Accept: "application/geo+json" },
    next: { revalidate },
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return { json: (await res.json()) as Json, at: fetchedAtOf(res) };
}
async function getJson(url: string, revalidate: number): Promise<Json> {
  return (await getJsonAt(url, revalidate)).json;
}

async function fetchLatestObservation(
  stationsUrl: string,
): Promise<{ data: Partial<WeatherData>; at?: string }> {
  const stations = await getJson(stationsUrl, 86400);
  const features = (stations.features as Json[] | undefined) ?? [];
  const stationId = (features[0]?.properties as Record<string, unknown> | undefined)
    ?.stationIdentifier as string | undefined;
  if (!stationId) return { data: {} };

  const { json: obs, at } = await getJsonAt(
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
  return { data: out, at };
}

/**
 * The NWS gridpoint (NDFD) skyCover % in effect at `nowMs`. Grid values carry
 * ISO-8601 validTime spans like "2026-06-12T18:00:00+00:00/PT2H". Pure.
 */
export function skyCoverNow(
  grid: Json,
  nowMs: number,
): number | undefined {
  const values = ((grid.properties as Record<string, unknown> | undefined)?.skyCover as
    | { values?: Array<{ validTime?: string; value?: number | null }> }
    | undefined)?.values;
  if (!Array.isArray(values)) return undefined;
  for (const v of values) {
    if (typeof v.value !== "number" || !v.validTime) continue;
    const [startIso, dur] = v.validTime.split("/");
    const start = Date.parse(startIso);
    const h = /PT(\d+)H/.exec(dur ?? "");
    const span = h ? Number(h[1]) * 3600_000 : 3600_000;
    if (Number.isFinite(start) && nowMs >= start && nowMs < start + span) return v.value;
  }
  return undefined;
}

export async function fetchWeather(loc: Location): Promise<Wrapped<WeatherData>> {
  let fetchedAt = nowIso();
  try {
    const points = await getJson(
      `https://api.weather.gov/points/${loc.lat},${loc.lon}`,
      86400,
    );
    const p = (points.properties ?? {}) as Record<string, string>;

    const [obs, hourly, grid] = await Promise.allSettled([
      fetchLatestObservation(p.observationStations),
      getJsonAt(p.forecastHourly, 3600),
      getJsonAt(p.forecastGridData, 3600),
    ]);

    // Honest freshness: the oldest of the live data responses (the 24h-cached
    // points/stations metadata doesn't count — it's routing, not data).
    fetchedAt = oldestIso(
      obs.status === "fulfilled" ? obs.value.at : undefined,
      hourly.status === "fulfilled" ? hourly.value.at : undefined,
    );

    const data: WeatherData = {};
    if (obs.status === "fulfilled") Object.assign(data, obs.value.data);

    if (hourly.status === "fulfilled") {
      const periods =
        ((hourly.value.json.properties as Record<string, unknown>)?.periods as Json[]) ?? [];
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

    if (grid.status === "fulfilled") {
      const sky = skyCoverNow(grid.value.json, Date.now());
      if (sky != null) data.cloudCoverPct = round(sky);
    }

    if (data.windDirDeg != null && !data.windDirCardinal) {
      data.windDirCardinal = degToCardinal(data.windDirDeg);
    }

    const hasAny = Object.keys(data).length > 0;
    // Downgrade a fresh HTTP response when the station observation itself is old:
    // NWS keeps serving the last observation even when a station stops reporting.
    const obsMs = data.observedAt ? new Date(data.observedAt).getTime() : NaN;
    const aged = Number.isFinite(obsMs) && Date.now() - obsMs > STALE_AFTER_MS;
    return {
      source: "NWS api.weather.gov",
      status: !hasAny ? "error" : aged ? "stale" : "ok",
      fetchedAt: hasAny && aged ? oldestIso(data.observedAt, fetchedAt) : fetchedAt,
      attribution: ATTRIBUTION,
      data: hasAny ? data : null,
      note: hasAny && aged ? "station observation is stale" : undefined,
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
