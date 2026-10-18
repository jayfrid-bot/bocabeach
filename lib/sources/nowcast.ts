import type { Location, NowcastData, Wrapped } from "@/lib/types";
import { fetchNowPoint, MAX_AGE_MS, staleNote, type PointResult, type SplitNow } from "@/lib/sources/openMeteo";
import { nowIso } from "@/lib/util";

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

/**
 * Short-term rain nowcast, from the shared call B (lib/sources/openMeteo.ts:
 * today's GMT day of 15-minute rain in mm, as before). A failed call falls back
 * to the last good copy only while it is at most 30 min old ("stale"); an older
 * copy is too old to say whether it is raining now.
 */
export async function fetchNowcast(
  loc: Location,
  point?: Promise<PointResult<SplitNow>>,
): Promise<Wrapped<NowcastData>> {
  const p = await (point ?? fetchNowPoint(loc));
  const tooOld = p.ok && p.stale != null && p.stale.ageMs > MAX_AGE_MS.nowcast;
  if (!p.ok || tooOld) {
    return {
      source: "Open-Meteo (nowcast)",
      status: "error",
      fetchedAt: p.ok ? p.fetchedAt : nowIso(),
      attribution: ATTRIBUTION,
      data: null,
      note: !p.ok
        ? p.error
        : `live update failed (${p.stale!.reason}); the last copy is ${Math.round(p.stale!.ageMs / 60_000)} min old, too old for a nowcast`,
    };
  }
  const data = parseNowcast(p.split.minutely as MinutelyJson, Date.now());
  return {
    source: "Open-Meteo (nowcast)",
    status: !data ? "best-effort" : p.stale ? "stale" : "ok",
    fetchedAt: p.fetchedAt,
    attribution: ATTRIBUTION,
    data,
    note: !data ? "no minutely precipitation returned" : p.stale ? staleNote(p.stale) : undefined,
  };
}
