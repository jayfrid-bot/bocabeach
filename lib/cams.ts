import type { CamConfig, CamView, Location } from "@/lib/types";
import { feedLastGood, metaLastGood, pickFeedTimestamp, pickMetaTimestamp } from "@/lib/camSnapshots";
import { fetchSpotWeather } from "@/lib/sources/spotWeather";
import { fetchWithTimeout } from "@/lib/util";
import {
  camCadence,
  camVerdict,
  courierFleet,
  isCourierCadence,
  newestCourierFrame,
  withCourierBreaker,
  type CamStatus,
  type CamVerdict,
  type CourierFleet,
} from "@/lib/camStatus";

// --- Resolving a cam's capture time -----------------------------------------
//
// The provider (video-monitoring.com) drops requests in short bursts. A single
// miss used to cost the cam card its capture time — the card then said "capture
// time unknown", and the freshness logic had nothing to verify the frame
// against. One retry after a brief pause recovers nearly all of those.
//
// This runs inside the conditions snapshot assembly, so both attempts plus the
// pause have to fit in one modest budget: 3.5s + 0.8s + 3.5s = 7.8s worst case.
// The same budget applies to a `snapshotMetaUrl` courier lookup (Deerfield's
// image cams), which is fetched and retried identically to a feed's latest.json.

/** Timeout for a single JSON-fetch attempt (latest.json or a meta endpoint). */
const ATTEMPT_TIMEOUT_MS = 3500;
/** Pause before the one retry — long enough to miss a burst, short enough to pay for. */
const RETRY_DELAY_MS = 800;
/** Hard ceiling across both attempts, so a slow provider can't blow the request. */
const TOTAL_BUDGET_MS = 8000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch one JSON URL with a single retry. Returns the parsed JSON, or
 * undefined when both attempts fail — the caller then reports an honest
 * unknown capture time rather than inventing one.
 */
async function fetchCamJsonWithRetry(url: string): Promise<unknown | undefined> {
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      // Don't start a retry we have no budget to finish.
      if (Date.now() + RETRY_DELAY_MS >= deadline) break;
      await sleep(RETRY_DELAY_MS);
    }
    const timeoutMs = Math.min(ATTEMPT_TIMEOUT_MS, deadline - Date.now());
    if (timeoutMs <= 0) break;
    try {
      const res = await fetchWithTimeout(url, {
        timeoutMs,
        next: { revalidate: 60 },
      });
      if (res.ok) return await res.json();
    } catch {
      // Timed out or refused — fall through to the retry (or give up after it).
    }
  }
  return undefined;
}

/** One feed's latest.json, fetched with a single retry. */
const fetchFeedLatest = (base: string): Promise<unknown | undefined> =>
  fetchCamJsonWithRetry(`${base}/latest.json`);

/** A built cam view plus what the offline rule (lib/camStatus.ts) says about it. */
export interface CamViewWithStatus {
  view: CamView;
  status: CamStatus;
  /** Why it is offline ("none-stored" or "aged"), else null. */
  reason: CamVerdict["reason"];
}

/**
 * Build the cam list for a location, attaching the live weather/wind at each
 * cam's own coordinates (falling back to the town's lat/lon). Fetches run in
 * parallel; cams sharing a rounded coordinate (or a latest.json feed) reuse the
 * same request. Every cam is returned, offline ones included: see
 * {@link buildCamViewsWithStatus} and {@link visibleCamViews}.
 */
export async function buildCamViews(loc: Location): Promise<CamView[]> {
  return (await buildCamViewsWithStatus(loc)).map((c) => c.view);
}

/** The cams the page may show: every cam whose status is not "offline". A beach
 *  whose cams are all offline gets an empty list, so it shows no cam section. */
export function visibleCamViews(cams: readonly CamViewWithStatus[]): CamView[] {
  return cams.filter((c) => c.status !== "offline").map((c) => c.view);
}

/**
 * {@link buildCamViews} plus each cam's status. The status reuses the capture-time
 * lookups the cam card already makes (no extra requests): a feed cam's latest.json,
 * or a courier cam's uw-frame meta.
 */
export async function buildCamViewsWithStatus(
  loc: Location,
  nowMs: number = Date.now(),
): Promise<CamViewWithStatus[]> {
  // Cams that share a latest.json share ONE fetch AND its retry: every view
  // lives inside that same document, so a second request would only repeat it
  // (and would double the retry cost of a provider outage).
  const feeds = new Map<string, Promise<unknown | undefined>>();
  const latestFor = (base: string): Promise<unknown | undefined> => {
    let pending = feeds.get(base);
    if (!pending) {
      pending = fetchFeedLatest(base);
      feeds.set(base, pending);
    }
    return pending;
  };

  // The newest good frame's time, for the offline rule: an ISO string, null when
  // the source answered but holds no good frame, undefined when it could not be
  // asked (lib/camStatus.ts shows a cam it cannot judge).
  type FrameTime = { capturedAt: string | undefined; lastGood: string | null | undefined };
  const UNKNOWN: FrameTime = { capturedAt: undefined, lastGood: undefined };

  /** Exact capture time of a feed cam's current frame. */
  const feedFrameTime = async (cam: CamConfig): Promise<FrameTime> => {
    const feed = cam.snapshotFeed;
    if (!feed) return UNKNOWN;
    const json = await latestFor(feed.base);
    if (json === undefined) return UNKNOWN;
    return { capturedAt: pickFeedTimestamp(json, feed.view), lastGood: feedLastGood(json, feed.view) };
  };

  /** Exact capture time of a courier-grabbed still, via its meta endpoint. */
  const metaFrameTime = async (cam: CamConfig): Promise<FrameTime> => {
    const metaUrl = cam.snapshotMetaUrl;
    if (!metaUrl) return UNKNOWN;
    const json = await fetchCamJsonWithRetry(metaUrl);
    if (json === undefined) return UNKNOWN;
    return { capturedAt: pickMetaTimestamp(json), lastGood: metaLastGood(json) };
  };

  /** Resolve whichever capture-time source this cam config declares. */
  const camFrameTime = (cam: CamConfig): Promise<FrameTime> =>
    cam.snapshotMetaUrl ? metaFrameTime(cam) : cam.snapshotFeed ? feedFrameTime(cam) : Promise.resolve(UNKNOWN);

  const built = await Promise.all(
    loc.cams.map(async (cam) => {
      const [weather, { capturedAt, lastGood }] = await Promise.all([
        fetchSpotWeather(cam.lat ?? loc.lat, cam.lon ?? loc.lon),
        camFrameTime(cam),
      ]);
      const cadence = camCadence(cam, loc.timezone);
      const view: CamView = {
        id: cam.id,
        name: cam.name,
        provider: cam.provider,
        embedType: cam.embedType,
        url: cam.url,
        // Proxy the live still same-origin (https) when this cam has one
        // (a fixed snapshot URL or a resolved latest.json feed).
        imageUrl:
          cam.id && (cam.snapshotUrl || cam.snapshotFeed)
            ? `/api/cam/${cam.id}`
            : undefined,
        // A feed cam also has a full-size original, fetched only when the viewer zooms in.
        originalImageUrl:
          cam.id && cam.snapshotFeed ? `/api/cam/${cam.id}?res=hr` : undefined,
        capturedAt,
        attribution: cam.attribution,
        weather,
      };
      return { view, cadence, verdict: camVerdict(cadence, lastGood, null, nowMs) };
    }),
  );

  // The courier breaker (lib/camStatus.ts): a courier cam that aged out is only
  // hidden when the courier as a whole is up. Asked only when such a cam exists, so
  // a healthy beach makes no extra request; the answer is shared for 10 minutes.
  const agedCourier = built.find((b) => b.verdict.reason === "aged" && isCourierCadence(b.cadence));
  const metaUrl = agedCourier ? loc.cams.find((c) => c.id === agedCourier.view.id)?.snapshotMetaUrl : undefined;
  const fleet: CourierFleet = metaUrl ? await courierFleetFor(metaUrl, nowMs) : { down: false };

  return built.map(({ view, cadence, verdict }) => {
    const v = withCourierBreaker(verdict, isCourierCadence(cadence), fleet);
    return { view, status: v.status, reason: v.reason };
  });
}

// --- The courier fleet state (uw-frame /cams), shared through the Workers Cache ---

/** How long one /cams answer is reused. /cams reads two KV keys per cam, so it is
 *  asked at most once per 10 minutes per data center, and only while a courier cam
 *  has aged out. */
export const FLEET_CACHE_TTL_SEC = 600;
// Bump the version when the stored shape changes, so an old entry is never read as a new one.
const FLEET_KEY_PREFIX = "https://cache.isitbeachday.internal/courierfleet/v2/";

/** A newest-courier-frame value we can trust: null, or an ISO time not in the future
 *  (5 minutes of clock skew allowed). Anything else is undefined (a miss). */
export function validFleetNewest(v: unknown, nowMs: number): string | null | undefined {
  if (v === null) return null;
  if (typeof v !== "string") return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) && t <= nowMs + 5 * 60_000 ? new Date(t).toISOString() : undefined;
}

export interface CacheLike {
  match(key: string): Promise<Response | undefined>;
  put(key: string, res: Response): Promise<void>;
}
function defaultCache(): CacheLike | null {
  try {
    const d = (globalThis as { caches?: { default?: CacheLike } }).caches?.default;
    return d && typeof d.match === "function" && typeof d.put === "function" ? d : null;
  } catch {
    return null;
  }
}

/** The courier fleet's state at `nowMs`. Never throws; an unreadable answer is "unknown".
 *  `cache` is the Workers Cache (injectable for tests; null = none). */
export async function courierFleetFor(
  metaUrl: string,
  nowMs: number,
  cache: CacheLike | null = defaultCache(),
): Promise<CourierFleet> {
  let camsUrl: string;
  try {
    camsUrl = new URL("/cams", metaUrl).href;
  } catch {
    return { down: "unknown" };
  }
  const key = `${FLEET_KEY_PREFIX}${encodeURIComponent(camsUrl)}`;
  let newest: string | null | undefined;
  try {
    const hit = await cache?.match(key);
    // A malformed entry is a miss: it is read again from /cams, never trusted.
    if (hit) newest = validFleetNewest(((await hit.json()) as { newest?: unknown } | null)?.newest, nowMs);
  } catch {
    newest = undefined;
  }
  if (newest === undefined) {
    try {
      const res = await fetchWithTimeout(camsUrl, { timeoutMs: ATTEMPT_TIMEOUT_MS });
      newest = res.ok ? validFleetNewest(newestCourierFrame(await res.json()), nowMs) : undefined;
    } catch {
      newest = undefined;
    }
    if (newest !== undefined) {
      try {
        await cache?.put(
          key,
          new Response(JSON.stringify({ newest }), {
            headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${FLEET_CACHE_TTL_SEC}` },
          }),
        );
      } catch {
        /* a cache write failure only costs the next build one request */
      }
    }
  }
  return courierFleet(newest, nowMs);
}
