/**
 * Where NOAA's hourly probabilistic rip current model (NWPS, Dusek & Seim
 * 2013) feed lives for a beach. Same conventions as lib/sources/camFeed.ts:
 * the preprocess job (scripts/rip_nwps.mjs, run by
 * .github/workflows/rip-nwps.yml) publishes ONE small rip_nwps.json to its
 * OWN `rip-data` branch — deliberately NOT `sargassum-data`, which
 * sargassum.yml/backfill-pct.yml force-push as a single-commit orphan every
 * ~10 min (anything else published there is silently deleted on their next
 * cycle; a prior version of this file lived there and was wiped repeatedly).
 * The app fetches the small published file instead of the ~2.5MB raw NOMADS
 * file per beach.
 *
 * A beach absent from config/nwpsRip.ts (no WFO covers it within 3km, or it
 * simply hasn't been mapped) always resolves to `null` here — no fetch is
 * even attempted — which every caller already treats as "model unavailable,
 * fall back to the SRF word" (see lib/ripRisk/resolve.ts's priority order).
 */
import { NWPS_RIP_COVERAGE } from "@/config/nwpsRip";
import { fetchedAtOf, fetchWithTimeout, nowIso, oldestIso } from "@/lib/util";
import { MODEL_STALE_MS, levelForModelProb } from "@/lib/ripRisk/resolve";
import type { RipModelHourInput } from "@/lib/ripRisk/timeline";
import type { OfficialModelNow } from "@/lib/ripRisk/types";

const FEED_BASE =
  process.env.RIP_NWPS_FEED_BASE ??
  "https://raw.githubusercontent.com/jayfrid-bot/bocabeach/rip-data";

export function ripNwpsFeedUrl(): string {
  return `${FEED_BASE}/rip_nwps.json`;
}

export interface RipNwpsBeachSeries {
  office: string;
  run: string; // ISO
  point: { lon: number; lat: number };
  hours: RipModelHourInput[];
}

interface RipNwpsFeed {
  generatedAt?: string;
  beaches?: Record<
    string,
    { office: string; run: string; point: { lon: number; lat: number }; hours: RipModelHourInput[] }
  >;
}

const ATTRIBUTION = "NOAA/NWS Nearshore Wave Prediction System rip current model";

/**
 * Defense-in-depth validation of ONE beach's published entry (item 7): the
 * preprocess job (scripts/rip_nwps.mjs) already rejects bad rows before
 * publishing, but this adapter treats the published JSON as untrusted input
 * too — a corrupted publish, a manually-edited file, or a future bug in the
 * job must never reach a caller as a plausible-looking but wrong reading.
 * Rejects the WHOLE entry if `run`/`point` don't parse; drops just the
 * individual hours whose `t` doesn't parse or whose `prob` is outside
 * [0, 100] (or a sentinel like -999/9999), same tolerance as the job itself.
 * Returns null when nothing usable is left.
 */
function sanitizeBeachEntry(entry: {
  office?: unknown;
  run?: unknown;
  point?: unknown;
  hours?: unknown;
}): RipNwpsBeachSeries | null {
  if (typeof entry.office !== "string" || !entry.office) return null;
  if (typeof entry.run !== "string" || !Number.isFinite(Date.parse(entry.run))) return null;
  const point = entry.point as { lon?: unknown; lat?: unknown } | undefined;
  const lon = typeof point?.lon === "number" ? point.lon : NaN;
  const lat = typeof point?.lat === "number" ? point.lat : NaN;
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return null;
  }
  const rawHours = Array.isArray(entry.hours) ? entry.hours : [];
  const hours: RipModelHourInput[] = [];
  for (const h of rawHours) {
    const row = h as { t?: unknown; prob?: unknown; hsFt?: unknown; periodS?: unknown; dirDeg?: unknown };
    if (typeof row?.t !== "string" || !Number.isFinite(Date.parse(row.t))) continue;
    if (typeof row?.prob !== "number" || !Number.isFinite(row.prob) || row.prob < 0 || row.prob > 100) continue;
    hours.push({
      t: row.t,
      prob: row.prob,
      hsFt: typeof row.hsFt === "number" && Number.isFinite(row.hsFt) ? row.hsFt : undefined,
      periodS: typeof row.periodS === "number" && Number.isFinite(row.periodS) ? row.periodS : undefined,
      dirDeg: typeof row.dirDeg === "number" && Number.isFinite(row.dirDeg) ? row.dirDeg : undefined,
    });
  }
  if (!hours.length) return null;
  return { office: entry.office, run: entry.run, point: { lon, lat }, hours };
}

export interface RipNwpsResult {
  source: string;
  attribution: string;
  fetchedAt: string;
  status: "ok" | "best-effort";
  data: RipNwpsBeachSeries | null;
  note?: string;
}

let cachedFeed: { fetchedAt: string; feed: RipNwpsFeed } | null = null;
let cachedAtMs = 0;
const PROCESS_CACHE_MS = 60_000; // avoid re-fetching the same small feed for every beach in one request burst
// In-flight promise, shared by every concurrent caller within the cache
// window: a cold build (e.g. the history-archive job looping every beach, or
// getSnapshotForLocation's own Promise.all firing many sources at once)
// calls fetchRipNwps for many beaches essentially simultaneously, BEFORE the
// first fetch has resolved and populated `cachedFeed` — without this, each
// of those concurrent calls would kick off its own redundant fetch of the
// SAME small file. One in-flight fetch, shared by all of them.
let inFlight: Promise<{ fetchedAt: string; feed: RipNwpsFeed } | null> | null = null;

async function loadFeed(): Promise<{ fetchedAt: string; feed: RipNwpsFeed } | null> {
  const now = Date.now();
  if (cachedFeed && now - cachedAtMs < PROCESS_CACHE_MS) return cachedFeed;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await fetchWithTimeout(ripNwpsFeedUrl(), {
        timeoutMs: 7000,
        next: { revalidate: 1800 }, // job runs every 3h; 30 min is plenty fresh
      });
      if (!res.ok) return null;
      const feed = (await res.json()) as RipNwpsFeed;
      const fetchedAt = oldestIso(feed.generatedAt, fetchedAtOf(res));
      cachedFeed = { fetchedAt, feed };
      cachedAtMs = Date.now();
      return cachedFeed;
    } catch {
      return null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * The beach's NOAA rip model series, or `null` when the beach has no mapped
 * coverage, the feed hasn't published it yet, or the model's run is stale
 * (> 36h old — MODEL_STALE_MS, same gate resolve.ts's isModelFresh applies
 * per-hour) — a stale model is treated as unavailable rather than shown with
 * false confidence.
 */
export async function fetchRipNwps(slug: string): Promise<RipNwpsResult> {
  const fetchedAt = nowIso();
  if (!NWPS_RIP_COVERAGE[slug]) {
    return {
      source: ATTRIBUTION,
      attribution: ATTRIBUTION,
      fetchedAt,
      status: "best-effort",
      data: null,
      note: "no NOAA rip model coverage for this beach",
    };
  }
  const loaded = await loadFeed();
  if (!loaded) {
    return {
      source: ATTRIBUTION,
      attribution: ATTRIBUTION,
      fetchedAt,
      status: "best-effort",
      data: null,
      note: "rip model feed unavailable",
    };
  }
  const rawEntry = loaded.feed.beaches?.[slug];
  if (!rawEntry) {
    return {
      source: ATTRIBUTION,
      attribution: ATTRIBUTION,
      fetchedAt: loaded.fetchedAt,
      status: "best-effort",
      data: null,
      note: "no rip model data published yet for this beach",
    };
  }
  const entry = sanitizeBeachEntry(rawEntry);
  if (!entry) {
    return {
      source: ATTRIBUTION,
      attribution: ATTRIBUTION,
      fetchedAt: loaded.fetchedAt,
      status: "best-effort",
      data: null,
      note: "rip model data for this beach failed validation (bad run/point/probabilities)",
    };
  }
  const runMs = Date.parse(entry.run);
  const staleMs = Date.now() - runMs;
  if (staleMs > MODEL_STALE_MS) {
    return {
      source: ATTRIBUTION,
      attribution: ATTRIBUTION,
      fetchedAt: loaded.fetchedAt,
      status: "best-effort",
      data: null,
      note: `rip model run stale (${entry.run})`,
    };
  }
  return {
    source: ATTRIBUTION,
    attribution: ATTRIBUTION,
    fetchedAt: loaded.fetchedAt,
    status: "ok",
    data: entry,
  };
}

/** The series's value for the clock hour containing `tMs` — the row whose
 *  ISO hour matches (no interpolation; "use the row's hour and the next" per
 *  spec). Null when there's no row for that hour. */
export function modelNowFromSeries(series: RipNwpsBeachSeries | null, tMs: number): OfficialModelNow | null {
  if (!series) return null;
  const hourMs = Math.floor(tMs / 3_600_000) * 3_600_000;
  const row = series.hours.find((h) => Date.parse(h.t) === hourMs);
  if (!row || !Number.isFinite(row.prob)) return null;
  return { prob: row.prob, level: levelForModelProb(row.prob), run: series.run };
}

/** The first FUTURE model hour (strictly after `nowMs`) whose probability
 *  bands to High, or null when none exists in the series. Powers the "rising
 *  to High by <time>" watch message (RipRiskCard/SafetyBanner) — only shown
 *  when the model itself actually says so; otherwise callers fall back to
 *  naming the model-vs-SRF disagreement plainly instead of inventing a time. */
export function firstFutureHighHour(
  series: RipNwpsBeachSeries | null,
  nowMs: number,
): { t: string; prob: number } | null {
  if (!series) return null;
  const hourMs = Math.floor(nowMs / 3_600_000) * 3_600_000;
  for (const h of series.hours) {
    const t = Date.parse(h.t);
    if (!Number.isFinite(t) || t <= hourMs) continue;
    if (levelForModelProb(h.prob) === "high") return { t: h.t, prob: h.prob };
  }
  return null;
}
