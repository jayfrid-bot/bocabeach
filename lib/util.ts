// Small, dependency-free helpers shared across data sources.

export const cToF = (c: number): number => (c * 9) / 5 + 32;
export const mToFt = (m: number): number => m * 3.280839895;
export const msToMph = (ms: number): number => ms * 2.236936;
export const knotsToMph = (kt: number): number => kt * 1.150779;
export const kmhToMph = (kmh: number): number => kmh * 0.621371;

export const round = (n: number, decimals = 0): number => {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
};

const CARDINALS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];

/** Convert a compass bearing in degrees to a 16-point cardinal label. */
export function degToCardinal(deg: number): string {
  const idx = Math.round(((deg % 360) / 22.5)) % 16;
  return CARDINALS[idx];
}

/** Great-circle distance between two lat/lon points, in statute miles. */
export function haversineMiles(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 3958.8; // mean Earth radius (mi)
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Initial great-circle compass bearing FROM point 1 TO point 2 (deg, 0=N, 90=E). */
export function bearingDeg(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dl = toRad(lon2 - lon1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Smallest absolute difference between two compass bearings (0-180). */
export function angularDistance(a: number, b: number): number {
  const d = Math.abs((a - b) % 360);
  return d > 180 ? 360 - d : d;
}

/** Triangular comfort curve: 100 at `ideal`, falling linearly to 0 at +/- `spread`. */
export function triangular(value: number, ideal: number, spread: number): number {
  const d = Math.abs(value - ideal);
  return clamp(100 * (1 - d / spread), 0, 100);
}

/**
 * Plateau curve: 100 across [idealLow, idealHigh], decaying linearly to 0 over
 * `falloff` units on each side. Good for "comfortable range" inputs.
 */
export function plateau(
  value: number,
  idealLow: number,
  idealHigh: number,
  falloff: number,
): number {
  if (value >= idealLow && value <= idealHigh) return 100;
  const d = value < idealLow ? idealLow - value : value - idealHigh;
  return clamp(100 * (1 - d / falloff), 0, 100);
}

export const clamp = (n: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, n));

/**
 * Dew point (°F) from air temperature (°F) and relative humidity (%), via the
 * Magnus-Tetens approximation. A fallback for sources that report temp + humidity
 * but no dew point. Returns undefined for out-of-range humidity.
 */
export function dewPointFromTempRH(tempF: number, rh: number): number | undefined {
  if (!(rh > 0) || rh > 100) return undefined;
  const tc = ((tempF - 32) * 5) / 9;
  const a = 17.625;
  const b = 243.04;
  const gamma = Math.log(rh / 100) + (a * tc) / (b + tc);
  const dpC = (b * gamma) / (a - gamma);
  return (dpC * 9) / 5 + 32;
}

/** Loosened init type so Next.js's `next.revalidate` caching option type-checks everywhere. */
export type FetchInit = RequestInit & {
  timeoutMs?: number;
  next?: { revalidate?: number | false; tags?: string[] };
};

/** fetch() with a timeout and the project User-Agent applied. */
export async function fetchWithTimeout(
  url: string,
  init: FetchInit = {},
): Promise<Response> {
  const { timeoutMs = 8000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...rest,
      signal: controller.signal,
      headers: {
        "User-Agent":
          process.env.CONDITIONS_USER_AGENT ??
          "boca-beach-rats (https://github.com/)",
        ...(rest.headers ?? {}),
      },
    } as RequestInit);
  } finally {
    clearTimeout(timer);
  }
}

export const nowIso = (): string => new Date().toISOString();

/**
 * When an HTTP response was actually produced, from its `Date` header. Next's
 * fetch cache (`next.revalidate`) stores responses with their original headers,
 * so a cache hit keeps the upstream's timestamp — using this for `fetchedAt`
 * means the "data sources" footer reports real freshness instead of restamping
 * cached data as new on every request. Falls back to now when absent/invalid.
 */
export function fetchedAtOf(res: Response): string {
  const d = res.headers.get("date");
  if (d) {
    const t = new Date(d);
    if (Number.isFinite(t.getTime())) return t.toISOString();
  }
  return nowIso();
}

/** The oldest of several fetch timestamps — honest freshness for multi-request sources. */
export function oldestIso(...isos: (string | undefined)[]): string {
  const ts = isos.filter((s): s is string => !!s).map((s) => new Date(s).getTime());
  return ts.length ? new Date(Math.min(...ts)).toISOString() : nowIso();
}
