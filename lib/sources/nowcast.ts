import type { Location, NowcastData, Wrapped } from "@/lib/types";
import { fetchedAtOf, fetchWithTimeout, nowIso } from "@/lib/util";

const ATTRIBUTION = "Open-Meteo (open-meteo.com)";
const WET_MM = 0.1; // precipitation at/above this (per 15 min) counts as "raining"
const WINDOW_MIN = 120; // look ahead this far

interface MinutelyJson {
  minutely_15?: { time?: string[]; precipitation?: (number | null)[] };
}

/**
 * Turn Open-Meteo 15-minute precipitation into a short-term nowcast: is it
 * raining now, and when does that flip within the next ~2h? Times come back in
 * GMT (no `timezone` requested), so we pin them to UTC. Pure + unit-tested.
 */
export function parseNowcast(
  json: MinutelyJson,
  nowMs: number,
  windowMin = WINDOW_MIN,
): NowcastData | null {
  const times = json.minutely_15?.time;
  const precip = json.minutely_15?.precipitation;
  if (!Array.isArray(times) || times.length === 0) return null;

  const pts = times
    .map((t, i) => ({
      ms: Date.parse(`${t}:00Z`),
      p: typeof precip?.[i] === "number" ? (precip[i] as number) : 0,
    }))
    .filter((x) => Number.isFinite(x.ms));
  if (!pts.length) return null;

  // The bucket covering "now" (latest start <= now), else the first bucket.
  let start = 0;
  for (let i = 0; i < pts.length; i++) {
    if (pts[i].ms <= nowMs) start = i;
    else break;
  }
  const horizon = nowMs + windowMin * 60000;
  const wet = (p: number) => p >= WET_MM;
  const nowWet = wet(pts[start].p);

  let changeInMin: number | undefined;
  for (let i = start + 1; i < pts.length && pts[i].ms <= horizon; i++) {
    if (wet(pts[i].p) !== nowWet) {
      changeInMin = Math.max(0, Math.round((pts[i].ms - nowMs) / 60000));
      break;
    }
  }

  const hrs = windowMin / 60;
  const state = nowWet ? "raining" : "dry";
  const text = nowWet
    ? changeInMin != null
      ? `Raining — easing in ~${changeInMin} min`
      : `Rain likely for the next ${hrs}+ hrs`
    : changeInMin != null
      ? `Dry — rain likely in ~${changeInMin} min`
      : `Dry for the next ${hrs}+ hrs`;
  return { state, changeInMin, text };
}

export async function fetchNowcast(loc: Location): Promise<Wrapped<NowcastData>> {
  let fetchedAt = nowIso();
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
    `&minutely_15=precipitation&forecast_days=1`;
  try {
    const res = await fetchWithTimeout(url, {
      timeoutMs: 7000,
      next: { revalidate: 900 }, // 15m — nowcast is short-term
    });
    fetchedAt = fetchedAtOf(res);
    if (!res.ok) throw new Error(`Open-Meteo minutely -> ${res.status}`);
    const data = parseNowcast(await res.json(), Date.now());
    return {
      source: "Open-Meteo (nowcast)",
      status: data ? "ok" : "best-effort",
      fetchedAt,
      attribution: ATTRIBUTION,
      data,
      note: data ? undefined : "no minutely precipitation returned",
    };
  } catch (e) {
    return {
      source: "Open-Meteo (nowcast)",
      status: "error",
      fetchedAt,
      attribution: ATTRIBUTION,
      data: null,
      note: String(e),
    };
  }
}
