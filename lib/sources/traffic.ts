import type { Location, TrafficData, Wrapped } from "@/lib/types";
import { fetchedAtOf, clamp, fetchWithTimeout, nowIso, round } from "@/lib/util";

const ATTRIBUTION = "HERE Traffic";
const DEFAULT_RADIUS_KM = 2;
// Traffic shifts fast; 5 min matches the conditions route ISR + dashboard SWR,
// so we make at most ~1 HERE call per beach per 5 min (free-tier friendly).
const REVALIDATE = 300;
const BASE = "https://data.traffic.hereapi.com/v7/flow";

interface CurrentFlow {
  jamFactor?: number; // 0 (free-flowing) … 10 (standstill); -1/absent = unknown
  confidence?: number; // 0..1
  speed?: number;
  freeFlow?: number;
}
export interface HereFlowResponse {
  results?: Array<{ currentFlow?: CurrentFlow }>;
}

function levelFor(jam: number): TrafficData["level"] {
  if (jam < 2) return "light";
  if (jam < 4) return "moderate";
  if (jam < 7) return "heavy";
  return "severe";
}

/**
 * Aggregate HERE flow segments into one area-congestion reading. Uses a
 * confidence-weighted mean of jamFactor (plain mean when confidence is absent),
 * dropping unknown (-1/missing) segments. Pure + unit-tested.
 */
export function summarizeTraffic(json: HereFlowResponse): TrafficData {
  const flows = (json?.results ?? [])
    .map((r) => r?.currentFlow)
    .filter(
      (f): f is CurrentFlow =>
        !!f && typeof f.jamFactor === "number" && Number.isFinite(f.jamFactor) && f.jamFactor >= 0,
    );
  if (!flows.length) return { level: "unknown", congestion: undefined, segments: 0 };

  let confSum = 0;
  let weighted = 0;
  for (const f of flows) {
    const c = typeof f.confidence === "number" && f.confidence > 0 ? f.confidence : 0;
    confSum += c;
    weighted += (f.jamFactor as number) * c;
  }
  const mean =
    confSum > 0
      ? weighted / confSum
      : flows.reduce((a, f) => a + (f.jamFactor as number), 0) / flows.length;

  return { level: levelFor(mean), congestion: clamp(round(mean * 10), 0, 100), segments: flows.length };
}

export async function fetchTraffic(loc: Location): Promise<Wrapped<TrafficData>> {
  let fetchedAt = nowIso();
  const key = process.env.HERE_API_KEY;
  if (!key) {
    return {
      source: ATTRIBUTION,
      status: "best-effort",
      fetchedAt,
      attribution: ATTRIBUTION,
      data: null,
      note: "HERE_API_KEY not configured",
    };
  }
  const radiusM = Math.round((loc.trafficRadiusKm ?? DEFAULT_RADIUS_KM) * 1000);
  const url =
    `${BASE}?in=circle:${loc.lat},${loc.lon};r=${radiusM}` +
    `&locationReferencing=shape&apiKey=${encodeURIComponent(key)}`;
  try {
    const res = await fetchWithTimeout(url, { timeoutMs: 7000, next: { revalidate: REVALIDATE } });
    fetchedAt = fetchedAtOf(res);
    // A rejected/over-quota key should degrade quietly, not read as a hard error.
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      return {
        source: ATTRIBUTION,
        status: "best-effort",
        fetchedAt,
        attribution: ATTRIBUTION,
        data: null,
        note: `HERE key rejected or throttled (${res.status})`,
      };
    }
    if (!res.ok) throw new Error(`HERE flow -> ${res.status}`);
    const data = summarizeTraffic((await res.json()) as HereFlowResponse);
    return {
      source: ATTRIBUTION,
      status: data.level === "unknown" ? "best-effort" : "ok",
      fetchedAt,
      attribution: ATTRIBUTION,
      data,
      note: data.level === "unknown" ? "no road segments in range" : undefined,
    };
  } catch (e) {
    // Never surface the request URL (it carries the API key) in the note.
    return {
      source: ATTRIBUTION,
      status: "error",
      fetchedAt,
      attribution: ATTRIBUTION,
      data: null,
      note: e instanceof Error ? e.message : String(e),
    };
  }
}
