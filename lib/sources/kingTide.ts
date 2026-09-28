/**
 * Where the "king tide" / high-tide-flooding sky event
 * (docs/SKY_EVENTS_PLAN.md §3) feed lives for a beach. Same conventions as
 * lib/sources/ripNwps.ts: the preprocess job (scripts/king_tide.mjs, run by
 * .github/workflows/king-tide.yml) publishes ONE small king_tide_data.json
 * to its OWN `king-tide-data` branch — deliberately NOT `sargassum-data`,
 * which sargassum.yml/backfill-pct.yml force-push as a single-commit orphan
 * every ~10 min (anything else published there is silently deleted on their
 * next cycle). The app fetches the small published file instead of running
 * a full station-local-calendar-year NOAA prediction fetch per request.
 *
 * The feed is keyed by NOAA station, not by beach — several beaches can
 * share one station (e.g. crescent-bay-park & santa-monica both read
 * 9410840). config/tideStations.ts is this adapter's own map from beach
 * slug -> which station to look up (and is the source of the `stationId`
 * this file uses to index into the fetched feed); the feed's own
 * `representative` flag per station is what the classification (§3's tiers)
 * was actually computed against, and is carried straight through here
 * rather than re-derived — see lib/skyEventsTypes.ts's KingTideStationFeed
 * doc comment.
 *
 * FRESHNESS (§3, §8, §9 of the plan; lib/skyEventsTypes.ts's SkyEventSource
 * doc comment): this adapter enforces the CARD-level gates PER STATION, not
 * off the feed's top-level `generatedAt` (review item 4) — a carried-forward
 * station (scripts/king_tide.mjs, on that station's own fetch failure) keeps
 * its ORIGINAL `generatedAt` even while the rest of the feed republishes
 * with a fresh one, so a station that's actually been stale for weeks must
 * never borrow the freshness of stations that just re-fetched successfully
 * beside it. Gates:
 *   - THIS STATION's own `generatedAt` must be <=30 days old, else nothing
 *     from it is card-eligible at all;
 *   - each event only shows while `now < validThrough` (the station's own
 *     2-year prediction coverage horizon);
 *   - a fully-past episode (`episode.end < now`) is dropped — the card only
 *     ever wants "coming up", not history.
 * The STRICTER alert-only gate (§3: "a validated flood-threshold crossing
 * is only alert-eligible... when sourced from a feed <=14 days old") is
 * deliberately NOT enforced here — every returned `TideSkyEvent` carries its
 * own `source.feedGeneratedAt`, populated from this SAME per-station
 * timestamp, so whichever later stage builds the Plus alert (`AlertSubject`,
 * docs/SKY_EVENTS_PLAN.md §10, Phase 3/Crew G) can apply that tighter
 * 14-day check itself against the same accurate, per-station timestamp.
 * This keeps a "data" adapter free of alert-specific policy, which belongs
 * with the alert code, not here.
 *
 * DATUM MATCHING (review item 3): scripts/king_tide.mjs already refuses to
 * fetch/apply a flood threshold unless this run's actual prediction datum
 * matches the station's hand-verified `thresholdDatum` (config/tideStations.ts),
 * so a temporary STND->MLLW fallback can never get compared against an
 * STND-scale threshold. `sanitizeStationEntry` below re-checks that same
 * invariant on the untrusted published JSON as defense in depth: a station
 * entry whose `datum` isn't "STND" but still carries a threshold value or a
 * "validated" tier is rejected outright (never silently "fixed").
 */
import type { Location, Wrapped } from "@/lib/types";
import type { KingTideFeedPayload, KingTideHigh, KingTideStationFeed, TideSkyEvent } from "@/lib/skyEventsTypes";
import { TIDE_STATIONS } from "@/config/tideStations";
import { fetchedAtOf, fetchWithTimeout, nowIso, oldestIso } from "@/lib/util";

const ATTRIBUTION = "NOAA Tides & Currents (tidesandcurrents.noaa.gov)";

/**
 * The wire shape scripts/king_tide.mjs actually publishes per station:
 * everything in the frozen `KingTideStationFeed` (lib/skyEventsTypes.ts,
 * Phase 0 contract — not edited by this crew) PLUS an ADDITIVE per-station
 * `generatedAt` (review item 4). Extra fields beyond a documented shape are
 * harmless to any other reader that only knows the frozen ones; this local
 * extension is the only thing in this file that needs to see it.
 */
interface StationEntry extends KingTideStationFeed {
  /** When THIS station's data was last actually (re-)fetched — carried
   *  forward verbatim, never bumped, when the station itself is carried
   *  forward on a failed fetch. Distinct from the feed's top-level
   *  `generatedAt`, which only says the JOB ran, not that every station in
   *  it is fresh. */
  generatedAt: string;
}

const FEED_BASE =
  process.env.KING_TIDE_FEED_BASE ??
  "https://raw.githubusercontent.com/jayfrid-bot/bocabeach/king-tide-data";

export function kingTideFeedUrl(): string {
  return `${FEED_BASE}/king_tide_data.json`;
}

/** Card data is shown from a feed up to this old (§3); beyond it the whole
 *  station's data is treated as unavailable rather than possibly-stale. */
export const CARD_STALE_MS = 30 * 24 * 3_600_000;

/** A station's own `generatedAt` more than this far in the FUTURE relative
 *  to `nowMs` is implausible (clock skew or a corrupted/hand-edited publish)
 *  — rejected the same as a too-stale one, never treated as "extra fresh"
 *  (Codex review round 2; mirrors lib/alerts/comingUp.ts's matching
 *  `TIDE_ALERT_MAX_FUTURE_SKEW_MS` gate on the same timestamp for alerts). */
export const CARD_FUTURE_SKEW_MS = 10 * 60_000;

const TIER_VALUES = new Set<KingTideHigh["tier"]>(["validated", "very-high"]);
/** Defense-in-depth cap on episodes per station — the script computes at
 *  most a handful per 2-year window (top 1% of ~700-1,500 highs/year, then
 *  merged), so anything past this is a corrupted or hand-edited publish,
 *  never a legitimately large result (§9's "a size limit"). */
const MAX_HIGHS_PER_STATION = 200;

/**
 * Defense-in-depth validation of ONE station's published entry (§9): the
 * preprocess job already only ever writes well-formed rows, but this
 * adapter treats the published JSON as untrusted input too — a corrupted
 * publish, a manually-edited file, or a future bug in the job must never
 * reach a caller as a plausible-looking but wrong reading. Drops just the
 * individual highs that don't parse; rejects the WHOLE station entry if its
 * own required fields don't parse, INCLUDING the datum/threshold
 * consistency check below (review item 3). Returns null when nothing usable
 * is left.
 */
function sanitizeStationEntry(entry: unknown): StationEntry | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  if (typeof e.stationId !== "string" || !e.stationId) return null;
  if (typeof e.datum !== "string" || !e.datum) return null;
  if (typeof e.representative !== "boolean") return null;
  if (typeof e.validThrough !== "string" || !Number.isFinite(Date.parse(e.validThrough))) return null;
  // Per-station generatedAt (review item 4) — required, not defaulted: a
  // publish that lacks it can't be trusted for per-station freshness, so
  // the whole entry is rejected rather than silently borrowing some other
  // timestamp.
  if (typeof e.generatedAt !== "string" || !Number.isFinite(Date.parse(e.generatedAt))) return null;

  const nwsMinorFt = typeof e.nwsMinorFt === "number" && Number.isFinite(e.nwsMinorFt) ? e.nwsMinorFt : null;
  const nosMinorFt = typeof e.nosMinorFt === "number" && Number.isFinite(e.nosMinorFt) ? e.nosMinorFt : null;

  const percentileByYear: Record<string, number> = {};
  if (e.percentileByYear && typeof e.percentileByYear === "object") {
    for (const [year, value] of Object.entries(e.percentileByYear as Record<string, unknown>)) {
      if (/^\d{4}$/.test(year) && typeof value === "number" && Number.isFinite(value)) {
        percentileByYear[year] = value;
      }
    }
  }

  const rawHighs = Array.isArray(e.highs) ? e.highs.slice(0, MAX_HIGHS_PER_STATION) : [];
  const highs: KingTideHigh[] = [];
  for (const h of rawHighs) {
    const row = h as { episode?: { start?: unknown; end?: unknown }; heightFt?: unknown; tier?: unknown };
    const start = row.episode?.start;
    const end = row.episode?.end;
    if (typeof start !== "string" || !Number.isFinite(Date.parse(start))) continue;
    if (typeof end !== "string" || !Number.isFinite(Date.parse(end))) continue;
    if (Date.parse(end) < Date.parse(start)) continue; // an episode never ends before it starts
    if (typeof row.heightFt !== "number" || !Number.isFinite(row.heightFt)) continue;
    if (typeof row.tier !== "string" || !TIER_VALUES.has(row.tier as KingTideHigh["tier"])) continue;
    highs.push({ episode: { start, end }, heightFt: row.heightFt, tier: row.tier as KingTideHigh["tier"] });
  }

  // Datum-matching re-validation (review item 3): scripts/king_tide.mjs only
  // ever fetches/applies a threshold when this run's prediction datum
  // matched the station's hand-verified `thresholdDatum` ("STND" for every
  // station config/tideStations.ts marks representative). A station entry
  // that claims a non-STND datum yet still carries a threshold value or a
  // "validated" episode is internally inconsistent — evidence of a
  // corrupted or hand-edited publish, not something to silently "fix" by
  // dropping just the offending field. Reject the WHOLE entry: it falls
  // back to "no king-tide data published yet for this beach's station"
  // (fetchKingTide), the same honest-unavailable path as a missing station.
  const hasThresholdEvidence =
    nwsMinorFt != null || nosMinorFt != null || highs.some((h) => h.tier === "validated");
  if (e.datum !== "STND" && hasThresholdEvidence) return null;

  return {
    stationId: e.stationId,
    datum: e.datum,
    representative: e.representative,
    nwsMinorFt,
    nosMinorFt,
    percentileByYear,
    highs,
    validThrough: e.validThrough,
    generatedAt: e.generatedAt,
  };
}

/** `schemaVersion`/shape check before anything else (§9) — an unrecognized
 *  or malformed payload is treated as "feed unavailable", never guessed at. */
function sanitizeFeed(json: unknown): { generatedAt: string; stations: StationEntry[] } | null {
  if (!json || typeof json !== "object") return null;
  const j = json as Partial<KingTideFeedPayload>;
  if (j.schemaVersion !== 1) return null;
  if (typeof j.generatedAt !== "string" || !Number.isFinite(Date.parse(j.generatedAt))) return null;
  if (!Array.isArray(j.stations)) return null;
  const stations = j.stations.map(sanitizeStationEntry).filter((s): s is StationEntry => s != null);
  return { generatedAt: j.generatedAt, stations };
}

let cachedFeed: { fetchedAt: string; feed: { generatedAt: string; stations: StationEntry[] } } | null = null;
let cachedAtMs = 0;
const PROCESS_CACHE_MS = 60_000; // avoid re-fetching the same small feed for every beach in one request burst
// Shared in-flight promise — same rationale as lib/sources/ripNwps.ts: a cold
// build fetching many beaches essentially simultaneously must not kick off
// one redundant fetch of this small file per beach.
let inFlight: Promise<{ fetchedAt: string; feed: { generatedAt: string; stations: StationEntry[] } } | null> | null =
  null;

async function loadFeed(): Promise<{ fetchedAt: string; feed: { generatedAt: string; stations: StationEntry[] } } | null> {
  const now = Date.now();
  if (cachedFeed && now - cachedAtMs < PROCESS_CACHE_MS) return cachedFeed;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await fetchWithTimeout(kingTideFeedUrl(), {
        timeoutMs: 7000,
        // The job runs at most a couple of times a week (deterministic
        // astronomy, not a live model — scripts/king_tide.mjs's header) —
        // an hour's revalidate is plenty fresh and keeps this cheap.
        next: { revalidate: 3600 },
      });
      if (!res.ok) return null;
      const sanitized = sanitizeFeed(await res.json());
      if (!sanitized) return null;
      const fetchedAt = oldestIso(sanitized.generatedAt, fetchedAtOf(res));
      cachedFeed = { fetchedAt, feed: sanitized };
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

/** One station entry -> this beach's `TideSkyEvent[]`, applying the card-level
 *  freshness gates (§3): THIS STATION's own `generatedAt` (not the feed's
 *  top-level one, review item 4) must be <=30 days old, each event only
 *  while `now < validThrough`, and a fully-past episode is dropped. */
function toTideEvents(station: StationEntry, nowMs: number): TideSkyEvent[] {
  if (nowMs >= Date.parse(station.validThrough)) return [];
  const events: TideSkyEvent[] = [];
  for (const high of station.highs) {
    if (Date.parse(high.episode.end) < nowMs) continue; // fully in the past — "coming up" only
    events.push({
      eventType: "tide",
      tier: high.tier,
      stationId: station.stationId,
      datum: station.datum,
      episode: high.episode,
      heightFt: high.heightFt,
      rating: null,
      // `feedGeneratedAt` is THIS STATION's own generatedAt, not the feed's
      // top-level one — the precise timestamp Phase 3/Crew G's 14-day alert
      // gate needs (see this file's header comment).
      source: { feedGeneratedAt: station.generatedAt, validThrough: station.validThrough },
    });
  }
  // Nearest first, matching the card's own "nearest first" ordering rule (§1) —
  // the aggregator (Crew F) re-sorts across event types anyway, but a caller
  // reading this adapter directly should still see a sane order.
  events.sort((a, b) => Date.parse(a.episode.start) - Date.parse(b.episode.start));
  return events;
}

export type WrappedTideSkyEvents = Wrapped<TideSkyEvent[]>;

/**
 * This beach's king-tide/very-high-tide events for the "Coming up" card
 * (§3). `nowMs` is always the caller's pinned snapshot instant (§9's
 * SSR-safety rule) — never read from `Date.now()` inside this function
 * except as the parameter's own default for a direct/manual call.
 */
export async function fetchKingTide(loc: Location, nowMs: number = Date.now()): Promise<WrappedTideSkyEvents> {
  const fetchedAt = nowIso();
  const mapping = TIDE_STATIONS[loc.slug];
  if (!mapping) {
    return {
      source: ATTRIBUTION,
      status: "best-effort",
      fetchedAt,
      attribution: ATTRIBUTION,
      data: null,
      note: "no king-tide station mapping configured for this beach",
    };
  }

  const loaded = await loadFeed();
  if (!loaded) {
    return {
      source: `NOAA CO-OPS (${mapping.stationId})`,
      status: "best-effort",
      fetchedAt,
      attribution: ATTRIBUTION,
      data: null,
      note: "king-tide feed unavailable",
    };
  }

  const station = loaded.feed.stations.find((s) => s.stationId === mapping.stationId);
  if (!station) {
    return {
      source: `NOAA CO-OPS (${mapping.stationId})`,
      status: "best-effort",
      fetchedAt: loaded.fetchedAt,
      attribution: ATTRIBUTION,
      data: null,
      note: "no king-tide data published yet for this beach's station",
    };
  }

  // Card staleness is gated on THIS STATION's own `generatedAt` (review item
  // 4), not the feed's top-level one — a station carried forward on its own
  // failed fetch keeps its ORIGINAL timestamp even while sibling stations in
  // the same publish just refreshed successfully. A `generatedAt` implausibly
  // far in the FUTURE (negative `stationAgeMs` beyond the skew allowance) is
  // rejected the same way — never treated as "extra fresh" (Codex review
  // round 2).
  const stationAgeMs = nowMs - Date.parse(station.generatedAt);
  if (!Number.isFinite(stationAgeMs) || stationAgeMs > CARD_STALE_MS || stationAgeMs < -CARD_FUTURE_SKEW_MS) {
    return {
      source: `NOAA CO-OPS (${mapping.stationId})`,
      status: "best-effort",
      fetchedAt: loaded.fetchedAt,
      attribution: ATTRIBUTION,
      data: null,
      note: `king-tide data for this station stale or implausibly-timed (generated ${station.generatedAt})`,
    };
  }

  const events = toTideEvents(station, nowMs);
  return {
    source: `NOAA CO-OPS (${mapping.stationId})`,
    status: "ok",
    fetchedAt: loaded.fetchedAt,
    attribution: ATTRIBUTION,
    data: events,
  };
}
