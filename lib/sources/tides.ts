import type { Location, TideData, TideObserved, Wrapped } from "@/lib/types";
import { computeTideAberration, type TideWindowEvent } from "@/lib/tideAberration";
import { interpolateTideHeightFt } from "@/lib/tideLevel";
import { fetchWithTimeout, fetchedAtOf, nowIso, round } from "@/lib/util";

const ATTRIBUTION = "NOAA Tides & Currents (tidesandcurrents.noaa.gov)";

/** Half-width of the aberration comparison window, in days (±this around today). */
const WINDOW_DAYS = 21;

interface NoaaPrediction {
  t: string; // "YYYY-MM-DD HH:mm" in GMT
  v: string; // height
  type: "H" | "L";
}

/** Parse a NOAA CO-OPS hi/lo predictions JSON (requested in GMT) into upcoming events. */
export function parseNoaaPredictions(
  json: { predictions?: NoaaPrediction[]; error?: { message: string } },
  nowMs: number = Date.now(),
): TideData | null {
  if (json.error || !Array.isArray(json.predictions)) return null;

  const events = json.predictions
    .map((p) => ({
      type: p.type === "H" ? ("high" as const) : ("low" as const),
      time: new Date(`${p.t.replace(" ", "T")}:00Z`).toISOString(),
      heightFt: round(Number(p.v), 1),
    }))
    .filter((e) => Number.isFinite(new Date(e.time).getTime()));

  const upcoming = events.filter((e) => new Date(e.time).getTime() >= nowMs);
  if (upcoming.length === 0) return null;

  // If the next event is a high tide, the tide is currently rising; else falling.
  const trend = upcoming[0].type === "high" ? "rising" : "falling";
  return { next: upcoming.slice(0, 4), trend };
}

function yyyymmdd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

/** Raw NOAA hi/lo predictions → the neutral event shape lib/tideAberration wants. */
function toWindowEvents(json: {
  predictions?: NoaaPrediction[];
}): TideWindowEvent[] {
  if (!Array.isArray(json.predictions)) return [];
  return json.predictions
    .map((p) => ({
      type: p.type === "H" ? ("high" as const) : ("low" as const),
      time: new Date(`${p.t.replace(" ", "T")}:00Z`).toISOString(),
      heightFt: round(Number(p.v), 2),
    }))
    .filter((e) => Number.isFinite(new Date(e.time).getTime()) && Number.isFinite(e.heightFt));
}

/**
 * Derive the full {@link TideData} (upcoming events + trend + today's aberration)
 * from one wide-window NOAA predictions payload. Exported so the parse is unit-
 * testable without a live fetch. The aberration is attached only when it's
 * confidently computed (honest-null otherwise — see lib/tideAberration.ts).
 */
export function deriveTideData(
  json: { predictions?: NoaaPrediction[]; error?: { message: string } },
  tz: string,
  nowMs: number = Date.now(),
): TideData | null {
  const data = parseNoaaPredictions(json, nowMs);
  if (!data) return null;
  const aberration = computeTideAberration(toWindowEvents(json), { nowMs, tz });
  if (aberration) data.aberration = aberration;
  return data;
}

// --- Observed water level (a REAL gauge, not a subordinate station) --------

interface NoaaWaterLevelJson {
  metadata?: { id?: string; name?: string };
  data?: { t: string; v: string }[];
  error?: { message: string };
}

/**
 * Parse a CO-OPS `product=water_level&date=latest` payload (requested in GMT)
 * into the single most recent observation. `null` on an API error payload, an
 * empty `data` array, or an unparseable height/timestamp — never a guess.
 */
export function parseWaterLevel(
  json: NoaaWaterLevelJson,
  requestedStationId: string,
): { heightFt: number; tIso: string; stationId: string; stationName?: string } | null {
  if (json.error || !Array.isArray(json.data) || json.data.length === 0) return null;
  // `date=latest` returns exactly one row; take the newest defensively anyway.
  const row = json.data[json.data.length - 1];
  if (!row || typeof row.t !== "string" || typeof row.v !== "string") return null;
  const heightFt = Number(row.v);
  if (!Number.isFinite(heightFt)) return null;
  // Strict shape check before parsing: V8's Date.parse is lenient enough to
  // turn junk like "not-a-date:00Z" into a real (year-2000) instant, which
  // would surface as a confidently-wrong "observed" reading.
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(row.t)) return null;
  const ms = Date.parse(`${row.t.replace(" ", "T")}:00Z`);
  if (!Number.isFinite(ms)) return null;
  return {
    heightFt: round(heightFt, 2),
    tIso: new Date(ms).toISOString(),
    stationId: json.metadata?.id ?? requestedStationId,
    stationName: json.metadata?.name,
  };
}

/**
 * Pair a live gauge observation with the SAME gauge's harmonic prediction for
 * that same instant, eased on the shared raised cosine (lib/tideLevel.ts) —
 * the identical curve the waterline graphic draws, so the residual can't
 * disagree with what the user sees.
 *
 * Both sides MUST come from the same station. Boca's displayed predictions are
 * for subordinate station 8722816 while the observation necessarily comes from
 * the Lake Worth Pier gauge 18 mi north; differencing across those two would
 * bake in a fixed datum/range offset and report it as "surge". So this takes
 * the gauge's own predictions as `gaugeEvents`.
 *
 * Honest-null when the observation is missing or the instant isn't bracketed
 * by two predicted events (see interpolateTideHeightFt — no extrapolation).
 */
export function buildObservedTide(
  gaugeEvents: TideWindowEvent[],
  obs: { heightFt: number; tIso: string; stationId: string; stationName?: string } | null,
): TideObserved | null {
  if (!obs) return null;
  const predictedFt = interpolateTideHeightFt(gaugeEvents, Date.parse(obs.tIso));
  if (predictedFt == null) return null;
  const observed: TideObserved = {
    heightFt: obs.heightFt,
    tIso: obs.tIso,
    stationId: obs.stationId,
    deltaFt: round(obs.heightFt - predictedFt, 2),
  };
  if (obs.stationName) observed.stationName = obs.stationName;
  return observed;
}

/** Half-width (days) of the gauge prediction window used for the residual —
 *  just enough to bracket "now" with room for a feed a few hours behind. */
const OBS_WINDOW_DAYS = 2;

/**
 * Fetch the gauge's latest observed water level AND its own hi/lo predictions,
 * then difference them. Fail-soft: any failure (gauge down, subordinate
 * station with no observations, malformed payload) resolves to `null` — the
 * tide card just doesn't show the chip.
 */
async function fetchObserved(stationId: string): Promise<TideObserved | null> {
  const begin = yyyymmdd(new Date(Date.now() - OBS_WINDOW_DAYS * 86_400_000));
  const end = yyyymmdd(new Date(Date.now() + OBS_WINDOW_DAYS * 86_400_000));
  const obsUrl =
    `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=water_level` +
    `&application=boca-beach-rats&date=latest&datum=MLLW&station=${stationId}` +
    `&units=english&time_zone=gmt&format=json`;
  // NOTE: requested in GMT, not lst_ldt. The predictions this is differenced
  // against are already fetched in GMT and parsed as absolute UTC; taking the
  // observation in local station time would mean re-deriving the station's
  // DST-aware offset by hand just to undo it, with a real chance of an
  // off-by-an-hour residual across a DST boundary. Same clock on both sides.
  const predUrl =
    `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions` +
    `&application=boca-beach-rats&begin_date=${begin}&end_date=${end}&datum=MLLW` +
    `&station=${stationId}&time_zone=gmt&units=english&interval=hilo&format=json`;

  const [obsRes, predRes] = await Promise.allSettled([
    // 6-minute gauge cadence — a 6-minute revalidate keeps the reading live
    // without hammering CO-OPS (the predictions beside it are astronomy and
    // hold for hours).
    fetchWithTimeout(obsUrl, { next: { revalidate: 360 } }),
    fetchWithTimeout(predUrl, { next: { revalidate: 21600 } }),
  ]);
  if (obsRes.status !== "fulfilled" || !obsRes.value.ok) return null;
  if (predRes.status !== "fulfilled" || !predRes.value.ok) return null;
  try {
    const obs = parseWaterLevel(
      (await obsRes.value.json()) as NoaaWaterLevelJson,
      stationId,
    );
    const gaugeEvents = toWindowEvents(
      (await predRes.value.json()) as { predictions?: NoaaPrediction[] },
    );
    return buildObservedTide(gaugeEvents, obs);
  } catch {
    return null;
  }
}

async function fetchOne(
  stationId: string,
  tz: string,
): Promise<{ data: TideData | null; at: string }> {
  // Widened from the old 72 h look-ahead to a ±3-week window so we can judge
  // today's highs/lows against what's normal at this station. Predictions are
  // deterministic astronomy, so the long (6 h) revalidate below is plenty.
  const begin = yyyymmdd(new Date(Date.now() - WINDOW_DAYS * 86_400_000));
  const end = yyyymmdd(new Date(Date.now() + WINDOW_DAYS * 86_400_000));
  const url =
    `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions` +
    `&application=boca-beach-rats&begin_date=${begin}&end_date=${end}&datum=MLLW` +
    `&station=${stationId}&time_zone=gmt&units=english&interval=hilo&format=json`;
  const res = await fetchWithTimeout(url, { next: { revalidate: 21600 } }); // 6h
  if (!res.ok) throw new Error(`NOAA tides ${stationId} -> ${res.status}`);
  return { data: deriveTideData(await res.json(), tz), at: fetchedAtOf(res) };
}

export async function fetchTides(loc: Location): Promise<Wrapped<TideData>> {
  const fetchedAt = nowIso();
  const ids = [loc.noaaTideStationId, loc.noaaTideStationFallbackId].filter(
    Boolean,
  ) as string[];
  // Kicked off alongside the prediction fetches (independent station, independent
  // failure mode). Beaches with no configured gauge simply never get a reading.
  const observedPromise: Promise<TideObserved | null> = loc.noaaWaterLevelStationId
    ? fetchObserved(loc.noaaWaterLevelStationId).catch(() => null)
    : Promise.resolve(null);

  for (const id of ids) {
    try {
      const { data, at } = await fetchOne(id, loc.timezone);
      if (data && data.next.length > 0) {
        const observed = await observedPromise;
        if (observed) data.observed = observed;
        return {
          source: `NOAA CO-OPS (${id})`,
          status: id === loc.noaaTideStationId ? "ok" : "stale",
          fetchedAt: at,
          attribution: ATTRIBUTION,
          data,
          note:
            id === loc.noaaTideStationId
              ? undefined
              : `primary station unavailable; using ${id}`,
        };
      }
    } catch {
      // try fallback
    }
  }
  return {
    source: `NOAA CO-OPS (${loc.noaaTideStationId})`,
    status: "error",
    fetchedAt,
    attribution: ATTRIBUTION,
    data: null,
    note: "no tide predictions available",
  };
}
