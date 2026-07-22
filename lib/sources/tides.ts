import type { Location, TideData, Wrapped } from "@/lib/types";
import { computeTideAberration, type TideWindowEvent } from "@/lib/tideAberration";
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
  for (const id of ids) {
    try {
      const { data, at } = await fetchOne(id, loc.timezone);
      if (data && data.next.length > 0) {
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
