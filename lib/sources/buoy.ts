import type { BuoyData, Location, Wrapped } from "@/lib/types";
import { cToF, fetchWithTimeout, msToMph, mToFt, nowIso, round } from "@/lib/util";

const ATTRIBUTION = "NOAA National Data Buoy Center (ndbc.noaa.gov)";
const MISSING = "MM";

/**
 * Parse an NDBC realtime2 (.txt) feed. Columns are fixed-position; the first
 * data row is the most recent observation. "MM" means missing.
 *
 * Header reference:
 * #YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES ATMP WTMP DEWP VIS PTDY TIDE
 *  0  1  2  3  4   5    6    7    8   9  10  11  12   13   14   15  16   17   18
 */
export function parseNdbcRealtime(text: string): BuoyData | null {
  const rows = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (rows.length === 0) return null;

  const c = rows[0].split(/\s+/);
  if (c.length < 15) return null;

  const num = (i: number): number | undefined => {
    const v = c[i];
    if (v === undefined || v === MISSING) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  const out: BuoyData = {};
  const windDir = num(5);
  const windMs = num(6);
  const gustMs = num(7);
  const waveM = num(8);
  const dpd = num(9);
  const atmpC = num(13);
  const wtmpC = num(14);

  if (windDir !== undefined) out.windDirDeg = windDir;
  if (windMs !== undefined) out.windSpeedMph = round(msToMph(windMs));
  if (gustMs !== undefined) out.windGustMph = round(msToMph(gustMs));
  if (waveM !== undefined) out.waveHeightFt = round(mToFt(waveM), 1);
  if (dpd !== undefined) out.dominantPeriodS = dpd;
  if (atmpC !== undefined) out.airTempF = round(cToF(atmpC));
  if (wtmpC !== undefined) out.waterTempF = round(cToF(wtmpC));

  const [yy, mm, dd, hh, mn] = [num(0), num(1), num(2), num(3), num(4)];
  if ([yy, mm, dd, hh, mn].every((v) => v !== undefined)) {
    out.observedAt = new Date(
      Date.UTC(yy as number, (mm as number) - 1, dd, hh, mn),
    ).toISOString();
  }
  return out;
}

async function fetchOne(id: string): Promise<BuoyData | null> {
  const res = await fetchWithTimeout(
    `https://www.ndbc.noaa.gov/data/realtime2/${id}.txt`,
    { next: { revalidate: 600 } },
  );
  if (!res.ok) throw new Error(`NDBC ${id} -> ${res.status}`);
  return parseNdbcRealtime(await res.text());
}

export async function fetchBuoy(loc: Location): Promise<Wrapped<BuoyData>> {
  const fetchedAt = nowIso();
  const ids = [loc.ndbcBuoyId, loc.ndbcBuoyFallbackId].filter(Boolean) as string[];
  for (const id of ids) {
    try {
      const data = await fetchOne(id);
      if (data && Object.keys(data).length > 1) {
        return {
          source: `NOAA NDBC (${id})`,
          status: id === loc.ndbcBuoyId ? "ok" : "stale",
          fetchedAt,
          attribution: ATTRIBUTION,
          data,
          note: id === loc.ndbcBuoyId ? undefined : `primary buoy unavailable; using ${id}`,
        };
      }
    } catch {
      // try the next station
    }
  }
  return {
    source: `NOAA NDBC (${loc.ndbcBuoyId})`,
    status: "error",
    fetchedAt,
    attribution: ATTRIBUTION,
    data: null,
    note: "no buoy data available",
  };
}
