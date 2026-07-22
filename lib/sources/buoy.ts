import type { BuoyData, Location, Wrapped } from "@/lib/types";
import {
  cToF,
  fetchWithTimeout,
  fetchedAtOf,
  msToMph,
  mToFt,
  nowIso,
  oldestIso,
  round,
} from "@/lib/util";

const ATTRIBUTION = "NOAA National Data Buoy Center (ndbc.noaa.gov)";
const MISSING = "MM";
// Beyond this, the latest buoy row is too old to call a live "ok" reading.
const STALE_AFTER_MS = 120 * 60_000;

/**
 * Build a UTC ISO timestamp from NDBC integer date components, or `undefined`
 * when any component is out of its calendar range. `Date.UTC` SILENTLY
 * NORMALIZES overflow (month 13 → next January, hour 25 → next day 01:00, day
 * 31 in a 30-day month → the 1st) and still yields a finite millisecond value,
 * so a plain `Number.isFinite(ms)` check can't reject a garbled row. We
 * range-check each component AND round-trip the constructed date (getUTCMonth()
 * + 1 === mm, etc.) so a normalized value is caught and dropped.
 */
export function utcIsoFromNdbc(
  yy: number,
  mm: number,
  dd: number,
  hh: number,
  mn: number,
): string | undefined {
  if (![yy, mm, dd, hh, mn].every((v) => Number.isInteger(v))) return undefined;
  if (yy < 1970 || yy > 2100) return undefined;
  if (mm < 1 || mm > 12) return undefined;
  if (dd < 1 || dd > 31) return undefined;
  if (hh < 0 || hh > 23) return undefined;
  if (mn < 0 || mn > 59) return undefined;
  const d = new Date(Date.UTC(yy, mm - 1, dd, hh, mn));
  if (
    d.getUTCFullYear() !== yy ||
    d.getUTCMonth() + 1 !== mm ||
    d.getUTCDate() !== dd ||
    d.getUTCHours() !== hh ||
    d.getUTCMinutes() !== mn
  ) {
    return undefined;
  }
  return d.toISOString();
}

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
    const iso = utcIsoFromNdbc(yy as number, mm as number, dd as number, hh as number, mn as number);
    if (iso) out.observedAt = iso;
  }
  return out;
}

/** How far back the water-temp history reaches — the water-trend model only
 *  looks back ~7.5 days (lib/waterTrend.ts), so anything older is dead weight. */
const HISTORY_MAX_DAYS = 7.5;

/**
 * Parse EVERY data row's water temperature into a trailing history (newest
 * first) for the water-"feel"-trend read (lib/waterTrend.ts). NDBC realtime2
 * runs a dense ~10-min cadence, which would bloat the snapshot, so this thins
 * to at most one point per clock-hour (the newest per hour) and drops anything
 * older than HISTORY_MAX_DAYS. Returns undefined when no row carried both a
 * parseable timestamp and a valid WTMP (so the caller honest-nulls rather than
 * attaching an empty array). Pure given `nowMs`.
 */
export function parseNdbcWaterHistory(
  text: string,
  nowMs: number = Date.now(),
): { t: string; waterTempF: number }[] | undefined {
  const rows = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (rows.length === 0) return undefined;

  const cutoffMs = nowMs - HISTORY_MAX_DAYS * 86_400_000;
  const seenHours = new Set<string>();
  const out: { t: string; waterTempF: number }[] = [];
  for (const row of rows) {
    const c = row.split(/\s+/);
    if (c.length < 15) continue;
    const parseNum = (i: number): number | undefined => {
      const v = c[i];
      if (v === undefined || v === MISSING) return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const [yy, mm, dd, hh, mn] = [parseNum(0), parseNum(1), parseNum(2), parseNum(3), parseNum(4)];
    const wtmpC = parseNum(14);
    if ([yy, mm, dd, hh, mn].some((v) => v === undefined) || wtmpC === undefined) continue;
    // Reject garbled date components (month 13, hour 25, day 32, ...) BEFORE
    // trusting the timestamp — Date.UTC would silently normalize them into a
    // finite, wrong-but-plausible instant that could sneak past the window
    // check below. See utcIsoFromNdbc.
    const iso = utcIsoFromNdbc(yy as number, mm as number, dd as number, hh as number, mn as number);
    if (!iso) continue;
    const ms = Date.parse(iso);
    if (ms < cutoffMs || ms > nowMs) continue;
    // Thin to one row per UTC clock-hour — rows arrive newest-first, so the
    // first one seen for an hour is that hour's freshest observation.
    const hourKey = `${yy}-${mm}-${dd}-${hh}`;
    if (seenHours.has(hourKey)) continue;
    seenHours.add(hourKey);
    out.push({ t: iso, waterTempF: round(cToF(wtmpC)) });
  }
  return out.length ? out : undefined;
}

async function fetchOne(
  id: string,
): Promise<{ data: BuoyData | null; at: string }> {
  const res = await fetchWithTimeout(
    `https://www.ndbc.noaa.gov/data/realtime2/${id}.txt`,
    { next: { revalidate: 600 } },
  );
  if (!res.ok) throw new Error(`NDBC ${id} -> ${res.status}`);
  const text = await res.text();
  const data = parseNdbcRealtime(text);
  // Attach the trailing water-temp history (for the water-"feel"-trend read)
  // onto the same latest-row data object; absent when no row carried a WTMP.
  if (data) {
    const history = parseNdbcWaterHistory(text);
    if (history) data.waterTempHistory = history;
  }
  return { data, at: fetchedAtOf(res) };
}

export async function fetchBuoy(loc: Location): Promise<Wrapped<BuoyData>> {
  const fetchedAt = nowIso();
  const ids = [loc.ndbcBuoyId, loc.ndbcBuoyFallbackId].filter(Boolean) as string[];
  for (const id of ids) {
    try {
      const { data, at } = await fetchOne(id);
      // Station eligibility is about whether the CURRENT row carries usable
      // observations (wind/waves/water temp) — those are what feed
      // deriveMetrics + scoring. `waterTempHistory` is a trailing series for
      // the purely-informational water-trend read; it must NOT count toward
      // usability, or a dead primary station whose latest row is empty-but-for
      // a timestamp would wrongly pass this gate (its old WTMP history inflates
      // the key count) and block fallback to a live station — silently changing
      // the score. Count only current-row fields (observedAt + real metrics).
      const currentRowFieldCount = data
        ? Object.keys(data).filter((k) => k !== "waterTempHistory").length
        : 0;
      if (data && currentRowFieldCount > 1) {
        const isFallback = id !== loc.ndbcBuoyId;
        // Downgrade a fresh-looking HTTP response when the observation itself is
        // old: NDBC keeps serving the last row even when a buoy stops reporting.
        const obsMs = data.observedAt ? new Date(data.observedAt).getTime() : NaN;
        const aged = Number.isFinite(obsMs) && Date.now() - obsMs > STALE_AFTER_MS;
        return {
          source: `NOAA NDBC (${id})`,
          status: isFallback || aged ? "stale" : "ok",
          fetchedAt: aged ? oldestIso(data.observedAt, at) : at,
          attribution: ATTRIBUTION,
          data,
          note: isFallback
            ? `primary buoy unavailable; using ${id}`
            : aged
              ? "buoy observation is stale"
              : undefined,
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
