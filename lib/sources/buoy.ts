import type { BuoyData, BuoyFieldKey, Location, Wrapped } from "@/lib/types";
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

/** The metric fields that get merged station-by-station (everything except the
 *  timestamp, the trailing history, and the provenance map itself). */
export const MERGED_FIELDS: BuoyFieldKey[] = [
  "waterTempF",
  "airTempF",
  "windDirDeg",
  "windSpeedMph",
  "windGustMph",
  "waveHeightFt",
  "dominantPeriodS",
];

/**
 * Station eligibility: does the CURRENT row carry usable observations
 * (wind/waves/water temp)? Those are what feed deriveMetrics + scoring.
 * `waterTempHistory` is a trailing series for the purely-informational
 * water-trend read; it must NOT count toward usability, or a dead station
 * whose latest row is empty-but-for-a-timestamp would wrongly pass (its old
 * WTMP history inflates the key count) and shoulder out a live station.
 */
function isUsableRow(data: BuoyData | null): boolean {
  if (!data) return false;
  return MERGED_FIELDS.some((k) => data[k] !== undefined);
}

interface StationRead {
  id: string;
  data: BuoyData;
  at: string;
}

/**
 * Merge two stations FIELD BY FIELD, primary winning each field it actually
 * reported.
 *
 * WHY, concretely (45-day audit of Boca's pair, 2026-07): the primary LKWF1 is
 * a C-MAN mast on the Lake Worth Pier. It has no wave sensor at all — WVHT/DPD
 * are "MM" on 100% of ticks, structurally, forever — and it drops WTMP on
 * ~21-24% of ticks. The old all-or-nothing station gate asked only "does this
 * row have more than one field?", so a wind-only LKWF1 row won the whole
 * station and we silently threw away FWYF1's water temperature, which is the
 * value that actually feeds the 9%-weighted waterTemp sub-score. Preferring a
 * nearer station PER FIELD keeps the locality advantage where it exists
 * without letting it veto data it never had.
 *
 * Pure (no clock, no fetch) so the merge rules are directly testable.
 */
export function mergeBuoyStations(primary: StationRead | null, fallback: StationRead | null): {
  data: BuoyData;
  /** Station ids that supplied at least one merged field, primary first. */
  contributors: string[];
  /** Fields the fallback had to cover because the primary didn't report them. */
  filledByFallback: BuoyFieldKey[];
} | null {
  if (!primary && !fallback) return null;

  const data: BuoyData = {};
  const sources: Partial<Record<BuoyFieldKey, string | null>> = {};
  const filledByFallback: BuoyFieldKey[] = [];
  let primaryUsed = false;
  let fallbackUsed = false;

  for (const key of MERGED_FIELDS) {
    const fromPrimary = primary?.data[key];
    const fromFallback = fallback?.data[key];
    if (fromPrimary !== undefined) {
      data[key] = fromPrimary;
      sources[key] = primary!.id;
      primaryUsed = true;
    } else if (fromFallback !== undefined) {
      data[key] = fromFallback;
      sources[key] = fallback!.id;
      fallbackUsed = true;
      filledByFallback.push(key);
    } else {
      // Explicit null, not an omitted key: "neither station reported this" is
      // itself the honest answer the nerd cards need to render.
      sources[key] = null;
    }
  }

  if (!primaryUsed && !fallbackUsed) return null;

  // The timestamp belongs to whichever station led the merge — a merged row is
  // genuinely two observations, so we report the leading station's tick and
  // let the per-field `sources` map carry the nuance.
  const observedAt = (primaryUsed ? primary?.data.observedAt : undefined) ?? fallback?.data.observedAt;
  if (observedAt) data.observedAt = observedAt;

  // Water-temp history: prefer the primary's when it has one (it's the nearer
  // water, and the trend read wants a single consistent series — splicing two
  // stations' temperatures into one trend line would manufacture jumps).
  const history = primary?.data.waterTempHistory?.length
    ? primary.data.waterTempHistory
    : fallback?.data.waterTempHistory;
  if (history?.length) data.waterTempHistory = history;

  data.sources = sources;

  const contributors: string[] = [];
  if (primaryUsed && primary) contributors.push(primary.id);
  if (fallbackUsed && fallback) contributors.push(fallback.id);
  return { data, contributors, filledByFallback };
}

export async function fetchBuoy(loc: Location): Promise<Wrapped<BuoyData>> {
  const fetchedAt = nowIso();
  const primaryId = loc.ndbcBuoyId;
  const fallbackId = loc.ndbcBuoyFallbackId;

  // Both stations are fetched every time now (they always were, sequentially,
  // whenever the primary looked unusable) — but concurrently, and the fallback
  // is consulted per FIELD rather than only when the primary is wholly dead.
  const [primaryRes, fallbackRes] = await Promise.allSettled([
    primaryId ? fetchOne(primaryId) : Promise.reject(new Error("no primary buoy")),
    fallbackId ? fetchOne(fallbackId) : Promise.reject(new Error("no fallback buoy")),
  ]);

  const toRead = (
    id: string | undefined,
    res: PromiseSettledResult<{ data: BuoyData | null; at: string }>,
  ): StationRead | null => {
    if (!id || res.status !== "fulfilled" || !isUsableRow(res.value.data)) return null;
    return { id, data: res.value.data as BuoyData, at: res.value.at };
  };

  const primary = toRead(primaryId, primaryRes);
  const fallback = toRead(fallbackId, fallbackRes);
  const merged = mergeBuoyStations(primary, fallback);

  if (merged) {
    const { data, contributors, filledByFallback } = merged;
    const usedPrimary = !!primaryId && contributors.includes(primaryId);
    const usedFallback = !!fallbackId && contributors.includes(fallbackId);
    // Report the OLDEST contributing fetch — a merged reading is only as fresh
    // as its stalest half.
    const at = oldestIso(
      usedPrimary ? primary?.at : undefined,
      usedFallback ? fallback?.at : undefined,
    );
    // Downgrade a fresh-looking HTTP response when the observation itself is
    // old: NDBC keeps serving the last row even when a buoy stops reporting.
    const obsMs = data.observedAt ? new Date(data.observedAt).getTime() : NaN;
    const aged = Number.isFinite(obsMs) && Date.now() - obsMs > STALE_AFTER_MS;
    // "stale" is reserved for the cases it always meant: the primary is dead
    // (we're reading a substitute station) or the observation itself is old.
    // A live primary that merely lacks a sensor the fallback has is NOT stale —
    // it's the normal, healthy case for a C-MAN mast with no wave gear.
    const status = !usedPrimary || aged ? "stale" : "ok";
    const note = !usedPrimary
      ? `primary buoy unavailable; using ${contributors.join(", ")}`
      : aged
        ? "buoy observation is stale"
        : filledByFallback.length
          ? `${filledByFallback.join(", ")} from ${fallbackId} (${primaryId} doesn't report ${filledByFallback.length > 1 ? "them" : "it"})`
          : undefined;
    return {
      source: `NOAA NDBC (${contributors.join(" + ")})`,
      status,
      fetchedAt: aged ? oldestIso(data.observedAt, at) : at,
      attribution: ATTRIBUTION,
      data,
      note,
    };
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
