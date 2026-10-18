// Shared Open-Meteo client: hosts + API key, 429 back-off, last-good fallback,
// and the two merged /v1/forecast requests per beach point.
//
// Why this exists (2026-10-17): Open-Meteo's free API limits concurrent requests
// per IP, and Cloudflare Workers share outbound IPs with other customers. A cold
// conditions build fired ~8 Open-Meteo calls at once; Open-Meteo answered
// `429 Too many concurrent requests`, and the snapshot lost hourly, 7-day, GFS
// and nowcast data (so UV and sand temperature went missing). Three defences:
//   1. Fewer calls: five /v1/forecast calls per beach became two
//      (forecastPointUrl, nowPointUrl).
//   2. Back-off: a 429 pauses calls to that Open-Meteo host for ~60 s in this
//      isolate, so a build does not fire more doomed calls.
//   3. Last-good: every good response is kept (isolate memory + the edge
//      Cache API) and served, marked "stale" with its age, when a live call
//      fails. Docs: docs/open-meteo.md.
//
// Paid plan: set the OPEN_METEO_API_KEY secret and every call moves to the
// customer-*.open-meteo.com hosts with `&apikey=`. The key never appears in a
// log line or a note (notes carry the host only).

import { currentBudget } from "@/lib/alerts/budget";
import { fetchedAtOf, fetchWithTimeout, SubrequestBudgetExhausted } from "@/lib/util";

// --- hosts + key -------------------------------------------------------------

export type OpenMeteoHost =
  | "api"
  | "marine-api"
  | "air-quality-api"
  | "satellite-api"
  | "geocoding-api";

/** The paid-plan key, read the same way the other secrets are (process.env,
 *  which OpenNext fills from the Worker's env). Empty or unset = free API. */
export function openMeteoApiKey(): string | undefined {
  const k = process.env.OPEN_METEO_API_KEY?.trim();
  return k ? k : undefined;
}

/**
 * Build an Open-Meteo URL. `pathAndQuery` starts with the path, e.g.
 * "/v1/forecast?latitude=..". With a key set, the host becomes
 * customer-<host>.open-meteo.com and `apikey=` is appended.
 */
export function openMeteoUrl(host: OpenMeteoHost, pathAndQuery: string): string {
  const key = openMeteoApiKey();
  const url = `https://${key ? "customer-" : ""}${host}.open-meteo.com${pathAndQuery}`;
  if (!key) return url;
  return `${url}${url.includes("?") ? "&" : "?"}apikey=${encodeURIComponent(key)}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "open-meteo";
  }
}

// --- 429 back-off (isolate-wide, per host) -----------------------------------

/** Base pause after a 429. Jittered ±25% so isolates don't all return at once. */
export const OPEN_METEO_BACKOFF_MS = 60_000;
/** A Retry-After longer than this is capped (we still have last-good data). */
const BACKOFF_MAX_MS = 5 * 60_000;

const backoffUntil = new Map<string, number>();

/** Milliseconds left on the back-off for this URL's host (0 = not paused). */
export function openMeteoBackoffRemainingMs(url: string, nowMs = Date.now()): number {
  const until = backoffUntil.get(hostOf(url));
  return until != null && until > nowMs ? until - nowMs : 0;
}

/** Record a 429 from `url`'s host. Starts a new pause only when none is
 *  running, and logs once per pause (host only, never the URL or key). */
export function noteOpenMeteo429(
  url: string,
  retryAfter: string | null = null,
  nowMs = Date.now(),
  rand: () => number = Math.random,
): void {
  const host = hostOf(url);
  if (openMeteoBackoffRemainingMs(url, nowMs) > 0) return;
  const jittered = OPEN_METEO_BACKOFF_MS * (0.75 + 0.5 * rand());
  const ra = retryAfter != null ? Number(retryAfter) * 1000 : NaN;
  const ms = Math.min(BACKOFF_MAX_MS, Math.max(jittered, Number.isFinite(ra) ? ra : 0));
  backoffUntil.set(host, nowMs + ms);
  console.warn(`[open-meteo] 429 from ${host}; pausing calls to it for ${Math.round(ms / 1000)} s`);
}

/** Thrown by {@link openMeteoFetch} while a host is paused — no call is made. */
export class OpenMeteoBackoff extends Error {
  constructor(url: string, remainingMs: number) {
    super(`${hostOf(url)} paused after a 429 (${Math.ceil(remainingMs / 1000)} s left)`);
    this.name = "OpenMeteoBackoff";
  }
}

/**
 * fetchWithTimeout for Open-Meteo: refuses (throws OpenMeteoBackoff) while the
 * host is paused, and starts a pause when the answer is a 429. Callers that do
 * their own parsing (lib/alerts/rain.ts, lib/resolve/geocode.ts) use this.
 */
export async function openMeteoFetch(
  url: string,
  init: Parameters<typeof fetchWithTimeout>[1] = {},
): Promise<Response> {
  const left = openMeteoBackoffRemainingMs(url);
  if (left > 0) throw new OpenMeteoBackoff(url, left);
  const res = await fetchWithTimeout(url, init);
  if (res.status === 429) noteOpenMeteo429(url, res.headers.get("retry-after"));
  return res;
}

// --- last-good store -----------------------------------------------------------

interface LastGood {
  text: string;
  savedAtMs: number;
}

/** How long the edge cache keeps a copy. The longest max age any caller asks for. */
const STORE_TTL_S = 3 * 3600;
/** Rewrite the edge-cache copy of one key at most this often per isolate. */
const EDGE_WRITE_EVERY_MS = 10 * 60_000;
const MEMORY_MAX = 400;
/** Synthetic origin for Cache API keys. Never fetched; only a cache key. */
const STORE_ORIGIN = "https://open-meteo-last-good.isitbeachday.internal/";

const memory = new Map<string, LastGood>();
const lastEdgeWrite = new Map<string, number>();

/**
 * Cache API calls share Cloudflare's per-request subrequest quota, but they do
 * not pass through fetchWithTimeout, so the push run's SubrequestBudget
 * (lib/alerts/budget.ts) would not see them. Under a budget: never write
 * (the copy is optional), and charge each read 1, skipping it when the budget
 * cannot pay. Outside a budget (page loads, the history cron) both run freely.
 */
function mayUseEdgeCache(op: "read" | "write"): boolean {
  const budget = currentBudget();
  if (!budget) return true;
  if (op === "write") return false;
  return budget.take(1);
}

function edgeCache(): Cache | null {
  try {
    const c = (globalThis as { caches?: { default?: Cache } }).caches?.default;
    return c ?? null;
  } catch {
    return null;
  }
}

function storeUrl(key: string): string {
  return STORE_ORIGIN + encodeURIComponent(key);
}

async function saveLastGood(key: string, text: string, savedAtMs: number): Promise<void> {
  const prev = memory.get(key);
  if (prev && prev.savedAtMs >= savedAtMs) return; // same (cached) response or older
  memory.delete(key); // re-insert so the Map's order is "least recently saved first"
  memory.set(key, { text, savedAtMs });
  if (memory.size > MEMORY_MAX) {
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }
  const cache = edgeCache();
  if (!cache || !mayUseEdgeCache("write")) return;
  const now = Date.now();
  if (now - (lastEdgeWrite.get(key) ?? 0) < EDGE_WRITE_EVERY_MS) return;
  lastEdgeWrite.set(key, now);
  try {
    await cache.put(
      storeUrl(key),
      new Response(text, {
        headers: {
          "content-type": "application/json",
          "cache-control": `public, max-age=${STORE_TTL_S}`,
          "x-om-saved-at": String(savedAtMs),
        },
      }),
    );
  } catch {
    // A cache write is best effort; the memory copy still stands.
  }
}

async function loadLastGood(key: string, maxAgeMs: number, nowMs: number): Promise<LastGood | null> {
  const mem = memory.get(key);
  if (mem && nowMs - mem.savedAtMs <= maxAgeMs) return mem;
  const cache = edgeCache();
  if (!cache || !mayUseEdgeCache("read")) return null;
  try {
    const hit = await cache.match(storeUrl(key));
    if (!hit) return null;
    const savedAtMs = Number(hit.headers.get("x-om-saved-at"));
    if (!Number.isFinite(savedAtMs) || nowMs - savedAtMs > maxAgeMs) return null;
    const rec = { text: await hit.text(), savedAtMs };
    if (!mem || mem.savedAtMs < savedAtMs) memory.set(key, rec);
    return rec;
  } catch {
    return null;
  }
}

/** Test seam: forget every back-off and every last-good copy in this isolate. */
export function __resetOpenMeteoStateForTests(): void {
  backoffUntil.clear();
  memory.clear();
  lastEdgeWrite.clear();
}

// --- fetch with fallback -------------------------------------------------------

export interface OpenMeteoStale {
  /** Age of the copy served, in ms. */
  ageMs: number;
  /** Why the live call failed (host + status, never the URL). */
  reason: string;
}

export type OpenMeteoResult<T> =
  | { ok: true; json: T; fetchedAt: string; stale?: OpenMeteoStale }
  | { ok: false; error: string };

export interface OpenMeteoFetchOpts {
  /** Last-good key: endpoint + point, e.g. "marine:26.35,-80.07". */
  storeKey: string;
  /** Oldest copy this caller will accept when the live call fails. */
  maxAgeMs: number;
  timeoutMs?: number;
  /** Next's fetch-cache revalidate (seconds). */
  revalidate?: number;
}

/** "N min ago" note text for a stale copy. Plain words, no URL. */
export function staleNote(stale: OpenMeteoStale): string {
  const min = Math.max(1, Math.round(stale.ageMs / 60_000));
  return `live update failed (${stale.reason}); showing the copy from ${min} min ago`;
}

/**
 * GET + JSON-parse an Open-Meteo URL with the house rules:
 *   - paused host (recent 429) → no call, straight to last-good;
 *   - 429 → start the pause, no retry;
 *   - other 4xx / budget exhausted → no retry;
 *   - network error, 5xx, non-JSON 200 → one retry after 800 ms (no-store),
 *     unless a pause started meanwhile;
 *   - success → saved as last-good;
 *   - failure → last-good copy no older than `maxAgeMs`, flagged `stale`, else
 *     `{ ok: false }`.
 * Never throws.
 */
export async function fetchOpenMeteoJson<T>(
  url: string,
  opts: OpenMeteoFetchOpts,
): Promise<OpenMeteoResult<T>> {
  const host = hostOf(url);
  const { timeoutMs = 8000, revalidate } = opts;

  const attempt = async (
    retry: boolean,
  ): Promise<{ ok: true; text: string; json: T; res: Response } | { ok: false; reason: string; final: boolean }> => {
    let res: Response;
    try {
      res = await openMeteoFetch(
        url,
        retry
          ? { timeoutMs, cache: "no-store" }
          : { timeoutMs, ...(revalidate != null ? { next: { revalidate } } : {}) },
      );
    } catch (e) {
      if (e instanceof OpenMeteoBackoff || e instanceof SubrequestBudgetExhausted) {
        return { ok: false, reason: e.message, final: true };
      }
      const msg = e instanceof Error ? e.message : String(e);
      // A timeout is usually an overloaded upstream: a retry adds load and
      // doubles the wait. Fall back to the last good copy instead.
      const timedOut = e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
      return { ok: false, reason: `${host}: ${timedOut ? "timed out" : msg}`, final: timedOut };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        reason: `${host} -> ${res.status}: "${body.slice(0, 60)}"`,
        final: res.status < 500, // 4xx (incl. 429) is never retried
      };
    }
    const text = await res.text().catch(() => "");
    try {
      return { ok: true, text, json: JSON.parse(text) as T, res };
    } catch {
      return { ok: false, reason: `${host} -> ${res.status} non-JSON: "${text.slice(0, 60)}"`, final: false };
    }
  };

  let r = await attempt(false);
  if (!r.ok && !r.final && openMeteoBackoffRemainingMs(url) === 0) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    r = await attempt(true);
  }
  if (r.ok) {
    const fetchedAt = fetchedAtOf(r.res);
    const savedAtMs = Date.parse(fetchedAt);
    await saveLastGood(opts.storeKey, r.text, Number.isFinite(savedAtMs) ? savedAtMs : Date.now());
    return { ok: true, json: r.json, fetchedAt };
  }

  const nowMs = Date.now();
  const last = await loadLastGood(opts.storeKey, opts.maxAgeMs, nowMs);
  if (last) {
    try {
      return {
        ok: true,
        json: JSON.parse(last.text) as T,
        fetchedAt: new Date(last.savedAtMs).toISOString(),
        stale: { ageMs: Math.max(0, nowMs - last.savedAtMs), reason: r.reason },
      };
    } catch {
      // A corrupt copy is no copy.
    }
  }
  return { ok: false, error: r.reason };
}

// --- the two merged /v1/forecast requests --------------------------------------
//
// Before: five calls to api.open-meteo.com per beach (hourly, 7-day, nowcast,
// GFS, marine's current UV). Now two, split along the one line the API forces
// on us: asking for `current` or `minutely_15` in the SAME request as `hourly`
// changes the hourly numbers (Open-Meteo then builds the near-term hours from
// 15-minute data; seen 2026-10-17 at Boca: 0.028 in became 0.858 in for one
// past hour). So:
//   A. "forecast": hourly + daily. Checked equal to the old separate calls,
//      value for value (3,456 hourly values + 35 daily values, 2026-10-17).
//   B. "now": 15-minute rain + current UV/cloud + GFS, via
//      `models=best_match,gfs_seamless`. `current` comes from the FIRST model
//      listed (best match); GFS "current" is the gfs_seamless 15-minute slot at
//      current.time. Checked equal to the old calls at 3 points, 2026-10-17.

/** Max age of a last-good copy per consumer (owner spec, 2026-10-17). */
export const MAX_AGE_MS = {
  hourly: 3 * 3600_000,
  forecast: 3 * 3600_000,
  gfs: 3 * 3600_000,
  nowcast: 30 * 60_000,
  marine: 3 * 3600_000,
  air: 3 * 3600_000,
  satellite: 3 * 3600_000,
  spot: 3600_000,
} as const;

/** Days of DAILY forecast (and of hourly forecast after today's GMT midnight)
 *  the app uses. The outlook strip shows one tile per daily day and scores it
 *  from hourly hours, so both MUST cover the same 7 days (2026-07-17 bug). */
export const FORECAST_DAYS = 7;
/** Hourly history kept before today's GMT midnight (man-o'-war trailing wind). */
export const HOURLY_PAST_DAYS = 2;
/** What call A REQUESTS. It is in the beach's local time zone (the daily
 *  block needs local days), so it asks one extra day each side and trims back
 *  to the GMT window the hourly parser was built on. */
const REQ_PAST_DAYS = HOURLY_PAST_DAYS + 1;
const REQ_FORECAST_DAYS = FORECAST_DAYS + 1;

const HOURLY_VARS = [
  "temperature_2m", "cloud_cover", "cloud_cover_low", "cloud_cover_mid", "cloud_cover_high",
  "precipitation_probability", "weather_code", "wind_speed_10m", "wind_direction_10m",
  "uv_index", "uv_index_clear_sky", "relative_humidity_2m", "dew_point_2m",
  "soil_temperature_0cm", "shortwave_radiation", "precipitation",
] as const;
const DAILY_VARS = [
  "temperature_2m_max", "temperature_2m_min", "precipitation_probability_max",
  "weathercode", "wind_speed_10m_max",
] as const;
const GFS_VARS = [
  "temperature_2m", "relative_humidity_2m", "dew_point_2m",
  "wind_speed_10m", "wind_direction_10m", "cloud_cover",
] as const;
/** uv_index rides along so a STALE copy can still give the marine source a
 *  value for now (the current block is frozen at fetch time). */
const NOW_MINUTELY_VARS = ["precipitation", "uv_index", ...GFS_VARS] as const;
const NOW_CURRENT_VARS = ["uv_index", "cloud_cover"] as const;

/** Call A: hourly + daily. Imperial units, precipitation in inches, unix times
 *  (so the local-zone request still yields exact UTC instants). */
export function forecastPointUrl(lat: number, lon: number): string {
  return openMeteoUrl(
    "api",
    `/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&hourly=${HOURLY_VARS.join(",")}` +
      `&daily=${DAILY_VARS.join(",")}` +
      `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch` +
      `&timezone=auto&timeformat=unixtime` +
      `&past_days=${REQ_PAST_DAYS}&forecast_days=${REQ_FORECAST_DAYS}`,
  );
}

/** Call B: today's GMT day of 15-minute data (rain in mm, as the nowcast's
 *  threshold expects) + current UV/cloud + GFS. */
export function nowPointUrl(lat: number, lon: number): string {
  return openMeteoUrl(
    "api",
    `/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&minutely_15=${NOW_MINUTELY_VARS.join(",")}` +
      `&current=${NOW_CURRENT_VARS.join(",")}` +
      `&models=best_match,gfs_seamless` +
      `&temperature_unit=fahrenheit&wind_speed_unit=mph&forecast_days=1`,
  );
}

type Num = number | null;
type Block = Record<string, unknown[] | undefined>;

/** Call A's raw response (only the parts we read). */
export interface ForecastPointJson {
  timezone?: string;
  hourly?: Block & { time?: number[] };
  daily?: Block & { time?: number[] };
}

/** Call B's raw response (only the parts we read). */
export interface NowPointJson {
  current?: { time?: string; uv_index?: Num; cloud_cover?: Num };
  minutely_15?: Block & { time?: string[] };
}

/** The shapes the existing parsers take, rebuilt from call A. */
export interface SplitForecast {
  /** For parseOpenMeteoHourly: GMT "YYYY-MM-DDThh:mm" times, 2 past + 7 GMT days. */
  hourly: { hourly: Record<string, unknown[]> & { time: string[] } };
  /** For parseOpenMeteoDaily: 7 local days starting today. */
  daily: { daily: Record<string, unknown[]> & { time: string[] } };
}

/** The shapes the existing parsers take, rebuilt from call B. */
export interface SplitNow {
  /** For parseNowcast. */
  minutely: { minutely_15: { time: string[]; precipitation: Num[] } };
  /** For parseGfsCurrent. */
  gfs: { current: Record<string, Num> } | null;
  /** Best-match current UV + cloud (marine source). */
  current: { uv_index: Num; cloud_cover: Num } | null;
}

const DAY_MS = 86_400_000;
const gmtStamp = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 16);
const utcDayStart = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;
const numOrNull = (x: unknown): Num => (typeof x === "number" ? x : null);

/** One variable's array. A multi-model response suffixes the default model. */
function series(block: Block | undefined, v: string, model = "best_match"): unknown[] | undefined {
  if (!block) return undefined;
  return block[`${v}_${model}`] ?? (model === "best_match" ? block[v] : undefined);
}

function localDate(sec: number, tz: string | undefined): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(sec * 1000));
    const get = (t: string) => parts.find((p) => p.type === t)?.value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    return null;
  }
}

/**
 * Split call A into what parseOpenMeteoHourly and parseOpenMeteoDaily take, so
 * their outputs match the old separate calls. `refMs` is when the response was
 * made (its Date header): the old calls cut their windows from that moment.
 */
export function splitForecastPoint(json: ForecastPointJson, refMs: number): SplitForecast {
  const today = utcDayStart(refMs);

  // Hourly: [today - 2 d, today + 7 d) GMT — the old past_days=2&forecast_days=7.
  const hTimes = (json.hourly?.time ?? []) as number[];
  const hFrom = today - HOURLY_PAST_DAYS * DAY_MS;
  const hTo = today + FORECAST_DAYS * DAY_MS;
  const hIdx: number[] = [];
  hTimes.forEach((t, i) => {
    if (t * 1000 >= hFrom && t * 1000 < hTo) hIdx.push(i);
  });
  const hourly: SplitForecast["hourly"]["hourly"] = { time: hIdx.map((i) => gmtStamp(hTimes[i])) };
  for (const v of HOURLY_VARS) {
    const s = series(json.hourly, v);
    if (s) hourly[v] = hIdx.map((i) => s[i] ?? null);
  }

  // Daily: the 7 local days from local "today" on — the old timezone=auto&forecast_days=7.
  const dTimes = (json.daily?.time ?? []) as number[];
  const todayLocal = localDate(refMs / 1000, json.timezone);
  const dIdx: number[] = [];
  const dDates: string[] = [];
  dTimes.forEach((t, i) => {
    // A daily time is local midnight; +12 h is safely inside that local day.
    const d = localDate(t + 12 * 3600, json.timezone);
    if (d && todayLocal && d >= todayLocal && dIdx.length < FORECAST_DAYS) {
      dIdx.push(i);
      dDates.push(d);
    }
  });
  const daily: SplitForecast["daily"]["daily"] = { time: dDates };
  for (const v of DAILY_VARS) {
    const s = series(json.daily, v);
    if (s) daily[v] = dIdx.map((i) => s[i] ?? null);
  }

  return { hourly: { hourly }, daily: { daily } };
}

/**
 * Split call B into what parseNowcast, parseGfsCurrent and the marine source
 * take. A live answer reads GFS + UV at `current.time`. For a stale copy pass
 * `atMs` (now): the slot for now is used when the copy still covers it, so a
 * 2-hour-old copy reports its value for NOW rather than for 2 hours ago.
 */
export function splitNowPoint(json: NowPointJson, atMs?: number): SplitNow {
  const m = json.minutely_15;
  const times = (m?.time ?? []) as string[];
  const precip = series(m, "precipitation") ?? [];
  const minutely: SplitNow["minutely"] = {
    minutely_15: { time: [...times], precipitation: times.map((_, i) => numOrNull(precip[i])) },
  };

  const curTime = json.current?.time;
  let slot = -1;
  if (atMs != null) {
    // Latest slot starting at/before atMs, and atMs still inside it.
    for (let i = 0; i < times.length; i++) {
      const start = Date.parse(`${times[i]}:00Z`);
      if (start <= atMs && atMs < start + 15 * 60_000) slot = i;
    }
  }
  const useNowSlot = slot >= 0;
  if (!useNowSlot && curTime) slot = times.indexOf(curTime);

  let gfs: SplitNow["gfs"] = null;
  if (slot >= 0) {
    const cur: Record<string, Num> = {};
    for (const v of GFS_VARS) cur[v] = numOrNull(series(m, v, "gfs_seamless")?.[slot]);
    if (Object.values(cur).some((x) => x != null)) gfs = { current: cur };
  }

  let current: SplitNow["current"] = null;
  if (useNowSlot) {
    current = {
      uv_index: numOrNull(series(m, "uv_index")?.[slot]),
      cloud_cover: numOrNull(series(m, "cloud_cover")?.[slot]),
    };
  } else if (json.current) {
    current = { uv_index: numOrNull(json.current.uv_index), cloud_cover: numOrNull(json.current.cloud_cover) };
  }

  return { minutely, gfs, current };
}

export type PointResult<S> =
  | { ok: true; split: S; fetchedAt: string; stale?: OpenMeteoStale }
  | { ok: false; error: string };

/**
 * Call A for one point, or its last good copy (kept up to 3 h). lib/conditions.ts
 * calls this ONCE per build and hands the same promise to the hourly and 7-day
 * sources. Never rejects.
 */
export async function fetchForecastPoint(loc: { lat: number; lon: number }): Promise<PointResult<SplitForecast>> {
  try {
    const r = await fetchOpenMeteoJson<ForecastPointJson>(forecastPointUrl(loc.lat, loc.lon), {
      storeKey: `forecast:${loc.lat},${loc.lon}`,
      maxAgeMs: Math.max(MAX_AGE_MS.hourly, MAX_AGE_MS.forecast),
      timeoutMs: 8000,
      revalidate: 3600, // 1 h, as both old calls had
    });
    if (!r.ok) return r;
    // A live answer: cut the windows from when Open-Meteo made it (as the old
    // calls did). A stale copy: cut them from NOW, or a copy made before local
    // midnight would start the outlook on yesterday and show 8 tiles.
    const madeMs = Date.parse(r.fetchedAt);
    const refMs = r.stale || !Number.isFinite(madeMs) ? Date.now() : madeMs;
    return {
      ok: true,
      split: splitForecastPoint(r.json, refMs),
      fetchedAt: r.fetchedAt,
      stale: r.stale,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Call B for one point, or its last good copy (kept up to 3 h; the nowcast
 * applies its own 30-min limit). Shared by the nowcast, GFS and marine
 * sources within one build. Never rejects.
 */
export async function fetchNowPoint(loc: { lat: number; lon: number }): Promise<PointResult<SplitNow>> {
  try {
    const r = await fetchOpenMeteoJson<NowPointJson>(nowPointUrl(loc.lat, loc.lon), {
      storeKey: `now:${loc.lat},${loc.lon}`,
      maxAgeMs: Math.max(MAX_AGE_MS.nowcast, MAX_AGE_MS.gfs, MAX_AGE_MS.marine),
      timeoutMs: 8000,
      revalidate: 900, // 15 min, the nowcast's pace (GFS was 30, UV 60)
    });
    if (!r.ok) return r;
    return {
      ok: true,
      split: splitNowPoint(r.json, r.stale ? Date.now() : undefined),
      fetchedAt: r.fetchedAt,
      stale: r.stale,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
