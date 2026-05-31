import type { Location, TideData, Wrapped } from "@/lib/types";
import { fetchWithTimeout, nowIso, round } from "@/lib/util";

const ATTRIBUTION = "NOAA Tides & Currents (tidesandcurrents.noaa.gov)";

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

async function fetchOne(stationId: string): Promise<TideData | null> {
  const begin = yyyymmdd(new Date(Date.now() - 6 * 3600_000)); // small lookback
  const url =
    `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions` +
    `&application=boca-beach-rats&begin_date=${begin}&range=72&datum=MLLW` +
    `&station=${stationId}&time_zone=gmt&units=english&interval=hilo&format=json`;
  const res = await fetchWithTimeout(url, { next: { revalidate: 21600 } }); // 6h
  if (!res.ok) throw new Error(`NOAA tides ${stationId} -> ${res.status}`);
  return parseNoaaPredictions(await res.json());
}

export async function fetchTides(loc: Location): Promise<Wrapped<TideData>> {
  const fetchedAt = nowIso();
  const ids = [loc.noaaTideStationId, loc.noaaTideStationFallbackId].filter(
    Boolean,
  ) as string[];
  for (const id of ids) {
    try {
      const data = await fetchOne(id);
      if (data && data.next.length > 0) {
        return {
          source: `NOAA CO-OPS (${id})`,
          status: id === loc.noaaTideStationId ? "ok" : "stale",
          fetchedAt,
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
