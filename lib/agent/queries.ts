// The three read operations, written once. The REST routes and the MCP tools both
// call these, so the two surfaces answer the same way.

import {
  filterBeaches,
  listBeachSummaries,
  nearestBeaches,
  normalizeState,
  type BeachSummary,
  type NearbyBeach,
} from "@/lib/agent/beaches";
import { compactConditions, loadMany, type CompactConditions } from "@/lib/agent/beachView";
import { FAR_AWAY_MILES } from "@/lib/agent/constants";
import type { Parsed } from "@/lib/agent/params";

export interface ListQuery {
  state?: string;
  region?: string;
}

export function runListBeaches(raw: ListQuery): Parsed<{ count: number; beaches: BeachSummary[] }> {
  let state: string | undefined;
  if (raw.state !== undefined && raw.state.trim() !== "") {
    const s = normalizeState(raw.state);
    if (!s) return { ok: false, message: `Unknown state "${raw.state.slice(0, 40)}". Use a two-letter code like FL or a full name like Florida.` };
    state = s;
  }
  const region = raw.region?.trim() ? raw.region.trim().slice(0, 80) : undefined;
  const beaches = filterBeaches(listBeachSummaries(), { state, region });
  return { ok: true, value: { count: beaches.length, beaches } };
}

export interface NearbyWithConditions extends NearbyBeach {
  conditions?: CompactConditions | null;
}

export interface NearestResult {
  query: { lat: number; lon: number; limit: number };
  count: number;
  /** How many of these beaches had a live score built for this request. */
  scored: number;
  beaches: NearbyWithConditions[];
  note?: string;
  /** Validity of the scores included, for cache headers. */
  views: Array<{ validUntil: string; capturedAt: string }>;
}

export async function runNearest(opts: {
  lat: number;
  lon: number;
  limit: number;
  /** How many of the nearest beaches to build scores for (0 = none). */
  scoreCount: number;
}): Promise<NearestResult> {
  const near = nearestBeaches(opts.lat, opts.lon, opts.limit);
  const toScore = near.slice(0, Math.max(0, opts.scoreCount));
  const outcomes = toScore.length ? await loadMany(toScore.map((b) => b.slug)) : [];
  const bySlug = new Map(outcomes.map((o) => [o.slug, o]));
  const views: NearestResult["views"] = [];
  let scored = 0;
  const beaches = near.map((b): NearbyWithConditions => {
    const o = bySlug.get(b.slug);
    if (!o) return b;
    if (!o.ok) return { ...b, conditions: null };
    scored += 1;
    views.push({ validUntil: o.conditions.validUntil, capturedAt: o.conditions.capturedAt });
    return { ...b, conditions: compactConditions(o.conditions) };
  });
  const notes: string[] = [];
  if (beaches.length && beaches[0].distanceMiles > FAR_AWAY_MILES) {
    notes.push(`The nearest covered beach is ${beaches[0].distanceMiles} miles away. Nothing is close to this point.`);
  }
  if (toScore.length && scored < toScore.length) {
    notes.push("Some scores could not be built right now (conditions: null). Try again shortly.");
  }
  return {
    query: { lat: opts.lat, lon: opts.lon, limit: opts.limit },
    count: beaches.length,
    scored,
    beaches,
    ...(notes.length ? { note: notes.join(" ") } : {}),
    views,
  };
}
