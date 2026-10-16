import type { GoesCloudData, GoesIrData, GoesIrEvent, GoesIrEventKind, Location, Wrapped } from "@/lib/types";
import { fetchedAtOf, fetchWithTimeout, nowIso, oldestIso } from "@/lib/util";

const ATTRIBUTION = "NOAA GOES-19 ABI Clear Sky Mask + Cloud Top Height (satellite-observed cloud)";

/**
 * Where the precomputed satellite cloud feed lives. The heavy netCDF/pixel
 * work runs OFF Netlify (a GitHub Action writes a small JSON to the
 * `cloud-data` branch, mirroring lightning-data); we just read that tiny file
 * here. Override with GOES_CLOUD_FEED_URL.
 */
const FEED_URL =
  process.env.GOES_CLOUD_FEED_URL ??
  "https://raw.githubusercontent.com/jayfrid-bot/bocabeach/cloud-data/goes_cloud.json";

/**
 * How stale the satellite GRANULE itself may be (its own scan start time —
 * NOT when the upstream job ran) before we stop trusting it as "right now".
 *
 * The ABI Clear Sky Mask feed genuinely gaps: on 2026-07-15 the newest
 * available granule was measured live at 83 minutes old. A tight threshold
 * (like the ~1-2 min the GLM lightning feed can hold to) would make this
 * source flicker to "stale" constantly and never actually help. 45 minutes
 * absorbs one normal gap in the ~5-min cadence while still refusing a read
 * that's old enough the sky has plausibly changed since (e.g. an anvil that
 * has since moved off the beach) — degrade honestly rather than pretend an
 * hour-old satellite snapshot is current truth.
 */
export const GOES_CLOUD_STALE_MINUTES = 45;

interface GoesCloudFeedBeach {
  cloudPct: number | null;
  // Feed version 3+: the cloud-top-height read. Absent on an older feed. Parsed
  // defensively by parseGoesIr (an odd payload degrades to "no IR", never an error).
  ir?: unknown;
  // Absent on an old-format feed (pre beam-path support) — old cached feeds
  // and the very first deploy after this ships are the reason these are
  // optional rather than required. See lib/types.ts's GoesCloudData for what
  // each field means downstream.
  beamCloudPct?: number | null;
  sunElevDeg?: number | null;
  validPixels: number;
  totalPixels: number;
}

interface GoesCloudFeed {
  // Absent on an old-format feed — never assumed present.
  version?: number;
  generatedAt: string;
  granuleStartIso: string;
  // Version 3+: scan start of the mask + cloud-top-height pair behind the `ir`
  // blocks (null when the height product was unavailable that cycle).
  irGranuleStartIso?: string | null;
  satellite: string;
  beaches: Record<string, GoesCloudFeedBeach>;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const pctOrNull = (v: unknown): number | null => (finite(v) && v >= 0 && v <= 100 ? v : null);

function parseIrEvent(raw: unknown): GoesIrEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.eventIso !== "string" || !Number.isFinite(Date.parse(e.eventIso)) || !finite(e.azDeg)) return null;
  return {
    eventIso: e.eventIso,
    azDeg: e.azDeg,
    beamLowPct: pctOrNull(e.beamLowPct),
    beamMidHighPct: pctOrNull(e.beamMidHighPct),
    antiMidHighPct: pctOrNull(e.antiMidHighPct),
    beamSamples: finite(e.beamSamples) ? e.beamSamples : 0,
  };
}

/**
 * Read one beach's `ir` block (feed version 3+). Returns null — never throws —
 * for a missing/old-format block, a beach with no good pixels (the feed writes
 * no `ir` then), an IR granule time that does not parse, or a layer share that
 * is not a 0-100 number. Layer shares are all-or-nothing: a partial split would
 * let a missing level default to a fabricated clear canvas.
 */
export function parseGoesIr(raw: unknown, irGranuleStartIso: unknown): GoesIrData | null {
  if (!raw || typeof raw !== "object") return null;
  if (typeof irGranuleStartIso !== "string" || !Number.isFinite(Date.parse(irGranuleStartIso))) return null;
  const r = raw as Record<string, unknown>;
  const low = pctOrNull(r.lowPct);
  const mid = pctOrNull(r.midPct);
  const high = pctOrNull(r.highPct);
  const cloud = pctOrNull(r.irCloudPct);
  if (low == null || mid == null || high == null || cloud == null) return null;
  const events: Partial<Record<GoesIrEventKind, GoesIrEvent>> = {};
  const rawEvents = r.events && typeof r.events === "object" ? (r.events as Record<string, unknown>) : {};
  for (const kind of ["sunrise", "sunset"] as const) {
    const ev = parseIrEvent(rawEvents[kind]);
    if (ev) events[kind] = ev;
  }
  return {
    lowPct: low,
    midPct: mid,
    highPct: high,
    irCloudPct: cloud,
    unclassifiedPct: pctOrNull(r.unclassifiedPct),
    classifiedPct: pctOrNull(r.classifiedPct),
    validPixels: finite(r.validPixels) ? r.validPixels : 0,
    totalPixels: finite(r.totalPixels) ? r.totalPixels : 0,
    granuleStartIso: irGranuleStartIso,
    events,
  };
}

export async function fetchGoesCloud(loc: Location): Promise<Wrapped<GoesCloudData>> {
  let fetchedAt = nowIso();
  try {
    const res = await fetchWithTimeout(FEED_URL, {
      timeoutMs: 7000,
      next: { revalidate: 60 }, // the upstream job refreshes on a ~15 min cadence
    });
    fetchedAt = fetchedAtOf(res);
    // The feed branch may not exist yet (first deploy) — degrade quietly.
    if (res.status === 404) {
      return {
        source: ATTRIBUTION,
        status: "best-effort",
        fetchedAt,
        attribution: ATTRIBUTION,
        data: null,
        note: "satellite cloud feed not published yet",
      };
    }
    if (!res.ok) throw new Error(`goes cloud feed -> ${res.status}`);
    const feed = (await res.json()) as GoesCloudFeed;
    if (!feed?.beaches || typeof feed.beaches !== "object") {
      throw new Error("malformed goes cloud feed");
    }

    // The GitHub CDN's Date header is serve-time, not generation-time — report
    // the older of the two so RelativeTime matches reality (same as lightning.ts).
    fetchedAt = oldestIso(feed.generatedAt, fetchedAtOf(res));

    const granuleAgeMinutes = feed.granuleStartIso
      ? Math.max(0, Math.round((Date.now() - Date.parse(feed.granuleStartIso)) / 60000))
      : Infinity;
    const stale = !Number.isFinite(granuleAgeMinutes) || granuleAgeMinutes > GOES_CLOUD_STALE_MINUTES;

    const b = feed.beaches[loc.slug];
    // No reading for this beach (out of the CONUS grid, or too few
    // good-quality pixels in its neighborhood this pass) — never fabricate.
    // The IR block has its own, larger box: when the mask box is empty but the
    // IR block is good, keep the data (mask fields null) so the sun-color model
    // still sees the IR read.
    const ir = b ? parseGoesIr(b.ir, feed.irGranuleStartIso) : null;
    if (!b || (b.cloudPct == null && !ir)) {
      return {
        source: ATTRIBUTION,
        status: stale ? "stale" : "best-effort",
        fetchedAt,
        attribution: ATTRIBUTION,
        data: null,
        note: !b ? "beach not in satellite feed" : "insufficient valid satellite pixels for this beach",
      };
    }

    const data: GoesCloudData = {
      cloudPct: b.cloudPct ?? null,
      // b.beamCloudPct is absent (not just null) on an old-format feed —
      // `?? null` normalizes both "old feed" and "computed, no signal" to
      // the same null, which satelliteBeamCloudPct treats identically
      // (fall through to the next input in the preference order).
      beamCloudPct: b.beamCloudPct ?? null,
      sunElevDeg: b.sunElevDeg ?? null,
      validPixels: b.validPixels,
      totalPixels: b.totalPixels,
      granuleAgeMinutes,
      granuleStartIso: feed.granuleStartIso,
      // Absent on a pre-v3 feed; `?? null` keeps "old feed" and "no IR this
      // cycle" the same to every consumer (the forecast is the fallback).
      ir,
    };
    return {
      source: ATTRIBUTION,
      status: stale ? "stale" : "ok",
      fetchedAt,
      attribution: ATTRIBUTION,
      data,
      // Data still returned even when stale — callers decide whether to use
      // it (deriveMetrics only trusts status "ok"), but it's still worth
      // surfacing in the UI/source list as a best-effort/stale reading.
      note: stale ? `satellite granule is ${granuleAgeMinutes} min old` : undefined,
    };
  } catch (e) {
    return {
      source: ATTRIBUTION,
      status: "error",
      fetchedAt,
      attribution: ATTRIBUTION,
      data: null,
      note: String(e),
    };
  }
}
